use std::collections::{BTreeMap, BTreeSet};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result, bail};
use gix::bstr::ByteSlice;
use gix::object::tree::EntryMode;

use crate::cli::CliOptions;
use crate::diff::{FileDiffInput, FileSnapshot, render_patch};
use crate::vcs::{ReviewInput, build_review_input};

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileEntry {
    mode: String,
    hash: String,
    contents: Vec<u8>,
}

pub fn load_review_input(
    options: &CliOptions,
    root: &Path,
    paths: &[String],
) -> Result<ReviewInput> {
    let repo = gix::open(root).with_context(|| format!("open git repo {}", root.display()))?;
    match (
        &options.from_rev,
        &options.to_rev,
        options.revisions.as_slice(),
    ) {
        (None, None, []) => working_tree_review(&repo, root, paths),
        (None, None, [revision]) => commit_review(&repo, revision, paths),
        (None, None, revisions) => {
            bail!("git mode supports one -r revision, got {}", revisions.len())
        }
        (from_rev, to_rev, []) => range_review(
            &repo,
            from_rev.as_deref().unwrap_or("HEAD"),
            to_rev.as_deref().unwrap_or("HEAD"),
            paths,
        ),
        _ => unreachable!("CLI rejects combining revisions with from/to"),
    }
}

fn working_tree_review(
    repo: &gix::Repository,
    root: &Path,
    paths: &[String],
) -> Result<ReviewInput> {
    let head = repo.head_commit().context("resolve HEAD")?;
    let old_tree = head.tree().context("read HEAD tree")?;
    let old_entries = collect_tree_entries(&old_tree, paths)?;
    let new_entries = collect_worktree_entries(root, paths)?;
    let files = compare_entries(&old_entries, &new_entries, paths);
    let patch = render_patch(&files)?;
    Ok(build_review_input(patch, files))
}

fn commit_review(repo: &gix::Repository, revision: &str, paths: &[String]) -> Result<ReviewInput> {
    let commit = resolve_commit(repo, revision)?;
    let parents = parent_ids(&commit);
    if parents.len() > 1 {
        bail!(
            "git merge commits are not supported for review: {}",
            commit.id()
        );
    }
    let old_entries = if let Some(parent_id) = parents.first() {
        let parent = parent_id.object()?.try_into_commit()?;
        collect_tree_entries(&parent.tree()?, paths)?
    } else {
        BTreeMap::new()
    };
    let new_entries = collect_tree_entries(&commit.tree()?, paths)?;
    let files = compare_entries(&old_entries, &new_entries, paths);
    let patch = render_patch(&files)?;
    Ok(build_review_input(patch, files))
}

fn range_review(
    repo: &gix::Repository,
    from_rev: &str,
    to_rev: &str,
    paths: &[String],
) -> Result<ReviewInput> {
    let from = resolve_commit(repo, from_rev)?;
    let to = resolve_commit(repo, to_rev)?;
    let old_entries = collect_tree_entries(&from.tree()?, paths)?;
    let new_entries = collect_tree_entries(&to.tree()?, paths)?;
    let files = compare_entries(&old_entries, &new_entries, paths);
    let patch = render_patch(&files)?;
    Ok(build_review_input(patch, files))
}

fn collect_tree_entries(
    tree: &gix::Tree<'_>,
    paths: &[String],
) -> Result<BTreeMap<String, FileEntry>> {
    let mut entries = BTreeMap::new();
    collect_tree_entries_at(tree, "", paths, &mut entries)?;
    Ok(entries)
}

fn collect_tree_entries_at(
    tree: &gix::Tree<'_>,
    prefix: &str,
    paths: &[String],
    entries: &mut BTreeMap<String, FileEntry>,
) -> Result<()> {
    for entry in tree.iter() {
        let entry = entry.context("read tree entry")?;
        let name = entry.filename().to_str_lossy();
        let path = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        if entry.mode().is_tree() {
            if path_may_match_dir(&path, paths) {
                collect_tree_entries_at(&entry.object()?.try_into_tree()?, &path, paths, entries)?;
            }
            continue;
        }
        if !path_allowed(&path, paths) {
            continue;
        }
        let contents = if entry.mode().is_commit() {
            entry.object_id().to_string().into_bytes()
        } else {
            entry.object()?.try_into_blob()?.data.clone()
        };
        entries.insert(
            path,
            FileEntry {
                mode: mode_string(entry.mode()),
                hash: entry.object_id().to_string(),
                contents,
            },
        );
    }
    Ok(())
}

fn collect_worktree_entries(root: &Path, paths: &[String]) -> Result<BTreeMap<String, FileEntry>> {
    let mut entries = BTreeMap::new();
    collect_worktree_entries_at(root, root, "", paths, &mut entries)?;
    Ok(entries)
}

fn collect_worktree_entries_at(
    root: &Path,
    dir: &Path,
    prefix: &str,
    paths: &[String],
    entries: &mut BTreeMap<String, FileEntry>,
) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name == ".git" || file_name == ".jj" {
            continue;
        }
        let rel = if prefix.is_empty() {
            file_name
        } else {
            format!("{prefix}/{}", entry.file_name().to_string_lossy())
        };
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            if path_may_match_dir(&rel, paths) {
                collect_worktree_entries_at(root, &path, &rel, paths, entries)?;
            }
            continue;
        }
        if !path_allowed(&rel, paths) {
            continue;
        }
        let (mode, contents) = if metadata.file_type().is_symlink() {
            (
                "120000".to_string(),
                fs::read_link(&path)?
                    .to_string_lossy()
                    .to_string()
                    .into_bytes(),
            )
        } else if metadata.is_file() {
            (worktree_file_mode(&metadata), fs::read(&path)?)
        } else {
            continue;
        };
        let hash = pseudo_blob_hash(&contents);
        entries.insert(
            rel,
            FileEntry {
                mode,
                hash,
                contents,
            },
        );
    }
    let _ = root;
    Ok(())
}

fn compare_entries(
    old_entries: &BTreeMap<String, FileEntry>,
    new_entries: &BTreeMap<String, FileEntry>,
    paths: &[String],
) -> Vec<FileDiffInput> {
    let keys = old_entries
        .keys()
        .chain(new_entries.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut files = Vec::new();
    for path in keys {
        if !path_allowed(&path, paths) {
            continue;
        }
        let old = old_entries.get(&path);
        let new = new_entries.get(&path);
        if old == new {
            continue;
        }
        files.push(FileDiffInput {
            old_path: path.clone(),
            new_path: path,
            old: old.cloned().map(file_snapshot),
            new: new.cloned().map(file_snapshot),
        });
    }
    files
}

fn file_snapshot(entry: FileEntry) -> FileSnapshot {
    FileSnapshot {
        mode: entry.mode,
        hash: entry.hash,
        contents: entry.contents,
    }
}

fn resolve_commit<'repo>(
    repo: &'repo gix::Repository,
    revision: &str,
) -> Result<gix::Commit<'repo>> {
    Ok(repo
        .rev_parse_single(revision.as_bytes().as_bstr())?
        .object()?
        .peel_to_commit()?)
}

fn parent_ids<'repo>(commit: &gix::Commit<'repo>) -> Vec<gix::Id<'repo>> {
    commit.parent_ids().collect()
}

fn mode_string(mode: EntryMode) -> String {
    format!("{:06o}", mode.value())
}

fn path_allowed(path: &str, paths: &[String]) -> bool {
    paths.is_empty()
        || paths
            .iter()
            .any(|filter| path == filter || path.starts_with(&format!("{filter}/")))
}

fn path_may_match_dir(path: &str, paths: &[String]) -> bool {
    paths.is_empty()
        || paths.iter().any(|filter| {
            filter == path
                || filter.starts_with(&format!("{path}/"))
                || path.starts_with(&format!("{filter}/"))
        })
}

fn pseudo_blob_hash(contents: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in contents {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:040x}")
}

#[cfg(unix)]
fn worktree_file_mode(metadata: &fs::Metadata) -> String {
    if metadata.permissions().mode() & 0o111 != 0 {
        "100755".to_string()
    } else {
        "100644".to_string()
    }
}

#[cfg(not(unix))]
fn worktree_file_mode(_metadata: &fs::Metadata) -> String {
    "100644".to_string()
}

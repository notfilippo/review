use std::collections::{BTreeMap, BTreeSet};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result, bail};
use gix::bstr::{BString, ByteSlice};
use gix::dir::entry::Kind;
use gix::dir::walk::EmissionMode;
use gix::object::tree::EntryMode;
use gix::remote::Direction;

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
        (None, None, []) => default_worktree_review(&repo, root, paths),
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

fn default_worktree_review(
    repo: &gix::Repository,
    root: &Path,
    paths: &[String],
) -> Result<ReviewInput> {
    let head = repo.head().context("resolve HEAD")?;
    let (old_entries, head_entries) = if head.is_unborn() {
        (BTreeMap::new(), BTreeMap::new())
    } else {
        let head = repo.head_commit().context("resolve HEAD commit")?;
        let head_entries = collect_tree_entries(&head.tree().context("read HEAD tree")?, paths)?;
        let old_entries = if let Some(base) = resolve_default_base_commit(repo)? {
            collect_tree_entries(&base.tree().context("read default branch tree")?, paths)?
        } else {
            BTreeMap::new()
        };
        (old_entries, head_entries)
    };
    let new_entries = collect_worktree_entries(repo, root, head_entries, paths)?;
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

fn collect_worktree_entries(
    repo: &gix::Repository,
    root: &Path,
    mut entries: BTreeMap<String, FileEntry>,
    paths: &[String],
) -> Result<BTreeMap<String, FileEntry>> {
    prune_missing_worktree_entries(root, &mut entries)?;
    overlay_visible_worktree_entries(repo, root, paths, &mut entries)?;
    Ok(entries)
}

fn prune_missing_worktree_entries(
    root: &Path,
    entries: &mut BTreeMap<String, FileEntry>,
) -> Result<()> {
    let mut removed = Vec::new();
    for path in entries.keys() {
        if !worktree_path_is_file(root, path)? {
            removed.push(path.clone());
        }
    }
    for path in removed {
        entries.remove(&path);
    }
    Ok(())
}

fn overlay_visible_worktree_entries(
    repo: &gix::Repository,
    root: &Path,
    paths: &[String],
    entries: &mut BTreeMap<String, FileEntry>,
) -> Result<()> {
    let index = repo.index_or_empty()?;
    let patterns = paths
        .iter()
        .map(|path| BString::from(path.as_str()))
        .collect::<Vec<_>>();
    let options = repo
        .dirwalk_options()?
        .emit_tracked(true)
        .emit_ignored(None)
        .emit_untracked(EmissionMode::Matching);
    let mut iter = repo.dirwalk_iter(index, patterns, Default::default(), options)?;
    for item in &mut iter {
        let item = item?;
        let path = item.entry.rela_path.to_str_lossy().to_string();
        if !path_allowed(&path, paths) || item.entry.disk_kind == Some(Kind::Directory) {
            continue;
        }
        if let Some(entry) = read_worktree_file_entry(root, &path)? {
            entries.insert(path, entry);
        } else {
            entries.remove(&path);
        }
    }
    Ok(())
}

fn worktree_path_is_file(root: &Path, path: &str) -> Result<bool> {
    let full_path = root.join(path);
    let metadata = match fs::symlink_metadata(&full_path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => {
            return Err(err).with_context(|| format!("read metadata for {}", full_path.display()));
        }
    };
    Ok(metadata.file_type().is_symlink() || metadata.is_file())
}

fn read_worktree_file_entry(root: &Path, path: &str) -> Result<Option<FileEntry>> {
    let full_path = root.join(path);
    let metadata = match fs::symlink_metadata(&full_path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(err).with_context(|| format!("read metadata for {}", full_path.display()));
        }
    };
    let (mode, contents) = if metadata.file_type().is_symlink() {
        (
            "120000".to_string(),
            fs::read_link(&full_path)?
                .to_string_lossy()
                .to_string()
                .into_bytes(),
        )
    } else if metadata.is_file() {
        (worktree_file_mode(&metadata), fs::read(&full_path)?)
    } else {
        return Ok(None);
    };
    let hash = pseudo_blob_hash(&contents);
    Ok(Some(FileEntry {
        mode,
        hash,
        contents,
    }))
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

fn resolve_default_base_commit<'repo>(
    repo: &'repo gix::Repository,
) -> Result<Option<gix::Commit<'repo>>> {
    let Some(remote_name) = default_remote_name(repo)? else {
        return Ok(None);
    };
    let remote_head = format!("refs/remotes/{remote_name}/HEAD");
    let mut reference = repo
        .find_reference(remote_head.as_str())
        .with_context(|| format!("resolve default branch from {remote_head}"))?;
    Ok(Some(reference.peel_to_commit().with_context(|| {
        format!("peel default branch {remote_head} to commit")
    })?))
}

fn default_remote_name(repo: &gix::Repository) -> Result<Option<String>> {
    if let Some(head) = repo.head_ref()?
        && let Some(remote_name) = head
            .remote_name(Direction::Fetch)
            .and_then(|name| name.as_symbol().map(ToOwned::to_owned))
            .filter(|name| name != ".")
    {
        return Ok(Some(remote_name));
    }

    if let Some(remote_name) = repo.remote_default_name(Direction::Fetch) {
        return Ok(Some(remote_name.as_ref().to_str_lossy().to_string()));
    }

    Ok(None)
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

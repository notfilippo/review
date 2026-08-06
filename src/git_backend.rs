use std::collections::{BTreeMap, BTreeSet};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result, bail};
use gix::bstr::{BString, ByteSlice};
use gix::index::entry::{Flags as IndexFlags, Mode as IndexMode, Stage};
use gix::object::tree::EntryMode;
use gix::remote::Direction;
use gix::status::UntrackedFiles;

use crate::cli::CliOptions;
use crate::diff::{FileDiffInput, FileSnapshot, render_patch};
use crate::vcs::{ReviewInput, build_review_input};

#[derive(Clone, Debug)]
struct FileEntry {
    mode: String,
    source: FileSource,
}

#[derive(Clone, Debug)]
enum FileSource {
    Object(gix::ObjectId),
    Inline {
        id: gix::ObjectId,
        contents: Vec<u8>,
    },
}

impl FileEntry {
    fn id(&self) -> gix::ObjectId {
        match &self.source {
            FileSource::Object(id) | FileSource::Inline { id, .. } => *id,
        }
    }
}

impl PartialEq for FileEntry {
    fn eq(&self, other: &Self) -> bool {
        self.mode == other.mode && self.id() == other.id()
    }
}

impl Eq for FileEntry {}

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
        (Some(from_rev), None, []) => worktree_review(&repo, root, from_rev, paths),
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

fn worktree_review(
    repo: &gix::Repository,
    root: &Path,
    from_rev: &str,
    paths: &[String],
) -> Result<ReviewInput> {
    let from = resolve_commit(repo, from_rev)?;
    let old_entries = collect_tree_entries(&from.tree()?, paths)?;
    let head = repo.head().context("resolve HEAD")?;
    let head_entries = if head.is_unborn() {
        BTreeMap::new()
    } else {
        let head = repo.head_commit().context("resolve HEAD commit")?;
        collect_tree_entries(&head.tree().context("read HEAD tree")?, paths)?
    };
    let new_entries = collect_worktree_entries(repo, root, head_entries, paths)?;
    let files = compare_entries(repo, &old_entries, &new_entries, paths)?;
    let patch = render_patch(&files)?;
    Ok(build_review_input(patch, files))
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
            let merge_base = repo
                .merge_base(head.id(), base.id())
                .context("resolve merge base with default branch")?;
            let merge_base = repo
                .find_commit(merge_base)
                .context("read merge-base commit")?;
            collect_tree_entries(&merge_base.tree().context("read merge-base tree")?, paths)?
        } else {
            BTreeMap::new()
        };
        (old_entries, head_entries)
    };
    let new_entries = collect_worktree_entries(repo, root, head_entries, paths)?;
    let files = compare_entries(repo, &old_entries, &new_entries, paths)?;
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
    let files = compare_entries(repo, &old_entries, &new_entries, paths)?;
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
    let files = compare_entries(repo, &old_entries, &new_entries, paths)?;
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
        entries.insert(
            path,
            FileEntry {
                mode: mode_string(entry.mode()),
                source: FileSource::Object(entry.object_id()),
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
    let index = repo.index_or_empty()?;
    overlay_index_entries(&index, paths, &mut entries);
    let executable_bit = repo.filesystem_options()?.executable_bit;
    let patterns = paths
        .iter()
        .map(|path| BString::from(path.as_str()))
        .collect::<Vec<_>>();
    let mut iter = repo
        .status(gix::progress::Discard)?
        .untracked_files(UntrackedFiles::Files)
        .index_worktree_submodules(None)
        .index_worktree_rewrites(None)
        .into_index_worktree_iter(patterns)?;
    for item in &mut iter {
        let item = item?;
        if item.summary().is_none() {
            continue;
        }
        let relative_path = item.rela_path();
        let path = relative_path.to_str_lossy().to_string();
        if !path_allowed(&path, paths) {
            continue;
        }
        let index_entry = index.entry_by_path(relative_path);
        if let Some(entry) =
            read_worktree_file_entry(repo, root, &path, index_entry, executable_bit)?
        {
            entries.insert(path, entry);
        } else if let Some(index_entry) = index_entry.filter(|entry| {
            entry.flags.contains(IndexFlags::SKIP_WORKTREE) || entry.mode.is_submodule()
        }) {
            entries.insert(path, file_entry_from_index(index_entry));
        } else {
            entries.remove(&path);
        }
    }
    Ok(entries)
}

fn overlay_index_entries(
    index: &gix::index::State,
    paths: &[String],
    entries: &mut BTreeMap<String, FileEntry>,
) {
    let mut tracked_paths = BTreeSet::new();
    let mut sparse_dirs = Vec::new();
    for entry in index.entries() {
        if !matches!(entry.stage(), Stage::Unconflicted | Stage::Ours) {
            continue;
        }
        let path = entry.path(index).to_str_lossy().to_string();
        if entry.mode.is_sparse() {
            if path_may_match_dir(&path, paths) {
                sparse_dirs.push(path);
            }
            continue;
        }
        if !path_allowed(&path, paths) {
            continue;
        }
        tracked_paths.insert(path.clone());
        entries.insert(path, file_entry_from_index(entry));
    }
    entries.retain(|path, _| {
        tracked_paths.contains(path)
            || sparse_dirs
                .iter()
                .any(|dir| path == dir || path.starts_with(&format!("{dir}/")))
    });
}

fn file_entry_from_index(entry: &gix::index::Entry) -> FileEntry {
    FileEntry {
        mode: index_mode_string(entry.mode),
        source: FileSource::Object(entry.id),
    }
}

fn read_worktree_file_entry(
    repo: &gix::Repository,
    root: &Path,
    path: &str,
    index_entry: Option<&gix::index::Entry>,
    executable_bit: bool,
) -> Result<Option<FileEntry>> {
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
        (
            worktree_file_mode(
                &metadata,
                index_entry.map(|entry| entry.mode),
                executable_bit,
            ),
            fs::read(&full_path)?,
        )
    } else {
        return Ok(None);
    };
    let id = gix::objs::compute_hash(repo.object_hash(), gix::objs::Kind::Blob, &contents)?;
    Ok(Some(FileEntry {
        mode,
        source: FileSource::Inline { id, contents },
    }))
}

fn compare_entries(
    repo: &gix::Repository,
    old_entries: &BTreeMap<String, FileEntry>,
    new_entries: &BTreeMap<String, FileEntry>,
    paths: &[String],
) -> Result<Vec<FileDiffInput>> {
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
            old: old.map(|entry| file_snapshot(repo, entry)).transpose()?,
            new: new.map(|entry| file_snapshot(repo, entry)).transpose()?,
        });
    }
    Ok(files)
}

fn file_snapshot(repo: &gix::Repository, entry: &FileEntry) -> Result<FileSnapshot> {
    let id = entry.id();
    let contents = match &entry.source {
        FileSource::Inline { contents, .. } => contents.clone(),
        FileSource::Object(_) if entry.mode == "160000" => id.to_string().into_bytes(),
        FileSource::Object(_) => repo.find_object(id)?.try_into_blob()?.data.clone(),
    };
    Ok(FileSnapshot {
        mode: entry.mode.clone(),
        hash: id.to_string(),
        contents,
    })
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

fn index_mode_string(mode: IndexMode) -> String {
    format!("{:06o}", mode.bits())
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

#[cfg(unix)]
fn worktree_file_mode(
    metadata: &fs::Metadata,
    index_mode: Option<IndexMode>,
    executable_bit: bool,
) -> String {
    if !executable_bit {
        return index_mode
            .filter(|mode| matches!(*mode, IndexMode::FILE | IndexMode::FILE_EXECUTABLE))
            .map(index_mode_string)
            .unwrap_or_else(|| "100644".to_string());
    }
    if metadata.permissions().mode() & 0o111 != 0 {
        "100755".to_string()
    } else {
        "100644".to_string()
    }
}

#[cfg(not(unix))]
fn worktree_file_mode(
    _metadata: &fs::Metadata,
    index_mode: Option<IndexMode>,
    _executable_bit: bool,
) -> String {
    index_mode
        .filter(|mode| matches!(*mode, IndexMode::FILE | IndexMode::FILE_EXECUTABLE))
        .map(index_mode_string)
        .unwrap_or_else(|| "100644".to_string())
}

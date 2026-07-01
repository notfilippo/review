use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use futures_util::io::AsyncReadExt;
use jj_lib::backend::{CommitId, TreeValue};
use jj_lib::commit::Commit;
use jj_lib::config::StackedConfig;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::merged_tree::MergedTree;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::{ReadonlyRepo, Repo, StoreFactories};
use jj_lib::repo_path::RepoPath;
use jj_lib::rewrite::merge_commit_trees;
use jj_lib::settings::UserSettings;
use jj_lib::workspace::{Workspace, default_working_copy_factories};

use crate::cli::CliOptions;
use crate::diff::{FileDiffInput, FileSnapshot, render_patch};
use crate::vcs::{ReviewInput, build_review_input};

const DEFAULT_REVIEW_REVSET: &str = "trunk()..@";

pub async fn load_review_input(
    options: &CliOptions,
    root: &Path,
    paths: &[String],
) -> Result<ReviewInput> {
    let settings = UserSettings::from_config(StackedConfig::with_defaults())?;
    let workspace = Workspace::load(
        &settings,
        root,
        &StoreFactories::default(),
        &default_working_copy_factories(),
    )
    .with_context(|| format!("load jj workspace {}", root.display()))?;
    let repo = workspace.repo_loader().load_at_head().await?;

    match (
        &options.from_rev,
        &options.to_rev,
        options.revisions.as_slice(),
    ) {
        (None, None, []) => {
            revset_change(&repo, root, &options.cwd, DEFAULT_REVIEW_REVSET, paths).await
        }
        (None, None, revisions) => {
            let expression = combine_revsets(revisions);
            revset_change(&repo, root, &options.cwd, &expression, paths).await
        }
        (from_rev, to_rev, []) => {
            let from = resolve_single(
                &repo,
                root,
                &options.cwd,
                from_rev.as_deref().unwrap_or("@-"),
            )
            .await?;
            let to =
                resolve_single(&repo, root, &options.cwd, to_rev.as_deref().unwrap_or("@")).await?;
            change_between(&from.tree(), &to.tree(), paths).await
        }
        _ => unreachable!("CLI rejects combining revisions with from/to"),
    }
}

fn resolve_revset_with_jj(root: &Path, cwd: &Path, expression: &str) -> Result<Vec<CommitId>> {
    let output = Command::new("jj")
        .arg("--no-pager")
        .arg("--color=never")
        .arg("--quiet")
        .arg("--no-integrate-operation")
        .arg("-R")
        .arg(root)
        .arg("log")
        .arg("--no-graph")
        .arg("-r")
        .arg(expression)
        .arg("-T")
        .arg("commit_id ++ \"\\n\"")
        .current_dir(cwd)
        .output()
        .with_context(|| format!("resolve jj revset {expression:?} in {}", cwd.display()))?;
    if !output.status.success() {
        return Err(jj_command_error(
            "jj log",
            output.status,
            &output.stdout,
            &output.stderr,
        ));
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            CommitId::try_from_hex(line)
                .with_context(|| format!("jj log returned invalid commit id {line:?}"))
        })
        .collect()
}

fn jj_command_error(
    command: &str,
    status: std::process::ExitStatus,
    stdout: &[u8],
    stderr: &[u8],
) -> anyhow::Error {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    let details = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if details.is_empty() {
        return anyhow::anyhow!("{command} failed with {status}");
    }
    anyhow::anyhow!("{command} failed with {status}:\n{details}")
}

async fn revset_change(
    repo: &Arc<ReadonlyRepo>,
    root: &Path,
    cwd: &Path,
    expression: &str,
    paths: &[String],
) -> Result<ReviewInput> {
    let commits = resolve_revset(repo, root, cwd, expression).await?;
    let target = revset_diff_target(repo, commits, expression).await?;
    change_between(&target.from, &target.to, paths).await
}

async fn change_between(
    from: &MergedTree,
    to: &MergedTree,
    paths: &[String],
) -> Result<ReviewInput> {
    let files = diff_trees(from, to, paths).await?;
    let patch = render_patch(&files)?;
    Ok(build_review_input(patch, files))
}

async fn diff_trees(
    old_tree: &MergedTree,
    new_tree: &MergedTree,
    paths: &[String],
) -> Result<Vec<FileDiffInput>> {
    let matcher = EverythingMatcher;
    let mut stream = old_tree.diff_stream(new_tree, &matcher);
    let mut files = Vec::new();
    while let Some(entry) = stream.next().await {
        let values = entry.values?;
        let path = entry.path;
        let path_string = path.as_internal_file_string().to_string();
        if !path_allowed(&path_string, paths) {
            continue;
        }
        let old_value = values
            .before
            .into_resolved()
            .map_err(|_| anyhow::anyhow!("unresolved conflict in {path_string}"))?;
        let new_value = values
            .after
            .into_resolved()
            .map_err(|_| anyhow::anyhow!("unresolved conflict in {path_string}"))?;
        files.push(FileDiffInput {
            old_path: path_string.clone(),
            new_path: path_string,
            old: materialize_tree_value(old_tree, &path, old_value).await?,
            new: materialize_tree_value(new_tree, &path, new_value).await?,
        });
    }
    Ok(files)
}

async fn materialize_tree_value(
    tree: &MergedTree,
    path: &RepoPath,
    value: Option<TreeValue>,
) -> Result<Option<FileSnapshot>> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        TreeValue::File { id, executable, .. } => {
            let mut reader = tree.store().read_file(path, &id).await?;
            let mut contents = Vec::new();
            reader.read_to_end(&mut contents).await?;
            Ok(Some(FileSnapshot {
                mode: if executable { "100755" } else { "100644" }.to_string(),
                hash: id.hex(),
                contents,
            }))
        }
        TreeValue::Symlink(id) => {
            let target = tree.store().read_symlink(path, &id).await?;
            Ok(Some(FileSnapshot {
                mode: "120000".to_string(),
                hash: id.hex(),
                contents: target.into_bytes(),
            }))
        }
        TreeValue::GitSubmodule(id) => Ok(Some(FileSnapshot {
            mode: "160000".to_string(),
            hash: id.hex(),
            contents: id.hex().into_bytes(),
        })),
        TreeValue::Tree(id) => Ok(Some(FileSnapshot {
            mode: "040000".to_string(),
            hash: id.hex(),
            contents: Vec::new(),
        })),
    }
}

struct RevsetDiffTarget {
    from: MergedTree,
    to: MergedTree,
}

async fn revset_diff_target(
    repo: &Arc<ReadonlyRepo>,
    commits: Vec<Commit>,
    expression: &str,
) -> Result<RevsetDiffTarget> {
    if commits.is_empty() {
        bail!("revset {expression:?} resolved to no commits");
    }

    let commit_by_id = commits
        .iter()
        .map(|commit| (commit.id().hex(), commit.clone()))
        .collect::<HashMap<_, _>>();
    let commit_ids = commit_by_id.keys().cloned().collect::<HashSet<_>>();
    let mut parent_ids_in_set = HashSet::new();
    for commit in &commits {
        for parent_id in commit.parent_ids() {
            let parent_id = parent_id.hex();
            if commit_ids.contains(&parent_id) {
                parent_ids_in_set.insert(parent_id);
            }
        }
    }

    let roots = commits
        .iter()
        .filter(|commit| {
            commit
                .parent_ids()
                .iter()
                .all(|parent_id| !commit_ids.contains(&parent_id.hex()))
        })
        .cloned()
        .collect::<Vec<_>>();
    let heads = commits
        .iter()
        .filter(|commit| !parent_ids_in_set.contains(&commit.id().hex()))
        .cloned()
        .collect::<Vec<_>>();
    if roots.is_empty() || heads.is_empty() {
        bail!("revset {expression:?} could not be reduced to roots and heads");
    }

    let mut base_commits = Vec::new();
    let mut base_ids = HashSet::new();
    for root in &roots {
        for parent in root.parents().await? {
            if base_ids.insert(parent.id().hex()) {
                base_commits.push(parent);
            }
        }
    }
    if base_commits.is_empty() {
        let root_commit = repo.store().root_commit();
        base_ids.insert(root_commit.id().hex());
        base_commits.push(root_commit);
    }

    ensure_revset_has_no_gaps(&commit_by_id, &base_ids, &heads, expression).await?;

    let from_tree = merge_commit_trees(repo.as_ref(), &base_commits).await?;
    let to_tree = merge_commit_trees(repo.as_ref(), &heads).await?;
    Ok(RevsetDiffTarget {
        from: from_tree,
        to: to_tree,
    })
}

async fn ensure_revset_has_no_gaps(
    commit_by_id: &HashMap<String, Commit>,
    base_ids: &HashSet<String>,
    heads: &[Commit],
    expression: &str,
) -> Result<()> {
    let mut stack = heads.to_vec();
    let mut visited = HashSet::new();
    while let Some(commit) = stack.pop() {
        let id = commit.id().hex();
        if base_ids.contains(&id) || !visited.insert(id.clone()) {
            continue;
        }
        let Some(commit) = commit_by_id.get(&id) else {
            bail!("revset {expression:?} has gaps and cannot be reviewed as one diff");
        };
        stack.extend(commit.parents().await?);
    }
    Ok(())
}

fn combine_revsets(revisions: &[String]) -> String {
    revisions
        .iter()
        .map(|revision| format!("({revision})"))
        .collect::<Vec<_>>()
        .join(" | ")
}

async fn resolve_single(
    repo: &Arc<ReadonlyRepo>,
    root: &Path,
    cwd: &Path,
    expression: &str,
) -> Result<Commit> {
    let commits = resolve_revset(repo, root, cwd, expression).await?;
    match commits.as_slice() {
        [commit] => Ok(commit.clone()),
        [] => bail!("revset {expression:?} resolved to no commits"),
        commits => bail!(
            "revset {expression:?} resolved to {} commits",
            commits.len()
        ),
    }
}

async fn resolve_revset(
    repo: &Arc<ReadonlyRepo>,
    root: &Path,
    cwd: &Path,
    expression: &str,
) -> Result<Vec<Commit>> {
    let commit_ids = resolve_revset_with_jj(root, cwd, expression)?;
    let mut commits = Vec::with_capacity(commit_ids.len());
    for commit_id in commit_ids {
        commits.push(repo.store().get_commit_async(&commit_id).await?);
    }
    Ok(commits)
}

fn path_allowed(path: &str, paths: &[String]) -> bool {
    paths.is_empty()
        || paths
            .iter()
            .any(|filter| path == filter || path.starts_with(&format!("{filter}/")))
}

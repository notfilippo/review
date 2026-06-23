use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::cli::CliOptions;
use crate::diff::{FileDiffInput, FileSnapshot};
use crate::patch::{PatchFile, parse_patch};
use crate::{git_backend, jj_backend};

#[derive(Clone, Debug, Serialize)]
pub struct ReviewInput {
    pub patch: String,
    pub files: Vec<PatchFile>,
    pub file_contexts: Vec<FileContext>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileContext {
    pub path: String,
    pub patch: String,
    pub old_file: FileContents,
    pub new_file: FileContents,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileContents {
    pub name: String,
    pub contents: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReviewComment {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub side: Option<String>,
    #[serde(default)]
    pub end_side: Option<String>,
    #[serde(default)]
    pub start_line: i32,
    #[serde(default)]
    pub end_line: i32,
    pub text: String,
}

impl ReviewComment {
    fn normalize(mut self) -> Option<Self> {
        self.text = self.text.trim().to_string();
        self.path = self.path.trim().to_string();
        if self.path.is_empty() || self.text.is_empty() || self.start_line <= 0 {
            return None;
        }

        self.side = trim_optional(self.side);
        self.end_side = trim_optional(self.end_side);

        let side = self
            .side
            .as_deref()
            .or(self.end_side.as_deref())
            .unwrap_or("line")
            .to_string();
        self.side = Some(side.clone());
        if self.end_side.is_none() {
            self.end_side = Some(side);
        }

        if self.end_line <= 0 {
            self.end_line = self.start_line;
        }
        if self.end_line < self.start_line {
            std::mem::swap(&mut self.start_line, &mut self.end_line);
            std::mem::swap(&mut self.side, &mut self.end_side);
        }
        Some(self)
    }

    pub fn location(&self) -> String {
        let side = self.side.as_deref().unwrap_or("line");
        let end_side = self.end_side.as_deref().unwrap_or(side);
        if self.start_line == self.end_line {
            return format!("{side} line {}", self.start_line);
        }
        if end_side != side {
            return format!(
                "{side} line {} to {end_side} line {}",
                self.start_line, self.end_line
            );
        }
        format!("{side} lines {}-{}", self.start_line, self.end_line)
    }
}

pub fn normalize_comments(comments: Vec<ReviewComment>) -> Vec<ReviewComment> {
    comments
        .into_iter()
        .filter_map(ReviewComment::normalize)
        .collect()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VcsKind {
    Jj,
    Git,
}

#[derive(Clone, Debug)]
pub struct RepoLocation {
    pub kind: VcsKind,
    pub root: PathBuf,
}

pub async fn load_review_input(options: &CliOptions) -> Result<ReviewInput> {
    let location = detect_repo(&options.cwd)?;
    let paths = normalize_path_filters(&location.root, &options.cwd, &options.paths)?;
    let input = match location.kind {
        VcsKind::Jj => jj_backend::load_review_input(options, &location.root, &paths).await?,
        VcsKind::Git => git_backend::load_review_input(options, &location.root, &paths)?,
    };

    if input.patch.trim().is_empty() {
        bail!("VCS diff is empty");
    }
    Ok(input)
}

pub fn build_review_input(patch: String, file_inputs: Vec<FileDiffInput>) -> ReviewInput {
    let (files, file_patches) = parse_patch(&patch);
    let file_contexts = files
        .iter()
        .map(|file| {
            let raw_patch = file_patches
                .get(file.display_path())
                .or_else(|| {
                    file.prev_path
                        .as_ref()
                        .and_then(|prev_path| file_patches.get(prev_path))
                })
                .cloned()
                .unwrap_or_default();
            let (old_path, new_path) = file.context_paths();
            let input = file_inputs.iter().find(|input| {
                input.old_path == old_path
                    || input.new_path == new_path
                    || input.old_path == file.display_path()
                    || input.new_path == file.display_path()
            });
            FileContext {
                path: file.display_path().to_string(),
                patch: raw_patch,
                old_file: FileContents {
                    name: old_path.to_string(),
                    contents: snapshot_contents(input.and_then(|input| input.old.as_ref())),
                },
                new_file: FileContents {
                    name: new_path.to_string(),
                    contents: snapshot_contents(input.and_then(|input| input.new.as_ref())),
                },
            }
        })
        .collect();

    ReviewInput {
        patch,
        files,
        file_contexts,
    }
}

fn detect_repo(cwd: &Path) -> Result<RepoLocation> {
    if let Some(root) = find_repo_root(cwd, ".jj") {
        return Ok(RepoLocation {
            kind: VcsKind::Jj,
            root,
        });
    }
    if let Some(root) = find_repo_root(cwd, ".git") {
        return Ok(RepoLocation {
            kind: VcsKind::Git,
            root,
        });
    }
    bail!("no jj or git repository found");
}

fn find_repo_root(cwd: &Path, marker: &str) -> Option<PathBuf> {
    let mut dir = cwd;
    loop {
        if dir.join(marker).exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

fn normalize_path_filters(root: &Path, cwd: &Path, paths: &[String]) -> Result<Vec<String>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let root = canonical_dir(root)?;
    let cwd = canonical_dir(cwd)?;
    paths
        .iter()
        .map(|path| {
            let mut full_path = PathBuf::from(path);
            if !full_path.is_absolute() {
                full_path = cwd.join(full_path);
            }
            let full_path = full_path
                .canonicalize()
                .unwrap_or_else(|_| full_path.clone());
            let rel = full_path
                .strip_prefix(&root)
                .with_context(|| format!("path {path:?} is outside repository"))?;
            Ok(rel.to_string_lossy().replace('\\', "/"))
        })
        .collect()
}

fn canonical_dir(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("canonicalize {}", path.display()))
}

fn snapshot_contents(snapshot: Option<&FileSnapshot>) -> String {
    snapshot
        .map(|snapshot| String::from_utf8_lossy(&snapshot.contents).to_string())
        .unwrap_or_default()
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

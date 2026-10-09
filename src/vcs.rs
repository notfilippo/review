use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::cli::{CliOptions, trim_optional};
use crate::diff::{FileDiffInput, FileSnapshot, render_file_patch};
use crate::{git_backend, jj_backend};

#[derive(Debug)]
pub struct ReviewInput {
    pub files: Vec<ReviewFile>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum FileStatus {
    Added,
    Deleted,
    Modified,
}

/// One changed file: its patch plus both full versions, so the UI can expand
/// context without asking the server again.
#[derive(Debug, Serialize)]
pub struct ReviewFile {
    pub path: String,
    pub status: FileStatus,
    pub patch: String,
    pub old_file: FileContents,
    pub new_file: FileContents,
}

#[derive(Debug, Serialize)]
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
enum VcsKind {
    Jj,
    Git,
}

#[derive(Clone, Debug)]
struct RepoLocation {
    kind: VcsKind,
    root: PathBuf,
}

/// Returns the repository root alongside the review so callers can read files
/// outside the diff.
pub async fn load_review_input(options: &CliOptions) -> Result<(PathBuf, ReviewInput)> {
    let location = detect_repo(&options.cwd)?;
    let paths = normalize_path_filters(&location.root, &options.cwd, &options.paths)?;
    let input = match location.kind {
        VcsKind::Jj => jj_backend::load_review_input(options, &location.root, &paths).await?,
        VcsKind::Git => git_backend::load_review_input(options, &location.root, &paths)?,
    };

    if input.files.is_empty() {
        bail!("VCS diff is empty");
    }
    Ok((location.root, input))
}

pub fn build_review_input(inputs: Vec<FileDiffInput>) -> ReviewInput {
    let files = inputs
        .iter()
        .map(|input| ReviewFile {
            path: input.new_path.clone(),
            status: match (&input.old, &input.new) {
                (None, _) => FileStatus::Added,
                (_, None) => FileStatus::Deleted,
                _ => FileStatus::Modified,
            },
            patch: render_file_patch(input),
            old_file: FileContents {
                name: input.old_path.clone(),
                contents: snapshot_contents(input.old.as_ref()),
            },
            new_file: FileContents {
                name: input.new_path.clone(),
                contents: snapshot_contents(input.new.as_ref()),
            },
        })
        .collect();
    ReviewInput { files }
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
    let mut normalized = Vec::with_capacity(paths.len());
    for path in paths {
        let input = Path::new(path);
        let full_path = if input.is_absolute() {
            input.to_path_buf()
        } else {
            cwd.join(input)
        };
        let full_path = normalize_lexically(&full_path);
        let full_path = if full_path == root {
            root.clone()
        } else {
            canonicalize_parent(&full_path)?
        };
        let rel = full_path
            .strip_prefix(&root)
            .with_context(|| format!("path {path:?} is outside repository"))?;
        if rel.as_os_str().is_empty() {
            return Ok(Vec::new());
        }
        normalized.push(rel.to_string_lossy().replace('\\', "/"));
    }
    Ok(normalized)
}

fn canonical_dir(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("canonicalize {}", path.display()))
}

fn canonicalize_parent(path: &Path) -> Result<PathBuf> {
    let Some(name) = path.file_name() else {
        return canonical_dir(path);
    };
    let parent = path.parent().unwrap_or(path);
    Ok(canonicalize_existing_prefix(parent)?.join(name))
}

fn canonicalize_existing_prefix(path: &Path) -> Result<PathBuf> {
    let mut current = path;
    let mut suffix = Vec::new();
    loop {
        match current.canonicalize() {
            Ok(mut canonical) => {
                for component in suffix.iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                let Some(name) = current.file_name() else {
                    return Err(err).with_context(|| format!("canonicalize {}", path.display()));
                };
                suffix.push(name.to_os_string());
                current = current.parent().unwrap_or(current);
            }
            Err(err) => {
                return Err(err).with_context(|| format!("canonicalize {}", path.display()));
            }
        }
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
        }
    }
    normalized
}

fn snapshot_contents(snapshot: Option<&FileSnapshot>) -> String {
    snapshot
        .map(|snapshot| String::from_utf8_lossy(&snapshot.contents).to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{FileStatus, build_review_input, normalize_path_filters};
    use crate::diff::{FileDiffInput, FileSnapshot};

    fn snapshot(contents: &[u8]) -> Option<FileSnapshot> {
        Some(FileSnapshot {
            mode: "100644".to_string(),
            hash: "0123456789abcdef".to_string(),
            contents: contents.to_vec(),
        })
    }

    fn input(path: &str, old: Option<FileSnapshot>, new: Option<FileSnapshot>) -> FileDiffInput {
        FileDiffInput {
            old_path: path.to_string(),
            new_path: path.to_string(),
            old,
            new,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time follows the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("review-{name}-{}-{unique}", std::process::id()))
    }

    #[test]
    fn repository_root_disables_path_filtering() {
        let root = temp_dir("root-filter");
        fs::create_dir_all(&root).expect("create test repository root");

        let filters =
            normalize_path_filters(&root, &root, &[".".to_string()]).expect("normalize root");

        assert!(filters.is_empty());
        fs::remove_dir_all(root).expect("remove test repository root");
    }

    #[cfg(unix)]
    #[test]
    fn final_symlink_component_is_not_resolved() {
        let container = temp_dir("symlink-filter");
        let root = container.join("repo");
        let outside = container.join("outside");
        fs::create_dir_all(&root).expect("create test repository root");
        fs::write(&outside, "outside").expect("create symlink target");
        symlink(&outside, root.join("link")).expect("create path-filter symlink");
        symlink(&root, root.join("root-link")).expect("create root symlink");

        let filters =
            normalize_path_filters(&root, &root, &["link".to_string(), "root-link".to_string()])
                .expect("normalize symlinks");

        assert_eq!(filters, ["link", "root-link"]);
        fs::remove_dir_all(container).expect("remove symlink test directory");
    }

    #[test]
    fn review_files_carry_status_patch_and_contents() {
        let review = build_review_input(vec![
            input("added.txt", None, snapshot(b"new\n")),
            input("gone.txt", snapshot(b"old\n"), None),
            input("caf\u{e9}.txt", snapshot(b"a\nb\n"), snapshot(b"a\nc\n")),
            input("blob.bin", snapshot(b"\0old"), snapshot(b"\0new")),
        ]);

        let statuses = review
            .files
            .iter()
            .map(|file| file.status)
            .collect::<Vec<_>>();
        assert_eq!(
            statuses,
            [
                FileStatus::Added,
                FileStatus::Deleted,
                FileStatus::Modified,
                FileStatus::Modified
            ]
        );
        assert!(review.files[0].patch.contains("new file mode 100644\n"));
        assert!(review.files[0].patch.ends_with("@@ -0,0 +1 @@\n+new\n"));
        assert_eq!(review.files[1].new_file.contents, "");
        assert!(
            review.files[2]
                .patch
                .starts_with("diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"\n")
        );
        assert!(review.files[2].patch.contains("-b\n+c\n"));
        assert!(
            review.files[3]
                .patch
                .contains("Binary files a/blob.bin and b/blob.bin differ\n")
        );
    }
}

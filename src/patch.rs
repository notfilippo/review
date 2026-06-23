use std::collections::HashMap;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct PatchFile {
    pub path: String,
    pub prev_path: Option<String>,
    pub status: FileStatus,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub enum FileStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
}

#[derive(Default)]
struct PendingPatchFile {
    path: Option<String>,
    prev_path: Option<String>,
    status: Option<FileStatus>,
}

impl PatchFile {
    pub fn display_path(&self) -> &str {
        if self.path.is_empty() {
            self.prev_path.as_deref().unwrap_or_default()
        } else {
            &self.path
        }
    }

    pub fn context_paths(&self) -> (&str, &str) {
        let old_path = self.prev_path.as_deref().unwrap_or(self.path.as_str());
        let new_path = if self.path.is_empty() {
            old_path
        } else {
            self.path.as_str()
        };
        (old_path, new_path)
    }
}

pub fn parse_patch(patch: &str) -> (Vec<PatchFile>, HashMap<String, String>) {
    let chunks = split_git_file_patches(patch);
    if chunks.is_empty() {
        return (parse_patch_files(patch), HashMap::new());
    }

    let mut files = Vec::new();
    let mut file_patches = HashMap::new();
    for chunk in chunks {
        for file in parse_patch_files(&chunk) {
            if !file.path.is_empty() {
                file_patches.insert(file.path.clone(), chunk.clone());
            }
            if let Some(prev_path) = &file.prev_path {
                file_patches.insert(prev_path.clone(), chunk.clone());
            }
            files.push(file);
        }
    }
    (dedupe_patch_files(files), file_patches)
}

pub fn parse_patch_files(patch: &str) -> Vec<PatchFile> {
    let mut files = Vec::new();
    let mut current = PendingPatchFile::default();

    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            current.flush(&mut files);
            if let Some((prev, next)) = parse_diff_git_line(rest) {
                current.prev_path = Some(prev);
                current.path = Some(next);
            }
            current.status = Some(FileStatus::Modified);
        } else if line.starts_with("new file mode ") {
            current.prev_path = None;
            current.status = Some(FileStatus::Added);
        } else if line.starts_with("deleted file mode ") {
            current.path = None;
            current.status = Some(FileStatus::Deleted);
        } else if line.starts_with("rename from ") {
            current.prev_path = normalize_patch_path(line.trim_start_matches("rename from "));
            current.status = Some(FileStatus::Renamed);
        } else if line.starts_with("rename to ") {
            current.path = normalize_patch_path(line.trim_start_matches("rename to "));
            current.status = Some(FileStatus::Renamed);
        } else if let Some(rest) = line.strip_prefix("--- ") {
            current.prev_path = normalize_patch_header_path(rest);
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            current.path = normalize_patch_header_path(rest);
        }
    }
    current.flush(&mut files);

    dedupe_patch_files(files)
}

impl PendingPatchFile {
    fn flush(&mut self, files: &mut Vec<PatchFile>) {
        let prev_path = self.prev_path.take();
        let Some(path) = self.path.take().or_else(|| prev_path.clone()) else {
            *self = Self::default();
            return;
        };
        files.push(PatchFile {
            path,
            prev_path,
            status: self.status.take().unwrap_or(FileStatus::Modified),
        });
        *self = Self::default();
    }
}

fn parse_diff_git_line(rest: &str) -> Option<(String, String)> {
    let (prev, next) = split_diff_git_paths(rest)?;
    Some((
        normalize_prefixed_patch_path(&prev)?,
        normalize_prefixed_patch_path(&next)?,
    ))
}

fn normalize_patch_header_path(path: &str) -> Option<String> {
    let path = path.split('\t').next().unwrap_or_default().trim();
    if path == "/dev/null" {
        return None;
    }
    normalize_prefixed_patch_path(path)
}

fn normalize_patch_path(path: &str) -> Option<String> {
    let path = path.trim();
    let normalized = if path.len() >= 2 && path.starts_with('"') && path.ends_with('"') {
        unquote_patch_path(path)
    } else {
        path.trim_matches('"').to_string()
    };
    (!normalized.is_empty()).then_some(normalized)
}

fn normalize_prefixed_patch_path(path: &str) -> Option<String> {
    let path = normalize_patch_path(path)?;
    Some(
        path.strip_prefix("a/")
            .or_else(|| path.strip_prefix("b/"))
            .map(str::to_string)
            .unwrap_or(path),
    )
}

fn split_diff_git_paths(rest: &str) -> Option<(String, String)> {
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    if rest.starts_with('"') {
        let (prev, remaining) = split_quoted_path(rest)?;
        let next = remaining.trim();
        if next.starts_with('"') {
            let (quoted_next, trailing) = split_quoted_path(next)?;
            if trailing.trim().is_empty() {
                return Some((prev, quoted_next));
            }
        }
        return Some((prev, next.to_string()));
    }
    split_unquoted_diff_git_paths(rest)
}

fn split_quoted_path(value: &str) -> Option<(String, String)> {
    let mut escaped = false;
    for (idx, ch) in value.char_indices().skip(1) {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some((value[..=idx].to_string(), value[idx + 1..].to_string()));
        }
    }
    None
}

fn split_unquoted_diff_git_paths(rest: &str) -> Option<(String, String)> {
    let mut first = None;
    let mut search_start = 0;
    while let Some(relative_idx) = rest[search_start..].find(" b/") {
        let idx = search_start + relative_idx;
        let prev = rest[..idx].to_string();
        let next = rest[idx + 1..].trim().to_string();
        if prev.starts_with("a/") && next.starts_with("b/") {
            if first.is_none() {
                first = Some((prev.clone(), next.clone()));
            }
            if normalize_prefixed_patch_path(&prev) == normalize_prefixed_patch_path(&next) {
                return Some((prev, next));
            }
        }
        search_start = idx + " b/".len();
    }
    first
}

fn dedupe_patch_files(files: Vec<PatchFile>) -> Vec<PatchFile> {
    let mut seen = HashMap::new();
    let mut out = Vec::new();
    for file in files {
        let key = file.display_path().to_string();
        if key.is_empty() {
            continue;
        }
        if let Some(existing) = seen.get(&key).copied() {
            out[existing] = file;
        } else {
            seen.insert(key, out.len());
            out.push(file);
        }
    }
    out
}

fn split_git_file_patches(patch: &str) -> Vec<String> {
    let mut patches = Vec::new();
    let mut current = String::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") && !current.is_empty() {
            patches.push(std::mem::take(&mut current));
        }
        current.push_str(line);
    }
    if !current.is_empty() && current.starts_with("diff --git ") {
        patches.push(current);
    }
    patches
}

fn unquote_patch_path(path: &str) -> String {
    let mut out = String::new();
    let mut chars = path[1..path.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some(ch @ '0'..='7') => {
                let mut value = ch.to_digit(8).unwrap_or(0);
                for _ in 0..2 {
                    match chars.clone().next().and_then(|next| next.to_digit(8)) {
                        Some(digit) => {
                            chars.next();
                            value = value * 8 + digit;
                        }
                        None => break,
                    }
                }
                out.push(char::from_u32(value).unwrap_or('?'));
            }
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

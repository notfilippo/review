use anyhow::Result;
use bstr::{BString, ByteSlice};
use jj_lib::diff_presentation::LineCompareMode;
use jj_lib::diff_presentation::unified::{DiffLineType, unified_diff_hunks};
use jj_lib::merge::Diff;

#[derive(Clone, Debug)]
pub struct FileSnapshot {
    pub mode: String,
    pub hash: String,
    pub contents: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct FileDiffInput {
    pub old_path: String,
    pub new_path: String,
    pub old: Option<FileSnapshot>,
    pub new: Option<FileSnapshot>,
}

pub fn render_patch(files: &[FileDiffInput]) -> Result<String> {
    let mut patch = String::new();
    for file in files {
        render_file_patch(&mut patch, file)?;
    }
    Ok(patch)
}

fn render_file_patch(out: &mut String, file: &FileDiffInput) -> Result<()> {
    let display_old = if file.old_path.is_empty() {
        &file.new_path
    } else {
        &file.old_path
    };
    let display_new = if file.new_path.is_empty() {
        &file.old_path
    } else {
        &file.new_path
    };
    out.push_str("diff --git ");
    out.push_str(&quote_git_path(&format!("a/{display_old}")));
    out.push(' ');
    out.push_str(&quote_git_path(&format!("b/{display_new}")));
    out.push('\n');

    match (&file.old, &file.new) {
        (None, None) => return Ok(()),
        (None, Some(new)) => {
            out.push_str("new file mode ");
            out.push_str(&new.mode);
            out.push('\n');
            out.push_str("index 0000000000..");
            out.push_str(&short_hash(&new.hash));
            out.push('\n');
        }
        (Some(old), None) => {
            out.push_str("deleted file mode ");
            out.push_str(&old.mode);
            out.push('\n');
            out.push_str("index ");
            out.push_str(&short_hash(&old.hash));
            out.push_str("..0000000000");
            out.push('\n');
        }
        (Some(old), Some(new)) => {
            if old.mode != new.mode {
                out.push_str("old mode ");
                out.push_str(&old.mode);
                out.push('\n');
                out.push_str("new mode ");
                out.push_str(&new.mode);
                out.push('\n');
            }
            out.push_str("index ");
            out.push_str(&short_hash(&old.hash));
            out.push_str("..");
            out.push_str(&short_hash(&new.hash));
            if old.mode == new.mode {
                out.push(' ');
                out.push_str(&old.mode);
            }
            out.push('\n');
        }
    }

    let old_contents = file
        .old
        .as_ref()
        .map(|snapshot| snapshot.contents.as_slice())
        .unwrap_or_default();
    let new_contents = file
        .new
        .as_ref()
        .map(|snapshot| snapshot.contents.as_slice())
        .unwrap_or_default();
    let binary = is_binary(old_contents) || is_binary(new_contents);
    if binary {
        out.push_str("Binary files ");
        out.push_str(&null_or_prefixed("a/", display_old, file.old.is_some()));
        out.push_str(" and ");
        out.push_str(&null_or_prefixed("b/", display_new, file.new.is_some()));
        out.push_str(" differ\n");
        return Ok(());
    }

    out.push_str("--- ");
    out.push_str(&null_or_prefixed("a/", display_old, file.old.is_some()));
    out.push('\n');
    out.push_str("+++ ");
    out.push_str(&null_or_prefixed("b/", display_new, file.new.is_some()));
    out.push('\n');

    let old_bstr = BString::new(old_contents.to_vec());
    let new_bstr = BString::new(new_contents.to_vec());
    for hunk in unified_diff_hunks(
        Diff::new(old_bstr.as_bstr(), new_bstr.as_bstr()),
        3,
        LineCompareMode::Exact,
    ) {
        let old_range = hunk_range(hunk.left_line_range.start, hunk.left_line_range.end);
        let new_range = hunk_range(hunk.right_line_range.start, hunk.right_line_range.end);
        out.push_str(&format!("@@ -{old_range} +{new_range} @@\n"));
        for (line_type, tokens) in hunk.lines {
            let prefix = match line_type {
                DiffLineType::Context => ' ',
                DiffLineType::Removed => '-',
                DiffLineType::Added => '+',
            };
            out.push(prefix);
            let mut line = Vec::new();
            for (_, token) in tokens {
                line.extend_from_slice(token);
            }
            out.push_str(&String::from_utf8_lossy(&line));
            if !line.ends_with(b"\n") {
                out.push('\n');
                out.push_str("\\ No newline at end of file\n");
            }
        }
    }
    Ok(())
}

fn hunk_range(start: usize, end: usize) -> String {
    let len = end.saturating_sub(start);
    let line = if len == 0 { start } else { start + 1 };
    if len == 1 {
        line.to_string()
    } else {
        format!("{line},{len}")
    }
}

fn short_hash(hash: &str) -> String {
    hash.chars().take(10).collect()
}

fn null_or_prefixed(prefix: &str, path: &str, present: bool) -> String {
    if present {
        quote_git_path(&format!("{prefix}{path}"))
    } else {
        "/dev/null".to_string()
    }
}

fn quote_git_path(path: &str) -> String {
    if path
        .bytes()
        .all(|byte| byte > b' ' && byte != b'"' && byte != b'\\')
    {
        return path.to_string();
    }
    let mut quoted = String::from("\"");
    for byte in path.bytes() {
        match byte {
            b'\n' => quoted.push_str("\\n"),
            b'\t' => quoted.push_str("\\t"),
            b'\r' => quoted.push_str("\\r"),
            b'"' => quoted.push_str("\\\""),
            b'\\' => quoted.push_str("\\\\"),
            0x20..=0x7e => quoted.push(byte as char),
            other => quoted.push_str(&format!("\\{other:03o}")),
        }
    }
    quoted.push('"');
    quoted
}

fn is_binary(contents: &[u8]) -> bool {
    contents.iter().take(8000).any(|byte| *byte == 0)
}

use std::fmt::Write;

use crate::vcs::ReviewComment;

pub fn format_comments(comments: &[ReviewComment]) -> String {
    if comments.is_empty() {
        return "No comments.\n".to_string();
    }

    let mut markdown = String::new();
    for comment in comments {
        let _ = writeln!(
            markdown,
            "- `{}` {}: {}",
            comment.path,
            comment.location(),
            comment_text(&comment.text)
        );
    }
    markdown
}

fn comment_text(text: &str) -> String {
    text.trim().replace('\n', "\n  ")
}

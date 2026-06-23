mod cli;
mod diff;
mod frontend;
mod git_backend;
mod jj_backend;
mod markdown;
mod patch;
mod server;
mod vcs;

use std::io::Write;

use anyhow::{Context, Result};

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("review: {err:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let options = cli::parse()?;
    let input = vcs::load_review_input(&options).await?;
    let comments = server::serve_review(&options, input).await?;
    let markdown = markdown::format_comments(&comments);
    std::io::stdout()
        .write_all(markdown.as_bytes())
        .context("write markdown")?;
    Ok(())
}

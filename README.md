# Review

A local browser UI for [Jujutsu](https://jj-vcs.github.io/jj/latest/) (`jj`) and Git diffs. Leave inline comments and collect them as Markdown.

![Review UI screenshot](docs/demo.png)

## Install

Requires stable [Rust and Cargo](https://rustup.rs/) and a modern browser with internet access. The UI loads its libraries from [esm.sh](https://esm.sh/).

```sh
cargo install --locked --git https://github.com/notfilippo/review.git
```

CI runs on Linux; macOS is used for development. Windows is not covered by CI.

## Usage

Run `review` in a jj or Git repository:

```sh
review
```

By default, it compares the mainline with your working copy, including uncommitted changes. Add comments in the browser, then click **Finish review** to print them:

```markdown
- `src/config.rs` additions line 12: Could this timeout be configurable?
```

To choose a different diff:

```sh
# jj: a single revision or a revset
review -r '@'
review -r 'trunk()..@'

# Git: from a commit, between commits, or a single commit
review --from main
review --from main --to HEAD
review -r HEAD
```

Add paths to limit the review (`review src/`), or use `--port 8080` to choose a port. See `review --help` for all options.

## In the browser

- Click or drag over line numbers to comment. Find your comments in the **Comments** tab.
- `⌘`-click a word to find references, or use `⌘F` to search the repository.
- Search results show nearby files first. Results outside the diff open in a read-only preview.

Use `Ctrl` instead of `⌘` on other platforms.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file |
| `n` / `p` | Next / previous comment |
| `⌘Enter` | Save the comment being edited |
| `Esc` | Cancel a draft, clear search, or close the preview |

## Use with coding agents

Ask your agent:

```text
Run review for this change and wait for me to finish in the browser.
Then use the Markdown feedback to fix the issues.
```

Or run `review` yourself and paste the output into the conversation. In [Claude Code's shell mode](https://code.claude.com/docs/en/interactive-mode#shell-mode-with--prefix), `!review` runs it and adds the output to the conversation directly.

## Connection recovery

If the server disconnects, keep the tab open. You can still browse and save comments. Use **Copy restart command** and run it in your terminal; comments sync when the server returns.

Keep the checkout unchanged during recovery. On Windows, run the copied command in PowerShell.

## Development

The Rust binary embeds the JavaScript frontend, so frontend changes need a rebuild.

```sh
cargo build --locked
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

Bug reports and pull requests are welcome. Include the command, repository type, and expected and actual behavior in bug reports.

To update the README image, see the [screenshot tool](tools/screenshot/README.md).

## License

[MIT](LICENSE).

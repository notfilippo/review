# Review

Local review UI for jj and Git repositories.

`review` starts a browser UI for reading a diff, leaving inline comments, and exporting those comments as Markdown.

## Usage

```sh
cargo install --git git@github.com:notfilippo/review.git
review --help
```

For jj repositories, pass a revset. The tool renders the whole `jj diff -r <revset>` result as one review.

For Git repositories, pass `--from` and `--to` to review a commit range.

# Review

Review is a local code review UI for reviewing jj or git diffs in the browser.

It starts a local web server, opens a diff review UI, and prints the completed
review comments as Markdown when you click Done.

## Install

The source branch does not commit built frontend assets. Install from the
generated `install` branch:

```sh
go install github.com/notfilippo/review@install
```

If a Go proxy serves a stale branch tip or your proxy is unreachable, bypass it:

```sh
GOPROXY=direct go install github.com/notfilippo/review@install
```

## Usage

Review the current jj change or git working tree:

```sh
review
```

Review a single revision:

```sh
review -r REV
```

Review an explicit range:

```sh
review -from BASE -to HEAD
```

Run `review -help` for all flags.

## Development

```sh
pnpm install
pnpm build
go run .
```

`pnpm build` writes generated assets to `internal/static`. Those assets are
ignored on the source branch and published by CI to the `install` branch.

# Review

Review is a local code review UI for reviewing jj or git diffs in the browser.

It starts a local web server, opens a diff review UI, and prints the completed
review comments as Markdown when you click Done.

## Install

```sh
go install github.com/notfilippo/review@latest
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
go run .
```

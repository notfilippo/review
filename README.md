# Review

A local browser UI for reviewing [Jujutsu](https://jj-vcs.github.io/jj/latest/) (`jj`) revsets and Git diffs.

`review` renders one combined diff in your browser, lets you leave inline comments, and prints those comments as Markdown when you finish.

![Review UI screenshot](docs/demo.png)

## ⚙️ Install

```sh
cargo install --locked --git ssh://git@github.com/notfilippo/review.git
```

## ▶️ Usage

Run `review` from a Jujutsu or Git repository.

```sh
review
```

The browser opens with the current changes. Click **Finish review** to print comments to stdout as Markdown.

## 🤖 AI Agent Workflow

Two workflows work well with Codex, Claude, or another coding agent.

**Agent runs `review`**

Ask the agent to pick the right diff and wait for the browser review:

```text
Use the `review` CLI to let me review the full code change. Check `review --help`, choose the right diff options for this repository, wait for me to finish in the browser, then use the Markdown comments from stdout to fix the issues.
```

**You run `!review`**

Use this when you want to pick the diff yourself and drive the browser review:

```sh
!review
```

```text
Use the review comments above and fix them.
```

When the command exits, the Markdown comments are still in the conversation context.

### Backends

#### Jujutsu (`jj`)

```sh
# Review a revset as one combined diff.
review -r '@'
```

`-r` accepts a Jujutsu revset and is rendered like one `jj diff -r <revset>` review.

#### Git

```sh
# Review a commit range.
review --from main --to HEAD
```

## UI

The browser UI uses Pierre's [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs) and [@pierre/trees](https://www.npmjs.com/package/@pierre/trees) packages, loaded as native ESM modules through esm.sh.

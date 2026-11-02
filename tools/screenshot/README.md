# Screenshot previews

Capture the frontend at 3× resolution inside a rendered browser frame. Each run saves a separate preview in a temporary directory and prints its path.

## Setup

Requires Node.js 22 or newer and internet access for the frontend libraries. Run these commands from the repository root:

```sh
npm ci --prefix tools/screenshot
npm exec --prefix tools/screenshot -- playwright install chromium
npm run --prefix tools/screenshot capture
```

On Linux, Playwright may need additional [system packages](https://playwright.dev/docs/browsers#install-system-dependencies).

## Capture a review

The default capture uses the fixed review in [demo.mjs](demo.mjs) and needs no Rust build.

For a fuller screenshot, start a review and save the comments you want to show. Pass its URL and optionally the file to focus on:

```sh
npm run --prefix tools/screenshot capture -- 'http://127.0.0.1:7527/?token=YOUR_TOKEN' src/server.rs
```

The rendered address bar shows only the host. Inspect the preview before copying it to [docs/demo.png](../../docs/demo.png).

import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { session } from "./demo.mjs";

const frontend = resolve(fileURLToPath(new URL("../../internal/frontend/", import.meta.url)));
const output = resolve(await mkdtemp(resolve(tmpdir(), "review-screenshot-")), "preview.png");
const reviewURL = process.argv[2];
const selectedFile = process.argv[3];
const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(await readFile(new URL("./browser-frame.html", import.meta.url)));
      return;
    }
    if (pathname === "/api/session" || pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(pathname === "/api/session" ? session : { server_id: session.server_id }));
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const path = resolve(frontend, `.${decodeURIComponent(pathname === "/review" ? "/index.html" : pathname)}`);
    if (!path.startsWith(`${frontend}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    const contents = await readFile(path);
    response.writeHead(200, { "Content-Type": contentTypes[extname(path)] || "application/octet-stream" });
    response.end(contents);
  } catch {
    response.writeHead(404).end();
  }
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 3,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("review.diffStyle", "split");
    localStorage.setItem("review.sidebarWidth", "360");
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = reviewURL || `${origin}/review?token=screenshot`;
  await page.goto(origin);
  await page.locator("iframe").evaluate((element, url) => { element.src = url; }, target);
  await page.locator("#address").evaluate((element, url) => { element.textContent = new URL(url).host; }, target);
  const frame = await page.locator("iframe").contentFrame();
  await frame.locator("#status").filter({ hasText: /^\d+ files?$/ }).waitFor();
  if (selectedFile) {
    await frame.locator("body").evaluate(async (_, path) => {
      const { setCurrentPath } = await import("/src/diff-view.js");
      const { state } = await import("/src/state.js");
      if (!state.filesByPath.has(path)) throw new Error(`File is not in this review: ${path}`);
      setCurrentPath(path, { scrollDiff: false, selectTree: true });
      state.codeView.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" });
    }, selectedFile);
  }
  await frame.locator('#diff [data-char][style*="--diffs-token"]').filter({ visible: true }).first().waitFor();
  await frame.locator("body").evaluate(() => document.fonts.ready);
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  await page.screenshot({ path: output, animations: "disabled", omitBackground: true });
  console.log(`Preview saved to ${output}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { session } from "./demo.mjs";

const frontend = resolve(fileURLToPath(new URL("../../internal/frontend/", import.meta.url)));
const output = fileURLToPath(new URL("../../docs/demo.png", import.meta.url));
const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/api/session" || pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(pathname === "/api/session" ? session : { server_id: session.server_id }));
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const path = resolve(frontend, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`);
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
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
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
    localStorage.setItem("review.sidebarWidth", "340");
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?token=screenshot`);
  await page.locator("#status").filter({ hasText: "2 files" }).waitFor();
  await page.locator("#diff [data-char]").filter({ hasText: /^HashMap$/ }).first().waitFor();
  await page.locator(".annotation-card").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  await page.screenshot({ path: output, animations: "disabled" });
  console.log(`Updated ${output}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

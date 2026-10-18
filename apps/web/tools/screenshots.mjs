// Every screen as pixels, from the built Storybook: one PNG per story at a desktop and a phone
// width, by headless Chromium over `storybook-static`. The stories draw from `ui/fixtures.ts`
// with no engine behind them, so this needs no host, no wasm and no display — the console's
// `tools/screenshots.mjs`, for this client's one set of stories.
//
// CI attaches the result to every run. Nothing is asserted: a cascade's last frame and a font's
// arrival make a pixel diff flap, and a layout that drifted is for a person to see.
//
//   npm run build-storybook -w punktfunk-web      # → apps/web/storybook-static
//   npm run screenshots -w punktfunk-web          # → apps/web/screenshots/<story>-<width>.png
//
// Env: OUT (output dir), STORYBOOK_STATIC (input dir), VIEWPORTS (`1440x900,390x844`), SCALE
// (device pixels per CSS pixel, 2), SETTLE (ms after the story mounts, 1500: the cascades take
// about a second), ONLY (comma-separated story-id substrings), CHROMIUM (an executable to use
// instead of the one `playwright install chromium` put down).

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(process.env.STORYBOOK_STATIC ?? "storybook-static");
const OUT = resolve(process.env.OUT ?? "screenshots");
const SETTLE = Number(process.env.SETTLE ?? 1500);
const SCALE = Number(process.env.SCALE ?? 2);
const VIEWPORTS = (process.env.VIEWPORTS ?? "1440x900,390x844").split(",").map((v) => {
  const [width, height] = v.trim().split("x").map(Number);
  return { width, height };
});
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

/** The build, served as the static site it is; the path is contained to `rootDir`. */
function staticServer(rootDir) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith("/")) path += "index.html";
      const filePath = normalize(join(rootDir, path));
      if (!filePath.startsWith(rootDir)) return res.writeHead(403).end();
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
}

/** Every story of the screens, from the build's own index. */
async function listStories(rootDir) {
  const index = JSON.parse(await readFile(join(rootDir, "index.json"), "utf8"));
  return Object.values(index.entries ?? index.stories ?? {})
    .filter((e) => e.type === "story" || e.type === undefined)
    .filter((e) => (e.title ?? "").startsWith("Screens"))
    .filter((e) => ONLY.length === 0 || ONLY.some((f) => e.id.includes(f)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  if (!existsSync(join(ROOT, "index.json"))) {
    throw new Error(`${ROOT} has no index.json — run \`npm run build-storybook -w punktfunk-web\` first`);
  }
  const stories = await listStories(ROOT);
  if (stories.length === 0) throw new Error("no Screens/* stories in the build");
  await mkdir(OUT, { recursive: true });

  const server = staticServer(ROOT);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await chromium.launch({
    args: ["--force-color-profile=srgb"],
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
  });

  let ok = 0;
  const wanted = stories.length * VIEWPORTS.length;
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: SCALE, colorScheme: "dark" });
    for (const story of stories) {
      const page = await context.newPage();
      const file = join(OUT, `${story.id}-${viewport.width}.png`);
      try {
        await page.goto(`http://127.0.0.1:${port}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`, {
          waitUntil: "networkidle",
          timeout: 30_000,
        });
        await page.waitForSelector("#storybook-root > *", { timeout: 20_000 });
        // Web fonts settled, else the text reflows or falls back in the shot.
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(SETTLE);
        await page.screenshot({ path: file });
        console.log(`✓ ${story.id} @ ${viewport.width} → ${file}`);
        ok++;
      } catch (e) {
        console.warn(`✗ ${story.id} @ ${viewport.width}: ${e.message}`);
      } finally {
        await page.close();
      }
    }
    await context.close();
  }

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\n${ok}/${wanted} screens captured → ${OUT}`);
  if (ok < wanted) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

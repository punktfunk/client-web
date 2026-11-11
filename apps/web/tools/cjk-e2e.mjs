// The console's CJK faces, end to end on the built page: `dist/` served as the static site it is,
// `?ui=console` in headless Chromium, and one saved host per case. A Latin name must fetch
// nothing under `fonts/`. A Japanese one must fetch the Japanese ranges and the slices its chars
// sit in, each once, and the console must take every slice. Needs no host: the card is drawn
// from what this browser remembers.
//
//   npm run build                         # the wasm, the library, the app → apps/web/dist
//   npm run cjk-e2e -w punktfunk-web      # → apps/web/screenshots/cjk-<case>.png
//
// Env: DIST (input dir), OUT (where the shots go), CHROMIUM (an executable to use instead of the
// one `playwright install chromium` put down). The shots are for a person to look at.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { staticServer } from "./static-server.mjs";

const DIST = resolve(process.env.DIST ?? "dist");
const OUT = resolve(process.env.OUT ?? "screenshots");
const CASES = [
  { name: "latin", label: "Living room", fonts: false },
  { name: "japanese", label: "リビングのゲーム機", fonts: true },
];
/** No font request for this long after the last one: the console has what it asked for. */
const QUIET_MS = 3000;

/** The Japanese slices `text`'s chars sit in, from the build's own ranges. */
function slicesOf(text) {
  const [dir] = readdirSync(join(DIST, "fonts"));
  const ranges = JSON.parse(readFileSync(join(DIST, "fonts", dir, "jp", "ranges.json"), "utf8"));
  const out = new Set();
  for (const c of text) {
    const cp = c.codePointAt(0);
    for (const [slice, range] of Object.entries(ranges)) {
      const hit = range.split(",").some((part) => {
        const [a, b = a] = part.trim().slice(2).split("-");
        return cp >= parseInt(a, 16) && cp <= parseInt(b, 16);
      });
      if (hit) out.add(`jp/${slice}.woff`);
    }
  }
  return out;
}

async function run(browser, origin, c) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: "dark" });
  await context.addInitScript((label) => {
    localStorage.setItem("pf.hosts", JSON.stringify({ "https://192.0.2.10:47990": { label } }));
  }, c.label);
  const page = await context.newPage();
  const fonts = [];
  const logs = [];
  let last = Date.now();
  page.on("console", (m) => logs.push(m.text()));
  page.on("requestfinished", async (req) => {
    const url = new URL(req.url());
    if (!url.pathname.includes("/fonts/")) return;
    last = Date.now();
    const body = await (await req.response())?.body();
    fonts.push({ path: url.pathname.replace(/^\/fonts\/[^/]+\//, ""), bytes: body?.length ?? 0 });
  });
  const up = page.waitForEvent("console", { predicate: (m) => m.text().includes("console up"), timeout: 60_000 });
  await page.goto(`${origin}/index.html?ui=console`);
  await up;
  last = Date.now();
  while (Date.now() - last < QUIET_MS) await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `cjk-${c.name}.png`) });
  await context.close();
  return { fonts, logs };
}

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error(`${DIST} has no index.html — run \`npm run build\` first`);
  await mkdir(OUT, { recursive: true });
  const server = staticServer(DIST);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    // The console is Skia on WebGL2; with no GPU, SwiftShader draws it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
  });
  try {
    for (const c of CASES) {
      const { fonts, logs } = await run(browser, origin, c);
      const paths = fonts.map((f) => f.path);
      const bytes = fonts.reduce((n, f) => n + f.bytes, 0);
      console.log(`${c.name}: ${fonts.length} font requests, ${bytes} bytes${paths.length ? `: ${paths.join(" ")}` : ""}`);
      for (const line of logs.filter((l) => /font|CJK/.test(l))) console.log(`  page: ${line}`);
      assert.ok(!logs.some((l) => l.includes("console font not added")), `${c.name}: the console refused a slice`);
      assert.ok(!logs.some((l) => l.includes("did not load")), `${c.name}: a slice did not load`);
      assert.equal(new Set(paths).size, paths.length, `${c.name}: a font file was fetched twice`);
      if (!c.fonts) {
        assert.deepEqual(paths, [], `${c.name}: fetched fonts for a name Geist draws`);
        continue;
      }
      assert.ok(paths.includes("jp/ranges.json"), `${c.name}: no Japanese ranges`);
      for (const want of slicesOf(c.label)) assert.ok(paths.includes(want), `${c.name}: ${want} not fetched`);
      assert.ok(paths.every((p) => p.startsWith("jp/")), `${c.name}: fetched another family`);
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  console.log(`cjk fonts: every case passed → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

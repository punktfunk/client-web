// The Samsung TV package's icon, 512×423 as the catalog wants it: the lens mark from
// `src/ui/brand.tsx` on the page's own ground, rendered once by Chromium and committed as
// `tizen/icon.png`. Run again only when the mark changes:
//
//   node tools/tizen-icon.mjs            (Playwright's Chromium; `npx playwright install chromium`)

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const LIGHT =
  "M403.037,791.672c107.586,0 194.41,-86.824 194.41,-194.41c0,-107.586 -86.824,-194.41 -194.41,-194.41c-107.586,0 -194.41,86.824 -194.41,194.41c0,107.586 86.824,194.41 194.41,194.41Z";
const DEEP =
  "M735.276,540.321c76.075,-76.075 76.075,-198.862 0,-274.937c-76.075,-76.075 -198.862,-76.075 -274.937,0c-76.075,76.075 -76.075,198.862 0,274.937c76.075,76.075 198.862,76.075 274.937,0Z";
const OVERLAP =
  "M647.84,590.737c-64.853,17.403 -136.871,0.597 -187.885,-50.416c-51.013,-51.013 -67.819,-123.032 -50.416,-187.885c64.853,-17.403 136.871,-0.597 187.885,50.416c51.013,51.013 67.819,123.032 50.416,187.885Z";

const html = `<!doctype html><html><body style="margin:0;background:#0b0b0d;width:512px;height:423px;display:grid;place-items:center">
<svg viewBox="150 190 650 620" width="340" height="324" aria-hidden="true">
  <path d="${LIGHT}" fill="#a79ff8"/><path d="${DEEP}" fill="#6c5bf3"/><path d="${OVERLAP}" fill="#d2c9fb"/>
</svg></body></html>`;

const out = fileURLToPath(new URL("../tizen/icon.png", import.meta.url));
const executablePath = process.env["PF_CHROMIUM"];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 512, height: 423 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 512, height: 423 } });
await browser.close();
console.log(`icon: ${out}`);

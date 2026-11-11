// The app's bundler. The wasm module is `@punktfunk/stream`'s concern: the engine imports
// emscripten's glue lazily, and the glue finds its `.wasm` through `new URL(…, import.meta.url)`,
// which Vite turns into an emitted asset. Nothing here names either file.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const devHost = process.env["PF_HOST"];

/** Noto Sans CJK per Han region, Regular, as `@fontsource` slices it by unicode-range. */
const CJK_PACKAGES = { jp: "noto-sans-jp", kr: "noto-sans-kr", sc: "noto-sans-sc", tc: "noto-sans-tc" };
const require = createRequire(import.meta.url);
const cjkPackage = (name: string) => dirname(require.resolve(`@fontsource/${name}/package.json`));
const cjkVersions = Object.values(CJK_PACKAGES).map(
  (name) => (JSON.parse(readFileSync(join(cjkPackage(name), "package.json"), "utf8")) as { version: string }).version,
);
/** Where the slices go, relative to the page. The version is in the path: a cached slice never
 *  meets a newer version's ranges. */
const CJK_DIR = `fonts/cjk-${[...new Set(cjkVersions)].join("-")}/`;

/**
 * The CJK slices as static files beside the page, never in a bundle: `<family>/<n>.woff` and
 * `<family>/ranges.json`, each slice's unicode-range, plus the fonts' licence. The latin, cyrillic
 * and vietnamese slices are left out: Geist draws those. The console fetches a slice only when it
 * draws a char in it (`src/ui/cjk-font.ts`). WOFF, not WOFF2: the wasm Skia's FreeType reads it
 * as it is, and has no Brotli for WOFF2.
 */
function cjkFonts(): Plugin {
  const files = new Map<string, () => Buffer | string>();
  for (const [family, name] of Object.entries(CJK_PACKAGES)) {
    const dir = cjkPackage(name);
    const unicode = JSON.parse(readFileSync(join(dir, "unicode.json"), "utf8")) as Record<string, string>;
    const ranges: Record<string, string> = {};
    for (const [key, range] of Object.entries(unicode)) {
      const n = /^\[(\d+)\]$/.exec(key)?.[1];
      if (n === undefined) continue;
      ranges[n] = range;
      files.set(`${CJK_DIR}${family}/${n}.woff`, () => readFileSync(join(dir, "files", `${name}-${n}-400-normal.woff`)));
    }
    files.set(`${CJK_DIR}${family}/ranges.json`, () => JSON.stringify(ranges));
  }
  files.set(`${CJK_DIR}LICENSE`, () => readFileSync(join(cjkPackage(CJK_PACKAGES.jp), "LICENSE")));
  return {
    name: "punktfunk-cjk-fonts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.get(decodeURI((req.url ?? "").split("?")[0]!).slice(1));
        if (file) res.end(file());
        else next();
      });
    },
    generateBundle() {
      for (const [fileName, read] of files) this.emitFile({ type: "asset", fileName, source: read() });
    },
  };
}

/** What the settings sheet names this build: the tag or commit, `-dirty` for local edits. */
function version(): string {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  // Relative asset URLs, so the same `dist/` works at a host's root, under a path, or packaged.
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    // The browser's own language list, with no switch: the page has no setting for it.
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      strategy: ["preferredLanguage", "baseLocale"],
    }),
    cjkFonts(),
  ],
  // Through the dev proxy the API answers on the page's origin but the WebTransport plane does
  // not; this tells the engine where it is. Undefined in a real build, so the address the user
  // typed is used — exactly as designed.
  define: {
    __PF_VERSION__: JSON.stringify(version()),
    // A page that measures what the console's tiers cost on the device it runs on.
    __PF_BENCH__: JSON.stringify(process.env["PF_BENCH"] === "1"),
    // Where that page also posts its tables: a collector on the desk, for a set across the room.
    __PF_BENCH_REPORT__: JSON.stringify(process.env["PF_BENCH_REPORT"]),
    __PF_TRANSPORT_HOST__: JSON.stringify(devHost ? new URL(devHost).hostname : undefined),
    __PF_CJK_FONTS__: JSON.stringify(CJK_DIR),
  },
  resolve: {
    alias: {
      // The library from source, as `tsconfig.json` does for the types: the workspace's own
      // consumer follows the engine without a build in between.
      "@punktfunk/stream": fileURLToPath(new URL("../../packages/stream/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // What the wasm and WebCodecs already require; nothing older can run this page anyway.
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Development against a real host without accepting its certificate first: `PF_HOST` names
    // it, and the dev server answers `/api` on the page's own origin. Only the dev server does
    // this — a built page talks to the host it was pointed at, cross-origin, as designed.
    ...(devHost
      ? {
          proxy: {
            "/api": { target: devHost, changeOrigin: true, secure: false },
            // The end-to-end harness posts its findings here; a collector listens during a run.
            "/report": { target: "http://127.0.0.1:8099" },
          },
        }
      : {}),
  },
});

// The app's bundler. The wasm module is `@punktfunk/stream`'s concern: the engine imports
// emscripten's glue lazily, and the glue finds its `.wasm` through `new URL(…, import.meta.url)`,
// which Vite turns into an emitted asset. Nothing here names either file.
//
// `--mode tizen` builds the same page as a Samsung TV package: `dist-tizen/` with the widget's
// `config.xml` and icon beside `index.html`, no source maps, and Samsung's `webapis.js` on the
// page. `tools/wgt.mjs` zips that directory into the `.wgt`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const devHost = process.env["PF_HOST"];

/** What the settings sheet names this build: the tag or commit, `-dirty` for local edits. */
function version(): string {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** The numeric part of the version, which is all a widget's `version` may hold: `0.3.0` from
 *  `v0.3.0-12-gabcdef`, and `0.0.1` for a build with no tag behind it. */
function widgetVersion(described: string = version()): string {
  return /\d+\.\d+\.\d+/.exec(described)?.[0] ?? "0.0.1";
}

/** The package's own files beside the page: `config.xml` at this build's version, the icon, and
 *  Samsung's `webapis.js`, whose path exists only on the set and so is never bundled. */
function tizenPackage(): Plugin {
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  return {
    name: "punktfunk-tizen",
    transformIndexHtml: {
      order: "post",
      handler: (html) => ({
        html,
        tags: [{ tag: "script", attrs: { src: "$WEBAPIS/webapis/webapis.js" }, injectTo: "head-prepend" }],
      }),
    },
    generateBundle() {
      const config = readFileSync(here("./tizen/config.xml"), "utf8").replace(
        /version="[^"]*"/,
        `version="${widgetVersion()}"`,
      );
      this.emitFile({ type: "asset", fileName: "config.xml", source: config });
      this.emitFile({ type: "asset", fileName: "icon.png", source: readFileSync(here("./tizen/icon.png")) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const tizen = mode === "tizen";
  return {
    // Relative asset URLs, so the same `dist/` works at a host's root, under a path, or packaged.
    base: "./",
    plugins: [react(), tailwindcss(), ...(tizen ? [tizenPackage()] : [])],
    // Through the dev proxy the API answers on the page's origin but the WebTransport plane does
    // not; this tells the engine where it is. Undefined in a real build, so the address the user
    // typed is used — exactly as designed.
    define: {
      __PF_VERSION__: JSON.stringify(version()),
      __PF_TRANSPORT_HOST__: JSON.stringify(devHost ? new URL(devHost).hostname : undefined),
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
      outDir: tizen ? "dist-tizen" : "dist",
      emptyOutDir: true,
      // What the wasm and WebCodecs already require; nothing older can run this page anyway.
      target: "es2022",
      // A package ships to a set with no devtools to read a map, and the maps are half its size.
      sourcemap: !tizen,
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
  };
});

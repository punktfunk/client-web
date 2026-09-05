// The app's bundler. Vite is for the page; tsc still runs first because `build/pf-glue.js` is an
// input to the wasm link, and the wasm module itself is never bundled — it is a static asset.
//
// `public/` holds the two files emscripten produced (`punktfunk-client-web.js`, the `.wasm`).
// They are copied there by `build.sh` and served untouched: the glue is a self-contained classic
// script that loads its own `.wasm` by a relative URL, and re-processing it would break exactly
// that. Everything else — the app, the SDK, Effect — is bundled from source.

import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  publicDir: "../public",
  build: {
    outDir: "../dist",
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
    proxy: process.env["PF_HOST"]
      ? {
          "/api": { target: process.env["PF_HOST"], changeOrigin: true, secure: false },
          // The end-to-end harness posts its findings here; a collector listens during a run.
          "/report": { target: "http://127.0.0.1:8099" },
        }
      : undefined,
  },
});

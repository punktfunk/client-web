// The app's bundler. The wasm module is `@punktfunk/stream`'s concern: the engine imports
// emscripten's glue lazily, and the glue finds its `.wasm` through `new URL(…, import.meta.url)`,
// which Vite turns into an emitted asset. Nothing here names either file.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // The library from source, as `tsconfig.json` does for the types: the workspace's own
    // consumer follows the engine without a build in between.
    alias: {
      "@punktfunk/stream": fileURLToPath(new URL("../../packages/stream/src/index.ts", import.meta.url)),
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
    ...(process.env["PF_HOST"]
      ? {
          proxy: {
            "/api": { target: process.env["PF_HOST"], changeOrigin: true, secure: false },
            // The end-to-end harness posts its findings here; a collector listens during a run.
            "/report": { target: "http://127.0.0.1:8099" },
          },
        }
      : {}),
  },
});

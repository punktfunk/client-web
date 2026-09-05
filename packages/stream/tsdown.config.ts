// The library build. The wasm module is NOT an input here: `build.sh` puts emscripten's two
// files in `wasm/`, the engine imports the glue lazily, and tsdown keeps that as a separate
// chunk with its `new URL(".wasm", import.meta.url)` intact. So the `.wasm` has to sit beside
// the chunks in `dist/` — `build.sh` copies it there — and a consumer's bundler (Vite does)
// then treats it as an asset. Nothing is fetched until the first `Engine.create()`.

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "browser",
  format: "esm",
  dts: true,
  sourcemap: true,
  clean: true,
  // Both come from the consumer: Effect must be one instance per page, and the SDK is the thing
  // this library is a consumer of, not a vendor of.
  external: ["effect", /^effect\//, /^@punktfunk\/host/],
});

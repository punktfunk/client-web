# @punktfunk/stream

**The punktfunk browser engine, as a library.** WebTransport session, device-key pairing, WebCodecs
video onto a canvas you give it, and the management API through `@punktfunk/host` — with no DOM
and no framework. The web client in this repo is its first consumer; the website, a Steam Deck
plugin or a TV app can be the next.

```ts
import { Engine } from "@punktfunk/stream";

const engine = await Engine.create({ videoCanvas });   // loads the wasm now, not at import
engine.onState((s) => {
  switch (s.kind) {
    case "blocked":        // open s.acceptUrl once, then engine.connect(origin) again
    case "needs-pairing":  // engine.pair(pin)
    case "ready":          // s.host.library(), then engine.startStream({ width, height })
    case "streaming":      // s.stats.fps, s.stats.dropped, s.stats.backend
  }
});
await engine.connect("192.168.1.25");
```

The state carries facts, never wording, so any interface can sit on it. What each fact means
and what a person can do about it is documented on `EngineState`.

## Install

```ini
# .npmrc — the @punktfunk scope lives on the unom Gitea registry; reads are anonymous
@punktfunk:registry=https://git.unom.io/api/packages/unom/npm/
```

```sh
npm i @punktfunk/stream @punktfunk/host effect@4.0.0-beta.98
```

`effect` and `@punktfunk/host` are peers in all but name: this library is a consumer of the SDK,
not a vendor of it, and Effect must be one instance per page.

## What ships

`dist/index.js` is small. The wasm module — emscripten's glue as a lazy chunk, and the `.wasm`
beside it — is loaded on the first `Engine.create()` and never on import, so a page that only
shows a host picker does not pay for it. The glue finds its binary through
`new URL("….wasm", import.meta.url)`, which every bundler turns into an asset; Vite is what this
repo verifies with.

## Building it

Needs emsdk **4.0.9** activated (`emcc` on `PATH`, `EMSDK` exported) and the
`wasm32-unknown-emscripten` Rust target. `./build.sh` builds the wasm module into `wasm/`;
`npm run build:lib` (tsdown) packages the library. The repo README has the toolchain detail and
why Skia is built from source here.

## Not yet

- The microphone: host → browser audio plays, browser → host is the same plane the other way
  (`0xCB`) and is not written.
- Latency and packet loss on `SessionStats`. The fields are there; only decoder drops are filled
  in.
- Codec and HDR, both pinned in `rust/session.rs` — choosing either needs the wire, not an option.

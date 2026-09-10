<p align="center">
  <img src="assets/logo/logo-sidebar.png" alt="punktfunk" width="300">
</p>

<p align="center">
  <a href="https://github.com/punktfunk/client-web/actions/workflows/ci.yml"><img src="https://github.com/punktfunk/client-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT%2FApache--2.0-d2c9fb" alt="License: MIT or Apache-2.0"></a>
</p>

<p align="center"><b>Browser client for <a href="https://git.unom.io/unom/punktfunk">punktfunk</a> — the console and low-latency video, in a tab.</b></p>

---

Point a tab at a punktfunk host and stream your desktop or a game. No install, no extension, no
plugin: WebTransport carries the same `punktfunk/1` datagrams a native client gets, WebCodecs
decodes them, and the picture lands on a canvas — a decoded frame goes straight into a texture and
never enters the wasm heap.

📖 **[docs.punktfunk.unom.io](https://docs.punktfunk.unom.io)** —
[How it works](https://docs.punktfunk.unom.io/docs/how-it-works) ·
[Pairing](https://docs.punktfunk.unom.io/docs/pairing) ·
[Install a host](https://docs.punktfunk.unom.io/docs/install)

💬 [Discord](https://discord.gg/kaPNvzMuGU) · 🔒 Vulnerabilities go privately to
**security@punktfunk.com**, not to an issue.

The protocol is not reimplemented anywhere here: handshake, FEC, decrypt, reassembly and the
SPAKE2 pairing ceremony are [`punktfunk-core`](https://git.unom.io/unom/punktfunk)'s, a pinned git
dependency compiled to wasm. The management API is consumed through the SDK generated from the
host's own OpenAPI spec.

## What ships

| | |
|---|---|
| [`packages/stream`](packages/stream) — **`@punktfunk/stream`** | The engine, as a library: WebTransport session, device-key pairing, WebCodecs video and audio, input, the management API through `@punktfunk/host`. No DOM, no framework. Rust (`rust/`) compiled to wasm underneath, TypeScript (`src/`) on top. |
| [`apps/web`](apps/web) | The web client on it — the flagship consumer. The page, two interfaces, the wording. |

## What works

- **Hosts by address, then PIN pairing**, with the pinned fingerprint on each card — the fact a
  person compares against the host's own screen. Rename and forget are per host.
- **Video** — WebCodecs into a WebGL2 plane, or WebGPU where the page asks for it, which is the
  only route that carries HDR.
- **Audio** — the host's Opus plane demuxed off the same datagram flow, a lost frame rebuilt from
  its RED copy, decoded by the browser and played from a short ring on the audio thread.
- **Input** — keyboard, pointer (absolute, or relative under pointer lock for games), wheel, touch
  and gamepads, encoded by core as the bytes a native client sends.
- **The library** — the host's grid, and picking a title carries its id in `Hello`, so the host
  opens it rather than streaming the desktop.
- **Settings that persist** — size, frame rate, bitrate, video plane, audio, input capture, mouse
  mode, deadzone.
- **Two interfaces on one state machine** — the React web shell, and `?ui=console`, the same
  `pf-console-ui` shell every other punktfunk client draws.

Needs a browser with WebTransport and WebCodecs; verified against a real host on Safari 27.

## Trust, and the one step it costs you

A punktfunk host signs its own certificate. No browser will let a page `fetch` such a host — not
with CORS relaxed, not with `no-cors`, which fails the same way because the connection never
completes. **So the first time you connect to a host, the page sends you to accept it once**
(`https://<host>:47990/api/v1/health`), and after that the exception is your browser's.

From there:

1. `GET /api/v1/webtransport` publishes the port and the certificate hash to pin. It is
   unauthenticated and has to be — a browser that has never paired holds no credential — so a
   first connection is trust-on-first-use, exactly as a native client's is.
2. **Pairing is what proves the host.** SPAKE2 over the PIN it shows, with the browser's identity
   being a **non-extractable P-256 key** it generates and keeps in IndexedDB, and the host's being
   the certificate hash the page had to pin in order to connect at all.
3. Afterwards it is no longer trust-on-first-use. Pairing stores the host's long-lived
   fingerprint, and the host signs its short-lived WebTransport certificate with that identity —
   so the page **verifies the attestation before it dials** and refuses a host that cannot produce
   it.
4. Each session opens with a nonce the browser signs, bound to that certificate hash, so a
   captured response is worthless on any other connection.

**The honest limit:** mTLS binds every packet to a client certificate continuously; this
authenticates once per session at the control handshake, with WebTransport's own TLS and the
negotiated session key covering the rest.

**The private key is the pairing.** It lives in IndexedDB, non-extractable — a script that reads
the store gets something that cannot sign. Clearing site data unpairs this browser, and a private
window is a new device every time.

## Build

Needs [emsdk **4.0.9**](https://emscripten.org) activated (`emcc` on `PATH`, `EMSDK` exported) and
the `wasm32-unknown-emscripten` Rust target.

```sh
rustup target add wasm32-unknown-emscripten
npm install           # @punktfunk/host and @unom/ui come from the Gitea registry; .npmrc names both scopes
npm run build         # the library, then the app
```

The app lands in `apps/web/dist/`, a static directory to serve from anywhere. The library lands
in `packages/stream/dist/`, which is what `npm pack` ships.

Four tools, each for what it is for, in this order:

1. **`tsc`** emits one file, `packages/stream/build/pf-glue.js` — an *input* to the wasm link,
   which emscripten reads with `--js-library`.
2. **`cargo`** builds the wasm module into `packages/stream/wasm/`, as an ES module with a
   default-exported factory.
3. **tsdown** packages the library. The glue becomes a lazy chunk with its
   `new URL("….wasm", import.meta.url)` intact, and the `.wasm` is copied beside it.
4. **Vite** builds the app from source — the library through a workspace alias, the SDK, Effect —
   and turns the library's wasm reference into an emitted asset.

For development against a real host without accepting its certificate first:

```sh
PF_HOST=https://192.168.1.25:47990 npm run dev
```

The dev server answers `/api` on the page's own origin. Only the dev server does this — a built
page talks to the host it was pointed at, cross-origin, as designed. Through a proxy the
WebTransport plane is not at the page's hostname; `Engine.create({ transportHost })` says where.

### Why Skia is built, not downloaded

The one target where `skia-safe`'s prebuilt does not work. rust-skia's published wasm archives —
0.99.0 and 0.153.2 alike — are compiled for **emscripten** exception handling, while Rust's
`wasm32-unknown-emscripten` std has used **wasm** exception handling since 1.87. They cannot be
linked: with the prebuilt the link ends in `undefined symbol: emscripten_longjmp`, and dropping
rustc's `-fwasm-exceptions` to meet it halfway ends in `undefined symbol: __cpp_exception` from
libstd instead.

`build.sh` builds Skia with `EMCC_CFLAGS=-fwasm-exceptions` and caches the result under
`~/.cache/punktfunk/skia-wasm/`, so the 30-minute cost is paid once per machine and every later
build downloads it. Re-check at each `skia-safe` bump: if rust-skia ever publishes a wasm-EH
archive, delete this whole arrangement.

## Shape

Rust owns the protocol; TypeScript owns the browser. The library owns everything but the words.

**`packages/stream`**

| File | What it is |
|---|---|
| `rust/main.rs` | Entry point. Off wasm it prints how to build; on wasm it hands the page the loop. |
| `rust/host.rs` | Skia `DirectContext` over the canvas, the `Console`, the exported `pf_*` calls. |
| `rust/transport.rs` | The datagram ring and `punktfunk_core`'s `Transport` over it. |
| `rust/session.rs` | The handshake state machine and the pump that turns datagrams into access units. |
| `rust/audio.rs` | The Opus plane: demuxed off the ring, RED-rebuilt, released in order. |
| `rust/input.rs` | Keys, pointer and pads out as core's `InputEvent`s and gamepad snapshots. |
| `rust/credential.rs` | The device key's protocol half: SPAKE2 role A, and the per-session signature. |
| `rust/ecdsa.rs` | WebCrypto's raw `r \|\| s` against the DER the host speaks. |
| `src/engine.ts` | **The library's surface.** `Engine.create()`, the state machine, the verbs. Facts, never wording. |
| `src/index.ts` | What the package exports. |
| `src/pf-connect.ts` | Reaching a host, and checking its attestation before dialling. |
| `src/host.ts` | The management API **through `@punktfunk/host/core`**. Effect stops at this file's edge. |
| `src/video.ts` | `VideoDecoder` in, `VideoFrame` onto the plane. The only file that knows WebCodecs video. |
| `src/video-surface.ts` | The video plane, WebGL2. |
| `src/video-surface-webgpu.ts` | The same seam on WebGPU — `importExternalTexture`, and the only HDR route either engine ships. |
| `src/audio.ts` | `AudioDecoder` in, an `AudioWorklet` out. Suspended until a gesture, because a browser will not play sound unasked. |
| `src/input.ts` | The only file that reads a `KeyboardEvent`, a `PointerEvent` or `navigator.getGamepads()`. |
| `src/settings.ts` | What this browser prefers, in `localStorage` beside the known hosts. |
| `src/pf-glue.ts` | Emscripten `--js-library`. **The only file that names a browser or GL object.** |
| `src/emscripten.d.ts` | The wasm exports and the `--js-library` scope, typed once. |

**`apps/web`**

| File | What it is |
|---|---|
| `src/app.ts` | `EngineState` in, `Screen` out: the wording, the choice of interface, the library's art. |
| `src/ui/types.ts` | The `Screen` a UI renders and the `Actions` it may emit. The seam between the two interfaces. |
| `src/ui/shell.tsx` | The web-native interface, on React: `WebShell` is one external store of `Screen`, a component per kind, one live region. The default. |
| `src/ui/{home,sheets,library,hud,settings}.tsx` | The screens, one file per shape. `pieces.tsx` is what they share. |
| `src/ui/console.ts` | The gamepad interface: `pf-console-ui` on a canvas, through `engine.console`. `?ui=console`. |
| `src/ui/{fixtures.ts,screens.stories.tsx}` | Every `Screen` as a fixture, and the stories both harnesses render from it. |
| `src/components/ui/*` | `@unom/ui` adapted to this app's tokens once — the management console's arrangement, and its corrections. |
| `src/styles.css` | Tailwind, and the brand token contract both `@unom/ui` and the shadcn vocabulary read. |

`src/pf-glue.ts` is load-bearing, not a detail, and it has a constraint the others do not:
emscripten **stringifies each function** and splices it into the module it generates, so anything
outside a function body is left behind — a module-scope `const`, a tsc helper, a captured
temporary — and the failure is a `ReferenceError` at runtime rather than a build error. It never
imports; shared state goes through a `$`-prefixed library member, which is emscripten's own
mechanism for exactly that. `tsconfig.base.json` keeps the emit literal.

Exactly one seam may know the graphics API, which is what makes the eventual WebGPU swap a change
to one file instead of a rewrite. **Nothing in `rust/` may name a GL or GPU type**; that is a
review rule.

## Two interfaces

The shell every other punktfunk client draws is `pf-console-ui`: Skia on a canvas, navigated with
a D-pad. It is the right thing across a room with a controller and the wrong thing in a browser
tab, where the input is a mouse and the first thing anyone must do is **type an address** — which
a gamepad shell cannot offer at all.

So there are two, and `src/ui/types.ts` is what keeps that from being a fork. `app.ts` holds the
entire state machine and hands a UI a `Screen` to render; a UI hands back an `Action`. Neither
renderer knows anything about pairing, trust or the session.

```
?ui=console  →  ConsoleUi   the gamepad shell, for a TV or a controller
(default)    →  WebShell    DOM, pointer, touch, responsive
```

`ConsoleUi` composes the web shell rather than replacing it: the screens where someone has to type
stay DOM, and the canvas takes over once a session is live. That is honest about what a D-pad
shell can and cannot do, and it is why adding the second interface cost one file.

The web shell is the same stack as the host's management console — **React, `@unom/ui` for every
control, Tailwind on the shared brand tokens** — so a button here and a button there are one
component on one palette. It carries one `aria-live` region every screen speaks through, focus
lands on the field each screen is about, errors are `role="alert"`, and the library grid takes
arrow keys — a grid someone can only tab through one tile at a time is not really a grid.

## The management API, done the way it is meant to be

This client consumes the host's API through **[`@punktfunk/host`](https://git.unom.io/unom/punktfunk/src/branch/main/sdk)**,
the SDK generated from the host's OpenAPI spec into Effect Schemas and a typed client. Nothing
in `src/` names an API path or hand-writes a JSON shape: every operation is a method, every
response is decoded through its Schema, and if the host's API changes this client finds out by
failing to compile against the regenerated SDK. That is the whole reason to consume it rather
than `fetch`.

Authentication is the SDK's `deviceKey` credential: the host issues a nonce, the device key
signs it bound to the host's own identity, and the exchange returns a short-lived token that the
SDK's `HttpClient` layer attaches and re-earns on 401. The signing is never in this client either
— the wasm glue hands over a `Signer` and keeps the non-extractable key.

`/core` is the SDK entry with nothing Node in it, and a test in the SDK walks its import graph
to keep it that way. Effect is used for what it is good at — the client, the schemas, the
credential — and stops at `host.ts`: the app holds a plain `Screen` and neither renderer imports
`effect`.

## Tests

The credential and signature halves are **not** wasm-gated, so they build and run on a desktop —
and the SPAKE2 half runs against the host's own role B, which is the divergence worth catching:

```sh
npm run check                            # tsc --noEmit in both packages; stripping types does not check them
npm test                                 # node runs the .ts tests directly, no build step
npm run storybook -w punktfunk-web       # every screen, from the fixtures, with no engine behind it
cd packages/stream && cargo test         # the credential ceremony against the host's own SPAKE2 role B
```

CI runs all four plus the real build. `pf-connect.test.ts` checks the attestation verifier against
bytes a real host produced, because the two languages agreeing is the part that fails silently.
The Storybook build is a gate: the stories stub the lazy wasm import, so the shell renders on
every push without an emscripten toolchain.

The gate that matters most is not a unit test: a consumer that has never seen this workspace
installs `@punktfunk/stream` from `npm pack`'s tarball, and streams. That is what proves the
packaging — the lazy wasm, the asset reference, the peers — and it was run against a live host
on Safari before the split was called done.

## Known gaps

- **The microphone does not go back.** Host → browser audio plays; browser → host is the same
  plane the other way (`0xCB`) and is not written yet.
- **Latency and packet loss are not reported.** `SessionStats` has the fields; only decoder drops
  are filled in, so the quality dot is coarse rather than wrong.
- **Codec and HDR are pinned** in `rust/session.rs`. Choosing either needs the wire, not a
  control.
- **Resize renegotiation is off by default.** The observer is hard-debounced and the host rebuilds
  its capture to answer, so the picture scales until you ask for a fresh mode.
- **Settings are global, not per host.** Two hosts wanting different bitrates from one browser is
  the case that would justify doubling the surface, and no one has hit it.
- **Set `-sSTACK_SIZE`** if you change the link flags. Emscripten's default is 64 KB, which a
  session overflows just by being constructed — and the symptom is `RuntimeError: Out of bounds
  memory access` from *every* export, including ones that do nothing. It reads like a corrupt
  module, not a stack overflow.
- The release payload is around **8 MB of wasm**. The live heap under a stream is unmeasured.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), matching upstream
punktfunk, at your option — `SPDX-License-Identifier: MIT OR Apache-2.0`.

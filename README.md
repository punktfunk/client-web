# punktfunk client-web

**Browser client for [punktfunk](https://git.unom.io/unom/punktfunk) — the console and low-latency
video, in a tab.**

`pf-console-ui` compiled to `wasm32-unknown-emscripten` draws the shell on a WebGL2 canvas;
WebTransport carries the session and WebCodecs decodes it. The protocol is not reimplemented here:
handshake, FEC, decrypt, reassembly and the SPAKE2 pairing ceremony are `punktfunk-core`'s, a
pinned git dependency. This repo is the browser-specific half — the canvases, the decoder, the
device credential and the page.

Built on the punktfunk project by **Enrico Bühler ([unom](https://unom.io))**.

## Status

Video streams and pairing works, verified against a real host on Safari 27. Audio, input and the
console's live data are not wired yet.

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
./build.sh            # or --release
```

The result is a servable directory in `dist/`. Serve it from anywhere; it is static.

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

| File | What it is |
|---|---|
| `src/main.rs` | Entry point. Off wasm it prints how to build; on wasm it hands the page the loop. |
| `src/host.rs` | Skia `DirectContext` over the canvas, the `Console`, the exported `pf_*` calls. |
| `src/transport.rs` | The datagram ring and `punktfunk_core`'s `Transport` over it. |
| `src/session.rs` | The handshake state machine and the pump that turns datagrams into access units. |
| `src/credential.rs` | The device key's protocol half: SPAKE2 role A, and the per-session signature. |
| `src/ecdsa.rs` | WebCrypto's raw `r \|\| s` against the DER the host speaks. |
| `web/index.html` | The two canvases, the host picker, pairing, the `requestAnimationFrame` loop. |
| `web/pf-connect.js` | Reaching a host, and checking its attestation before dialling. |
| `web/video-surface.js` | The video plane, WebGL2. |
| `web/video-surface-webgpu.js` | The same seam on WebGPU — `importExternalTexture`, and the only HDR route either engine ships. |
| `web/pf-glue.js` | Emscripten `--js-library`. **The only file that names a browser or GL object.** |

`web/pf-glue.js` is load-bearing, not a detail. Exactly one seam may know the graphics API, and
this is it — which is what makes the eventual WebGPU swap a change to one file instead of a
rewrite. **Nothing in `src/` may name a GL or GPU type**; that is a review rule.

Video pixels never enter the wasm heap either. A decoded `VideoFrame` goes from `VideoDecoder`
straight into a texture, and Rust only ever handles the encoded access unit as a `(ptr, len)`.

## Tests

The credential and signature halves are **not** wasm-gated, so they build and run on a desktop —
and the SPAKE2 half runs against the host's own role B, which is the divergence worth catching:

```sh
cargo test
node --test web/pf-connect.test.js
```

`pf-connect.test.js` checks the attestation verifier against bytes a real host produced, because
the two languages agreeing is the part that fails silently.

## Known gaps

- **Audio, input and the console's real data are missing.** Video only, for now.
- **Set `-sSTACK_SIZE`** if you change the link flags. Emscripten's default is 64 KB, which a
  session overflows just by being constructed — and the symptom is `RuntimeError: Out of bounds
  memory access` from *every* export, including ones that do nothing. It reads like a corrupt
  module, not a stack overflow.
- The release payload is around **8 MB of wasm**. The live heap under a stream is unmeasured.

## License

MIT or Apache-2.0, at your option.

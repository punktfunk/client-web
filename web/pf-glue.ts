// The one file that names a browser or graphics object. Emscripten links it with `--js-library`,
// so these functions run inside the module's own scope — which is where `GL`, emscripten's WebGL
// bookkeeping, lives. Nothing in `src/` may name a GL or GPU type, and that is a review rule.
//
// ⚠ **This file is not imported by anything and must never import.** Emscripten stringifies each
// function and splices it into the module it generates, so anything outside a function body is
// left behind: a module-scope `const`, a tsc helper, a captured temporary. The failure is a
// `ReferenceError` at runtime, not a build error. `tsconfig.json` keeps the emit literal
// (ES2022, no helpers); everything shared between these functions goes through a `$`-prefixed
// library member instead, which is emscripten's own mechanism for exactly this.
//
// The declarations for `mergeInto`, `Module`, `HEAPU8` and friends are in `emscripten.d.ts`.

interface PfNet {
  wt: WebTransport | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  ctl: WritableStreamDefaultWriter<Uint8Array> | null;
  reading: boolean;
}

interface PfCred {
  key: CryptoKeyPair | null;
  load(): Promise<CryptoKeyPair>;
  db(): Promise<IDBDatabase>;
}

declare const pfNet: PfNet;
declare const pfCred: PfCred;

mergeInto(LibraryManager.library, {
  // Bring up a WebGL2 context on the UI canvas and make it current for emscripten's GL layer.
  // Returns 1 on success, 0 if the browser gave us no WebGL2. Idempotent: a second call just
  // re-makes the existing context current.
  pf_gl_setup: function (): number {
    const mod = Module as unknown as { __pfUiCtx?: number };
    if (mod.__pfUiCtx) {
      GL.makeContextCurrent(mod.__pfUiCtx);
      return 1;
    }
    const canvas = document.getElementById("pf-ui") as HTMLCanvasElement | null;
    if (!canvas) return 0;
    // `alpha: true` is what lets the video canvas show through wherever the console draws
    // nothing. `antialias: false` because Skia does its own; `depth`/`stencil` off because
    // `wrap_backend_render_target` asks for neither.
    const handle = GL.createContext(canvas, {
      majorVersion: 2,
      minorVersion: 0,
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      // The console is redrawn every frame from scratch; a discrete GPU is the right ask on a
      // laptop that has both, since this canvas is composited with decoded video.
      powerPreference: "high-performance",
    });
    if (!handle) return 0;
    GL.makeContextCurrent(handle);
    mod.__pfUiCtx = handle;
    return 1;
  },

  // --- the datagram plane ---------------------------------------------------------------------
  //
  // Datagrams never become JavaScript objects that outlive one call. The read loop claims a ring
  // slot from Rust and copies the bytes straight into wasm memory; nothing is allocated per
  // packet on either side. At 4-5k/s a `Uint8Array` per datagram is garbage the collector would
  // be chasing during the stream.
  //
  // `$` marks a JavaScript-only helper (not callable from Rust); `__deps` is how emscripten knows
  // to keep one that only other library members use.
  $pfNet: {
    wt: null,
    writer: null,
    ctl: null,
    reading: false,
  },

  pf_wt_connect__deps: ["$pfNet", "$UTF8ToString"],
  pf_wt_connect: function (urlPtr: number, hashPtr: number): number {
    const url = UTF8ToString(urlPtr);
    const hex = UTF8ToString(hashPtr);
    try {
      const opts: WebTransportOptions = { allowPooling: false };
      if (hex && hex.length === 64) {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        // allowPooling must stay false alongside this: the pair is a TypeError otherwise.
        opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bytes }];
      }
      pfNet.wt = new WebTransport(url, opts);
    } catch (e) {
      console.error("punktfunk: WebTransport constructor refused", e);
      return 0;
    }
    pfNet.wt.ready.then(
      function () {
        // WebKit follows the current spec with `createWritable()`; Chromium still exposes the
        // older `writable` attribute. A client that knows only one fails on the other engine.
        const datagrams = pfNet.wt!.datagrams as unknown as {
          createWritable?: () => WritableStream<Uint8Array>;
          writable: WritableStream<Uint8Array>;
          readable: ReadableStream<Uint8Array>;
        };
        const w = datagrams.createWritable ? datagrams.createWritable() : datagrams.writable;
        pfNet.writer = w.getWriter();
        if (Module._pf_wt_ctl_open) Module._pf_wt_ctl_open();
        if (!pfNet.reading) {
          pfNet.reading = true;
          const pump = function (reader: ReadableStreamDefaultReader<Uint8Array>): void {
            reader.read().then(
              function (r) {
                if (r.done) {
                  pfNet.reading = false;
                  return;
                }
                const slot = Module._pf_rx_claim();
                if (slot >= 0) {
                  HEAPU8.set(r.value, Module._pf_rx_base() + slot * Module._pf_rx_stride());
                  Module._pf_rx_commit(slot, r.value.length);
                }
                pump(reader);
              },
              function () {
                pfNet.reading = false;
              },
            );
          };
          pump(datagrams.readable.getReader());
        }
      },
      function (e) {
        console.error("punktfunk: WebTransport session failed", e);
      },
    );
    return 1;
  },

  pf_wt_send__deps: ["$pfNet"],
  pf_wt_send: function (ptr: number, len: number): number {
    if (!pfNet.writer) return 0;
    // `slice`, not `subarray`: the write is queued, and a view into wasm memory can be detached
    // by a heap growth or overwritten by the next packet before it is read.
    pfNet.writer.write(HEAPU8.slice(ptr, ptr + len)).catch(function () {});
    return 1;
  },

  pf_wt_close__deps: ["$pfNet"],
  pf_wt_close: function (): void {
    if (pfNet.wt) {
      try {
        pfNet.wt.close();
      } catch {
        // Already closed, or never opened. Either way there is nothing to do.
      }
    }
    pfNet.wt = null;
    pfNet.writer = null;
    pfNet.ctl = null;
    pfNet.reading = false;
  },

  // --- the control stream ---------------------------------------------------------------------
  //
  // Same length-prefixed punktfunk/1 messages the native client puts on a quinn stream. Rust owns
  // the codec; this owns the stream. A stream hands over arbitrary chunk boundaries, so whatever
  // arrives goes straight to Rust, which reassembles.
  pf_wt_ctl_open__deps: ["$pfNet"],
  pf_wt_ctl_open: function (): number {
    if (!pfNet.wt || pfNet.ctl) return 0;
    pfNet.wt.createBidirectionalStream().then(
      function (stream) {
        pfNet.ctl = stream.writable.getWriter();
        const pump = function (reader: ReadableStreamDefaultReader<Uint8Array>): void {
          reader.read().then(
            function (r) {
              if (r.done) return;
              const p = _malloc(r.value.length);
              HEAPU8.set(r.value, p);
              Module._pf_ctl_recv(p, r.value.length);
              _free(p);
              pump(reader);
            },
            function () {},
          );
        };
        pump(stream.readable.getReader());
        // Rust sends Hello once the stream exists, not before: the host has nothing to reply on.
        if (Module.__pfOnCtlReady) Module.__pfOnCtlReady();
      },
      function (e) {
        console.error("punktfunk: control stream refused", e);
      },
    );
    return 1;
  },

  pf_wt_ctl_send__deps: ["$pfNet"],
  pf_wt_ctl_send: function (ptr: number, len: number): void {
    if (!pfNet.ctl) return;
    // A copy, for the same reason the datagram writer takes one: the write is queued and a view
    // into wasm memory can be detached by a heap growth before it is read.
    pfNet.ctl.write(HEAPU8.slice(ptr, ptr + len)).catch(function () {});
  },

  // --- the device credential --------------------------------------------------------------
  //
  // A browser has no client certificate, so its identity is a WebCrypto P-256 keypair kept in
  // IndexedDB with `extractable: false` — a script that reads the store gets a handle that can
  // sign but cannot be copied out, and not even this file can read the private half. Rust holds
  // the public SPKI and decides what to sign; everything below is key storage and the two format
  // conversions WebCrypto forces (`r || s` here, DER on the wire — Rust converts).
  $pfCred: {
    key: null,

    // The one keypair, generated on first use and reused forever after. A new key is a new device
    // as far as the host is concerned, so losing it means pairing again.
    load: function (): Promise<CryptoKeyPair> {
      if (pfCred.key) return Promise.resolve(pfCred.key);
      return pfCred.db().then(function (db) {
        return new Promise<CryptoKeyPair | undefined>(function (resolve, reject) {
          const tx = db.transaction("keys", "readonly").objectStore("keys").get("device");
          tx.onsuccess = function () {
            resolve(tx.result as CryptoKeyPair | undefined);
          };
          tx.onerror = function () {
            reject(tx.error);
          };
        }).then(function (found) {
          if (found) {
            pfCred.key = found;
            return found;
          }
          return crypto.subtle
            .generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
            .then(function (pair) {
              return new Promise<CryptoKeyPair>(function (resolve, reject) {
                const tx = db.transaction("keys", "readwrite");
                tx.objectStore("keys").put(pair, "device");
                tx.oncomplete = function () {
                  pfCred.key = pair as CryptoKeyPair;
                  resolve(pair as CryptoKeyPair);
                };
                tx.onerror = function () {
                  reject(tx.error);
                };
              });
            });
        });
      });
    },

    db: function (): Promise<IDBDatabase> {
      return new Promise(function (resolve, reject) {
        const open = indexedDB.open("punktfunk", 1);
        open.onupgradeneeded = function () {
          open.result.createObjectStore("keys");
        };
        open.onsuccess = function () {
          resolve(open.result);
        };
        open.onerror = function () {
          reject(open.error);
        };
      });
    },
  },

  // Load or mint the device key and hand Rust its SPKI plus this connection's certificate hash.
  // Both are needed before anything can be signed: the hash is the channel binding.
  pf_device_init__deps: ["$pfCred", "$UTF8ToString"],
  pf_device_init: function (hashPtr: number): number {
    const hex = UTF8ToString(hashPtr);
    pfCred
      .load()
      .then(function (pair) {
        return crypto.subtle.exportKey("spki", pair.publicKey).then(function (spki) {
          const s = new Uint8Array(spki);
          const hash = new Uint8Array(32);
          for (let i = 0; i < 32; i++) hash[i] = parseInt(hex.substr(i * 2, 2), 16);
          const p = _malloc(s.length + 32);
          HEAPU8.set(s, p);
          HEAPU8.set(hash, p + s.length);
          Module._pf_device_set(p, s.length, p + s.length);
          _free(p);
          if (Module.__pfOnDeviceReady) Module.__pfOnDeviceReady();
        });
      })
      .catch(function (e) {
        console.error("punktfunk: no device key", e);
      });
    return 1;
  },

  // Sign whatever Rust is currently waiting on. WebCrypto returns raw `r || s`; Rust wraps it as
  // DER, which is the only shape the host's verifier accepts.
  pf_device_sign__deps: ["$pfCred"],
  pf_device_sign: function (): number {
    const ptr = Module._pf_cred_sign_ptr();
    const len = Module._pf_cred_sign_len();
    if (!ptr || !len || !pfCred.key) return 0;
    const msg = HEAPU8.slice(ptr, ptr + len);
    crypto.subtle
      .sign({ name: "ECDSA", hash: "SHA-256" }, pfCred.key.privateKey, msg)
      .then(function (sig) {
        const raw = new Uint8Array(sig);
        const p = _malloc(raw.length);
        HEAPU8.set(raw, p);
        Module._pf_cred_signed(p, raw.length);
        _free(p);
      })
      .catch(function (e) {
        console.error("punktfunk: signing failed", e);
      });
    return 1;
  },

  // --- video ----------------------------------------------------------------------------------
  //
  // R3: what crosses is the encoded access unit. The decoded frame goes from `VideoDecoder`
  // straight into the video plane's texture and never enters the wasm heap.
  pf_video_config: function (codec: number, width: number, height: number): void {
    if (Module.__pfOnVideoConfig) Module.__pfOnVideoConfig(codec, width, height);
  },

  pf_video_au: function (ptr: number, len: number, ptsUs: number, key: number): void {
    if (!Module.__pfOnAccessUnit) return;
    // `slice`, not `subarray`: EncodedVideoChunk keeps the bytes past this call, and the Rust
    // buffer is freed the moment we return.
    Module.__pfOnAccessUnit(HEAPU8.slice(ptr, ptr + len), ptsUs, key !== 0);
  },
});

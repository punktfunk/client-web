// The JavaScript inside the wasm module. Emscripten links it with `--js-library`,
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

interface PfCred {
  key: CryptoKeyPair | null;
  load(): Promise<CryptoKeyPair>;
  db(): Promise<IDBDatabase>;
}

declare const pfCred: PfCred;

mergeInto(LibraryManager.library, {
  // Bring up a WebGL2 context on the console's canvas (`EngineOptions.uiCanvas`) and make it
  // current for emscripten's GL layer. Returns 1 on success, 0 without a canvas or WebGL2.
  // Idempotent: a second call just re-makes the existing context current.
  pf_gl_setup: function (): number {
    const mod = Module as unknown as { __pfUiCtx?: number };
    if (mod.__pfUiCtx) {
      GL.makeContextCurrent(mod.__pfUiCtx);
      return 1;
    }
    const canvas = Module.__pfUiCanvas;
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

  // --- the carrier ----------------------------------------------------------------------------
  //
  // How session bytes reach the host lives in `src/carrier/`, as ordinary modules. Rust still
  // calls these, and each hands over to the carrier the engine installed for this dial.
  pf_wt_send: function (ptr: number, len: number): number {
    const c = Module.__pfCarrier;
    // `slice`, not `subarray`: the write is queued, and a view into wasm memory can be detached
    // by a heap growth or overwritten by the next packet before it is read.
    return c && c.sendDatagram(HEAPU8.slice(ptr, ptr + len)) ? 1 : 0;
  },

  pf_wt_close: function (code?: number): void {
    const c = Module.__pfCarrier;
    Module.__pfCarrier = undefined;
    if (c) c.close(code);
  },

  pf_wt_rtt_us: function (): number {
    const c = Module.__pfCarrier;
    return c ? c.rttUs() : 0;
  },

  pf_wt_ctl_open: function (): number {
    const c = Module.__pfCarrier;
    if (!c) return 0;
    c.openControl();
    return 1;
  },

  pf_wt_ctl_send: function (ptr: number, len: number): void {
    const c = Module.__pfCarrier;
    // A copy, for the same reason `pf_wt_send` takes one.
    if (c) c.sendControl(HEAPU8.slice(ptr, ptr + len));
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
          // The management API needs signatures over messages the PAGE composes, not only the
          // ones Rust is waiting on, so the page gets the two operations it needs and nothing
          // more. `pfCred.key.privateKey` is non-extractable: this hands over the ability to
          // sign, never the key.
          Module.__pfDevice = {
            spki: function () {
              return Promise.resolve(btoa(String.fromCharCode.apply(null, Array.from(s))));
            },
            sign: function (message: Uint8Array) {
              return crypto.subtle
                .sign({ name: "ECDSA", hash: "SHA-256" }, pfCred.key!.privateKey, new Uint8Array(message))
                .then(function (sig) {
                  return new Uint8Array(sig);
                });
            },
          };
          if (Module.__pfOnDeviceReady) Module.__pfOnDeviceReady();
        });
      })
      .catch(function (e) {
        console.error("punktfunk: no device key", e);
        if (Module.__pfOnDeviceFailed) Module.__pfOnDeviceFailed();
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
  pf_refused__deps: ["$UTF8ToString"],
  pf_refused: function (code: number, ptr: number, len: number): void {
    // After `pf_ctl_recv` returns: the engine tears the session down in answer, and doing that
    // from inside the call that holds it aborts the module.
    const reason = UTF8ToString(ptr, len);
    queueMicrotask(function () {
      if (Module.__pfOnRefused) Module.__pfOnRefused(code, reason);
    });
  },

  pf_redirect__deps: ["$UTF8ToString"],
  pf_redirect: function (port: number, ptr: number, len: number): void {
    // After `pf_ctl_recv` returns, as `pf_refused`: the engine dials anew in answer.
    const hash = UTF8ToString(ptr, len);
    queueMicrotask(function () {
      if (Module.__pfOnRedirect) Module.__pfOnRedirect(port, hash);
    });
  },

  pf_launch_notice__deps: ["$UTF8ToString"],
  pf_launch_notice: function (ptr: number, len: number): void {
    if (Module.__pfOnLaunchNotice) Module.__pfOnLaunchNotice(UTF8ToString(ptr, len));
  },

  // `slice`: the bitmap is cached past this call, and Rust frees it on return.
  pf_cursor_shape: function (serial: number, w: number, h: number, hx: number, hy: number, ptr: number, len: number): void {
    if (Module.__pfOnCursorShape) Module.__pfOnCursorShape(serial >>> 0, w, h, hx, hy, HEAPU8.slice(ptr, ptr + len));
  },

  pf_video_config: function (codec: number, width: number, height: number, depth: number, hdr: number, fullRange: number): void {
    if (Module.__pfOnVideoConfig) Module.__pfOnVideoConfig(codec, width, height, depth, hdr !== 0, fullRange !== 0);
  },

  // --- audio ----------------------------------------------------------------------------------
  pf_audio_frame: function (ptr: number, len: number, seq: number, ptsNs: number): void {
    if (!Module.__pfOnAudioFrame) return;
    // `slice`: the decoder keeps the bytes past this call, and Rust frees them on return.
    Module.__pfOnAudioFrame(HEAPU8.slice(ptr, ptr + len), seq, ptsNs);
  },

  pf_console_event__deps: ["$UTF8ToString"],
  pf_console_event: function (ptr: number, len: number): void {
    if (!Module.__pfOnConsole) return;
    Module.__pfOnConsole(UTF8ToString(ptr, len));
  },

  pf_rumble: function (pad: number, low: number, high: number, lt: number, rt: number, ms: number): void {
    if (!Module.__pfOnRumble) return;
    Module.__pfOnRumble(pad, low, high, lt, rt, ms);
  },

  pf_video_au: function (ptr: number, len: number, ptsUs: number, key: number, flags: number): void {
    if (!Module.__pfOnAccessUnit) return;
    // A view, not a copy: `EncodedVideoChunk` copies its data as it is built, which `submit` does
    // before this returns and Rust frees the buffer. `flags` crosses as i32; `>>> 0` makes it u32.
    Module.__pfOnAccessUnit(HEAPU8.subarray(ptr, ptr + len), ptsUs, key !== 0, flags >>> 0);
  },
});

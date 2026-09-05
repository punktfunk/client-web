// The emscripten module's shape, declared once so both sides of the boundary are typed.
//
// Two different scopes live in here and they are not interchangeable:
//
//   * `PunktfunkModule` is what `PunktfunkWeb()` resolves to — what the PAGE holds. Every `_pf_*`
//     is a wasm export named in `build.sh`'s `EXPORTED_FUNCTIONS`; adding one here without adding
//     it there gives a typed call to `undefined`.
//   * The `declare global` block below is the scope `pf-glue.ts` runs in. That file is not
//     imported by anything: emscripten reads it with `--js-library` and splices its functions
//     into the generated module, where `GL`, `HEAPU8`, `_malloc` and the `$`-prefixed library
//     members are already in scope. Nothing there may be imported, and nothing outside a function
//     body may be referenced from inside one — see `tsconfig.json`.

export interface PunktfunkModule {
  // --- the console -----------------------------------------------------------------------
  /** Bring up GL, Skia and the shell on a canvas already sized in device pixels. `0` on failure. */
  _pf_start(width: number, height: number): number;
  /** Draw one frame at this size. */
  _pf_frame(width: number, height: number): void;
  /** Index into the console's key table (`KEYS` in `src/host.rs`). */
  _pf_key(key: number, shift: number, repeat: number): void;

  // --- the transport ---------------------------------------------------------------------
  _pf_wt_connect(urlPtr: number, hashPtr: number): number;
  _pf_wt_close(): void;
  _pf_wt_ctl_open(): number;
  _pf_ctl_recv(ptr: number, len: number): void;

  // --- the session -----------------------------------------------------------------------
  _pf_session_hello(width: number, height: number, fps: number, bitrateKbps: number): number;
  /** Drain the ring and hand each finished access unit to the page. Returns how many. */
  _pf_session_pump(): number;
  /** `0` idle, `1` offered, `2` live, `3` failed. */
  _pf_session_phase(): number;
  _pf_session_frames(): number;
  /** Channels in the negotiated audio plane; `0` before `Welcome`. */
  _pf_session_audio_channels(): number;
  _pf_audio_frames(): number;
  _pf_audio_lost(): number;

  // --- the device credential ---------------------------------------------------------------
  _pf_device_init(hashPtr: number): number;
  _pf_device_set(spkiPtr: number, spkiLen: number, hostFpPtr: number): number;
  _pf_device_sign(): number;
  /** Writes 64 hex characters to `out`. `0` when no key is loaded. */
  _pf_device_fingerprint_hex(out: number): number;
  /** `0` empty, `1` ready, `2` needs a signature, `3` pairing, `4` paired, `5` failed. */
  _pf_cred_phase(): number;
  _pf_cred_sign_ptr(): number;
  _pf_cred_sign_len(): number;
  _pf_cred_signed(sigPtr: number, len: number): number;
  _pf_pair_begin(pinPtr: number, pinLen: number, namePtr: number, nameLen: number): number;

  // --- input ---------------------------------------------------------------------------------
  /** One `InputEvent`, fields as core's `InputKind` documents them. Dropped unless a session is live. */
  _pf_input(kind: number, code: number, x: number, y: number, flags: number): void;
  /** The whole pad; Rust sends what changed. Sticks −32768..32767 with +y = up, triggers 0..255. */
  _pf_gamepad(pad: number, buttons: number, lsX: number, lsY: number, rsX: number, rsY: number, lt: number, rt: number): void;
  _pf_gamepad_arrival(pad: number): void;
  _pf_gamepad_remove(pad: number): void;

  // --- the datagram ring -------------------------------------------------------------------
  _pf_rx_base(): number;
  _pf_rx_stride(): number;
  _pf_rx_claim(): number;
  _pf_rx_commit(slot: number, len: number): void;
  _pf_rx_dropped(): number;

  _malloc(bytes: number): number;
  _free(ptr: number): void;

  /** Emscripten's view of wasm memory. Detached by a heap growth, so never hold one across an await. */
  HEAPU8: Uint8Array;
  stringToNewUTF8(s: string): number;

  // --- callbacks the page installs ---------------------------------------------------------
  //
  // `pf-glue.ts` calls these, so they are the page's half of the same boundary. All optional:
  // the glue checks before calling, and a page that does not decode video simply omits them.
  /** Sign with the device key, for messages the page composes — the management API's nonce.
   *  Installed by `pf_device_init` once the key is out of IndexedDB; absent before that. */
  __pfDevice?: {
    spki(): Promise<string>;
    sign(message: Uint8Array): Promise<Uint8Array>;
  };
  /** The device key is loaded and Rust holds its SPKI. Dial now, not before. */
  __pfOnDeviceReady?: () => void;
  /** The control stream is open. Send `Hello`, or ask for a PIN. */
  __pfOnCtlReady?: () => void;
  /** The connection closed. `code` is the host's application close code (`-1` for a transport
   *  failure) and `reason` its text, if the host gave one. */
  __pfOnClosed?: (code: number, reason: string) => void;
  /** The host said why it is closing, on the control plane (`Refused`). Comes before the close. */
  __pfOnRefused?: (code: number, reason: string) => void;
  /** The negotiated video format, once `Welcome` has been read. */
  __pfOnVideoConfig?: (codec: number, width: number, height: number) => void;
  /** One access unit. The bytes are copied out of wasm memory before this is called. */
  __pfOnAccessUnit?: (data: Uint8Array, ptsUs: number, key: boolean) => void;
  /** One Opus frame, in order, for the page's decoder. */
  __pfOnAudioFrame?: (data: Uint8Array, seq: number, ptsNs: number) => void;
}

declare global {
  /** `MODULARIZE=1` with `EXPORT_NAME=PunktfunkWeb`: the page starts the module itself. */
  function PunktfunkWeb(): Promise<PunktfunkModule>;

  // --- the `--js-library` scope, for `pf-glue.ts` only -------------------------------------
  function mergeInto(library: unknown, additions: Record<string, unknown>): void;
  const LibraryManager: { library: unknown };
  const Module: PunktfunkModule;
  const HEAPU8: Uint8Array;
  function _malloc(bytes: number): number;
  function _free(ptr: number): void;
  function UTF8ToString(ptr: number, maxBytes?: number): string;
  /** A library member calling another: emscripten exposes each under its C name. */
  function _pf_wt_close(): void;
  /** Emscripten's WebGL bookkeeping. The only place a GL object may be named. */
  const GL: {
    createContext(canvas: HTMLCanvasElement, attrs: Record<string, unknown>): number;
    makeContextCurrent(handle: number): void;
  };
}

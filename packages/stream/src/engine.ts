// The engine: everything a punktfunk browser client does, minus the drawing.
//
// This is the library's surface. A consumer gives it a canvas and gets back a state it can
// render and a handful of verbs; it never touches the wasm module, the transport, the device
// key or the decoder. The state carries facts — `blocked`, `needs-pairing`, `streaming` — and
// never wording, so two very different interfaces can sit on it: the web shell in `apps/web`
// and the gamepad console are both consumers of exactly this.
//
// The wasm module is loaded on `create()`, not on import. It is eight megabytes, and a page that
// imports this library to show a host picker must not pay for it until someone connects.
//
// The order of the trust steps is the whole point and does not vary: reach the host, check its
// attestation against what pairing stored, load the device key, *then* dial. Each step can only
// fail in one direction, and a browser that has never paired simply has nothing to check.

import type { PunktfunkModule } from "./emscripten.ts";
import { Host, type LibraryEntry, VersionSkew } from "./host.ts";
import * as pf from "./pf-connect.ts";
import { decodeSupported, VideoPipe } from "./video.ts";
import { InputPipe } from "./input.ts";

export type { HostInfo, HostStatus, LibraryEntry } from "./host.ts";
export { VersionSkew } from "./host.ts";
export { type KnownHost, type Plane, hosts, originOf } from "./pf-connect.ts";

/** `pf_cred_phase` and `pf_session_phase`, named. Kept beside the exports they mirror. */
const CRED = { EMPTY: 0, READY: 1, NEEDS_SIGNATURE: 2, PAIRING: 3, PAIRED: 4, FAILED: 5 } as const;
const SESSION = { IDLE: 0, OFFERED: 1, LIVE: 2, FAILED: 3 } as const;
/** The host's application close codes this engine reads (`punktfunk_core::reject`). */
const CLOSE = { PAIR_DENIED: 0x64, ACCESS_EXPIRED: 0x69, HOST_POWER: 0x6b } as const;

/** How long `Offered` may last before the host is taken to have refused the credential. It
 *  closes the session without a message, so nothing else says so. */
const OFFERED_GRACE_MS = 5000;

export interface SessionStats {
  width: number;
  height: number;
  /** Frames the decoder produced in the last second. */
  fps: number;
  /** Access units the wasm side delivered, since the session opened. */
  accessUnits: number;
  decoded: number;
  dropped: number;
  /** Average milliseconds uploading a frame to the video plane. */
  uploadMs: number;
  backend: "webgpu" | "webgl2" | null;
}

/**
 * Where the engine is. Exactly one at a time; `onState` fires on every change.
 *
 * These are facts about the connection, not screens. A renderer decides what each one looks
 * like and what it says.
 */
export type EngineState =
  | { kind: "idle" }
  /** What was typed is not an address. Nothing was tried; the picker should keep it. */
  | { kind: "bad-address"; input: string; message: string }
  | { kind: "reaching"; origin: string }
  /** Reachable, but its certificate has not been accepted in this browser. `acceptUrl` is the
   *  page a person opens once to do that. */
  | { kind: "blocked"; origin: string; acceptUrl: string }
  | { kind: "unreachable"; origin: string }
  /** Reachable and paired before, but the attestation does not chain to the fingerprint that
   *  pairing stored: this is not the host that was paired with. */
  | { kind: "untrusted"; origin: string; reason: string }
  | { kind: "connecting"; origin: string }
  /** The control stream is open and this browser has no pairing with the host. */
  | { kind: "needs-pairing"; origin: string }
  | { kind: "pairing"; origin: string }
  /** The ceremony succeeded. The host closes after it, as it does for native clients; the
   *  consumer reconnects to stream. */
  | { kind: "paired"; origin: string }
  /** `reason` is the host's own sentence when it gave one (not armed, rate-limited, wrong PIN). */
  | { kind: "pair-refused"; origin: string; reason?: string }
  /** Authenticated. `host` reaches the management API; nothing is streaming yet. Emitted once
   *  per connection — the host's name and the library are read through `host`, not carried. */
  | { kind: "ready"; origin: string; host: Host }
  /** `startStream` has been called and the host has not answered yet. */
  | { kind: "starting"; origin: string }
  | { kind: "streaming"; origin: string; stats: SessionStats }
  /** The host stopped accepting this browser's credential — it was unpaired there. */
  | { kind: "forgotten"; origin: string }
  | { kind: "error"; origin?: string; message: string; skew?: boolean };

export interface EngineOptions {
  /** The lower canvas: decoded video goes here and nowhere else. */
  readonly videoCanvas: HTMLCanvasElement;
  /** The upper canvas, for the gamepad console. Optional: the web shell does not use it. */
  readonly uiCanvas?: HTMLCanvasElement;
  /** Which video plane to prefer. `auto` takes WebGPU where the engine has it. */
  readonly videoBackend?: "auto" | "webgl2" | "webgpu";
  /** The name this device pairs under. Defaults to the browser's engine name. */
  readonly deviceName?: string;
  /**
   * Send the keyboard, pointer, wheel and gamepads to the host while streaming. On by default;
   * off for a page that only watches. Keys go from the whole window, so a consumer with fields
   * of its own keeps them by giving them focus — a field never loses a key to the stream.
   */
  readonly captureInput?: boolean;
  /**
   * Where to dial the WebTransport plane, when it is not the management origin's hostname.
   * The one case: a dev server proxying `/api` to a host on the LAN — the API answers on
   * `localhost`, the plane does not. Left unset, the hostname the address was typed with is used.
   */
  readonly transportHost?: string;
}

export interface StreamOptions {
  width: number;
  height: number;
  fps?: number;
  bitrateKbps?: number;
  /** What the host should launch. Not carried to the host yet — see `startStream`. */
  launch?: LibraryEntry;
}

export class Engine {
  private state: EngineState = { kind: "idle" };
  private readonly listeners = new Set<(s: EngineState) => void>();
  private origin: string | null = null;
  private plane: pf.Plane | null = null;
  private video: VideoPipe | null = null;
  private input: InputPipe | null = null;
  private host: Host | null = null;
  private pairing = false;
  private settled = false;
  private offeredSince = 0;
  private lastFrames = 0;
  private lastSecond = 0;
  private fps = 0;
  private running = true;
  /** A PIN given while the connection was down, sent when the next control stream opens. */
  private pendingPin: string | null = null;

  private constructor(
    private readonly mod: PunktfunkModule,
    private readonly opts: EngineOptions,
  ) {
    mod.__pfOnDeviceReady = () => this.dial();
    mod.__pfOnCtlReady = () => this.onControlStream();
    mod.__pfOnClosed = (code, reason) => this.onClosed(code, reason);
    mod.__pfOnRefused = (code, reason) => this.onClosed(code, reason);
    requestAnimationFrame(() => this.frame());
  }

  /**
   * Load the wasm module and bring the engine up. Rejects on an engine that cannot decode
   * video, so a consumer says so instead of connecting and showing black.
   */
  static async create(opts: EngineOptions): Promise<Engine> {
    if (!decodeSupported()) {
      throw new Error("this browser cannot decode video (no WebCodecs)");
    }
    const mod = await loadModule();
    return new Engine(mod, opts);
  }

  // --- observation ---------------------------------------------------------------------
  get current(): EngineState {
    return this.state;
  }

  /** Called with the current state now, then on every change. Returns the unsubscribe. */
  onState(listener: (s: EngineState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(state: EngineState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  // --- verbs ---------------------------------------------------------------------------
  /**
   * Reach a host, check it, load the device key and dial. Every failure is a state, not a
   * throw: the consumer renders `blocked`, `unreachable`, `untrusted` or `error`, and each
   * says what a person can do about it.
   */
  async connect(address: string): Promise<void> {
    let origin: string;
    try {
      origin = pf.originOf(address);
    } catch (e) {
      return this.set({ kind: "bad-address", input: address, message: message(e) });
    }
    this.reset();
    this.origin = origin;
    this.set({ kind: "reaching", origin });

    // Tell "certificate not accepted" apart from "nothing there" before saying anything: the two
    // are the same opaque error, and only one of them has a fix a person can follow.
    const state = await pf.reach(origin);
    if (state === "unreachable") return this.set({ kind: "unreachable", origin });
    if (state === "blocked") {
      return this.set({ kind: "blocked", origin, acceptUrl: pf.acceptUrl(origin) });
    }

    try {
      this.plane = await pf.fetchPlane(origin);
    } catch (e) {
      return this.set({ kind: "error", origin, message: message(e) });
    }

    const known = pf.hosts.fingerprint(origin);
    if (known) {
      try {
        await pf.verify(this.plane, known);
      } catch (e) {
        // Refuse before dialling. A host that cannot prove it is the one we paired with may still
        // be reachable — that is exactly the case this exists to catch.
        return this.set({ kind: "untrusted", origin, reason: message(e) });
      }
    }
    pf.hosts.remember(origin, {});
    this.set({ kind: "connecting", origin });
    // The key BEFORE the connection: the host may ask for a signature the moment the control
    // stream opens, and a key still coming out of IndexedDB would miss it.
    withStr(this.mod, [this.plane.cert_hash_sha256], (p) => this.mod._pf_device_init(p));
  }

  /**
   * Pair with the PIN the host is showing. Ends in `paired` or `pair-refused`.
   *
   * From `needs-pairing` the control stream is open and the request goes now. From `forgotten`
   * or `pair-refused` the host has already closed the connection — it does after any ceremony,
   * and after refusing a credential — so the PIN is held, the stale pairing forgotten, and the
   * request goes the moment a fresh control stream opens.
   */
  pair(pin: string): void {
    const origin = this.origin;
    if (!origin) return;
    switch (this.state.kind) {
      case "needs-pairing":
        this.sendPairRequest(pin);
        return;
      case "forgotten":
      case "pair-refused": {
        this.pendingPin = pin;
        // What is stored names a pairing the host no longer honours; keeping it would route the
        // reconnect back through the credential the host just refused.
        pf.hosts.unpair(origin);
        this.mod._pf_wt_close?.();
        void this.connect(origin);
        return;
      }
      default:
        return;
    }
  }

  private sendPairRequest(pin: string): void {
    if (!this.origin) return;
    const name = this.opts.deviceName ?? engineName();
    this.pairing = true;
    this.settled = false;
    withStr(this.mod, [pin, name], (p, pl, n, nl) => this.mod._pf_pair_begin(p, pl, n, nl));
    this.set({ kind: "pairing", origin: this.origin });
  }

  /**
   * Start streaming. Valid from `ready`.
   *
   * `launch` is accepted and not yet carried: `Hello` has a launch field on the wire but the
   * wasm side's `pf_session_hello` does not take one, so a title streams the desktop today. It
   * is reported rather than dropped, so a consumer can say so.
   */
  startStream(opts: StreamOptions): void {
    if (!this.origin || this.state.kind !== "ready") return;
    if (opts.launch) {
      console.warn("punktfunk: launching a title is not wired yet; streaming the desktop", opts.launch.id);
    }
    this.video ??= new VideoPipe(this.mod, this.opts.videoCanvas, this.opts.videoBackend ?? "auto");
    this.video.attach();
    this.set({ kind: "starting", origin: this.origin });
    this.mod._pf_session_hello(opts.width, opts.height, opts.fps ?? 60, opts.bitrateKbps ?? 20000);
  }

  /** Forget a host this browser knows. Its pairing on the host side is untouched. */
  forget(origin: string): void {
    pf.hosts.forget(origin);
    if (this.origin === origin) this.disconnect();
  }

  disconnect(): void {
    this.stopSession();
    this.mod._pf_wt_close?.();
    this.reset();
    this.set({ kind: "idle" });
  }

  /** The hosts this browser knows, most recent first. */
  knownHosts(): Array<pf.KnownHost & { origin: string }> {
    return pf.hosts.list();
  }

  /**
   * The gamepad console — `pf-console-ui` on the upper canvas, the shell every other punktfunk
   * client draws. Only meaningful when `uiCanvas` was given; a consumer with its own interface
   * never calls it. The canvas must be sized before `start`.
   */
  readonly console = {
    /** Bring the console up. `false` when the browser gave the canvas no WebGL2. */
    start: (width: number, height: number): boolean => this.mod._pf_start(width, height) === 1,
    /** Draw one frame. The console has its own loop; the engine's is for the session. */
    frame: (width: number, height: number): void => this.mod._pf_frame(width, height),
    /** A key by its index in the console's table — see `KEYS` in `apps/web/src/ui/console.ts`. */
    key: (index: number, shift: boolean, repeat: boolean): void =>
      this.mod._pf_key(index, shift ? 1 : 0, repeat ? 1 : 0),
  };

  /** Stop the frame loop. The module stays loaded; a page that wants it gone reloads. */
  destroy(): void {
    this.disconnect();
    this.running = false;
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------------------
  private reset(): void {
    this.origin = null;
    this.plane = null;
    this.host = null;
    this.pairing = false;
    this.settled = false;
    this.offeredSince = 0;
    // `pendingPin` survives: it is set right before the reconnect that calls this.
  }

  /** The device key is loaded and the wasm side holds its SPKI. Dial now, not before. */
  private dial(): void {
    if (!this.origin || !this.plane) return;
    const hostname = this.opts.transportHost ?? new URL(this.origin).hostname;
    const url = `https://${hostname}:${this.plane.port}/stream`;
    const ok = withStr(this.mod, [url, this.plane.cert_hash_sha256], (u, _ul, h) =>
      this.mod._pf_wt_connect(u, h),
    );
    if (!ok) {
      this.set({ kind: "error", origin: this.origin, message: "the browser refused the WebTransport session" });
    }
  }

  private onControlStream(): void {
    const origin = this.origin;
    if (!origin) return;
    const fingerprint = pf.hosts.fingerprint(origin);
    const device = this.mod.__pfDevice;
    if (!fingerprint || !device) {
      // Never paired with this host. The stream would be refused unless the host was started
      // with `serve --open`, so say so rather than let it fail silently.
      this.set({ kind: "needs-pairing", origin });
      const pin = this.pendingPin;
      this.pendingPin = null;
      if (pin) this.sendPairRequest(pin);
      return;
    }
    // Authenticated. The management API is reachable from here; nothing streams until asked.
    this.host = new Host(origin, fingerprint, device);
    this.set({ kind: "ready", origin, host: this.host });
    // The host's name, remembered for the picker. Not re-emitted as state: a second `ready`
    // would read as a second connection to anything listening.
    void this.host
      .info()
      .then((h) => pf.hosts.remember(origin, { name: h.hostname }))
      .catch((e: unknown) => {
        if (e instanceof VersionSkew && this.origin === origin) {
          this.set({ kind: "error", origin, message: e.message, skew: true });
        }
      });
  }

  /**
   * The host is closing, or has. Reaches here twice for one close — `Refused` on the control
   * plane first, then the transport's own close — and the first one settles the state: the
   * second finds it already in a terminal kind and leaves it. The host closes after every pairing
   * ceremony (nothing to say), refuses with a reason (say it), or drops a live session (say
   * that). A close in `idle` is this engine's own `disconnect`.
   */
  private onClosed(code: number, reason: string): void {
    const origin = this.origin;
    if (!origin || this.state.kind === "idle") return;
    const said = reason.trim();
    switch (this.state.kind) {
      case "pairing":
        // The ceremony's own verdict (`PairResult`) is authoritative; a close with a reason and
        // no verdict is the host refusing before the ceremony began.
        if (!this.settled && said) {
          this.settled = true;
          this.pairing = false;
          this.set({ kind: "pair-refused", origin, reason: said });
        }
        return;
      case "paired":
      case "pair-refused":
      case "forgotten":
      case "error":
        return;
      default:
        break;
    }
    if (code === CLOSE.PAIR_DENIED) {
      this.set({ kind: "forgotten", origin });
      return;
    }
    const message =
      code === CLOSE.HOST_POWER
        ? "the host is powering down"
        : code === CLOSE.ACCESS_EXPIRED
          ? "this device's access to the host has expired"
          : said || (code < 0 ? "the connection was lost" : `the host closed the session (code ${code})`);
    this.stopSession();
    this.set({ kind: "error", origin, message });
  }

  /** The session's two pipes, torn down together. Idempotent. */
  private stopSession(): void {
    this.input?.detach();
    this.input = null;
    this.video?.close();
    this.video = null;
  }

  // --- the frame loop ------------------------------------------------------------------
  private frame(): void {
    if (!this.running) return;
    // Signing is asynchronous and the phase can change on either side of it, so this is polled
    // rather than pushed. One check per frame costs nothing next to the draw.
    if (this.mod._pf_cred_phase() === CRED.NEEDS_SIGNATURE) this.mod._pf_device_sign();
    this.pumpCredential();
    this.mod._pf_session_pump();
    this.video?.present();
    this.updateSession();
    requestAnimationFrame(() => this.frame());
  }

  private pumpCredential(): void {
    if (!this.pairing || this.settled || !this.plane || !this.origin) return;
    const origin = this.origin;
    const phase = this.mod._pf_cred_phase();
    if (phase === CRED.PAIRED) {
      this.settled = true;
      // The fingerprint stored is the long-lived identity's, not the plane's throwaway
      // certificate, which is replaced every twelve days.
      void pf.hostFingerprint(this.plane).then((fp) => {
        if (fp) pf.hosts.remember(origin, { fingerprint: fp });
        this.set({ kind: "paired", origin });
      });
    } else if (phase === CRED.FAILED) {
      this.settled = true;
      this.pairing = false;
      this.set({ kind: "pair-refused", origin });
    }
  }

  private updateSession(): void {
    const origin = this.origin;
    if (!origin) return;
    const phase = this.mod._pf_session_phase();

    // Offered and going nowhere means the host did not accept the credential — most often
    // because it has since unpaired this browser. It just closes, so nothing else says so.
    if (phase === SESSION.OFFERED && !this.pairing) {
      this.offeredSince ||= performance.now();
      if (performance.now() - this.offeredSince > OFFERED_GRACE_MS) {
        this.offeredSince = 0;
        this.set({ kind: "forgotten", origin });
      }
      return;
    }
    if (phase !== SESSION.LIVE) return;
    this.offeredSince = 0;
    const v = this.video?.snapshot();

    // Input from the first live frame: the negotiated size is known by then (`Welcome` set it
    // before the phase turned), and absolute pointer positions are measured against it.
    if (!this.input && this.opts.captureInput !== false && v?.width) {
      this.input = new InputPipe(this.mod, this.opts.videoCanvas, {
        streamWidth: v.width,
        streamHeight: v.height,
      });
      this.input.attach();
    }
    this.input?.poll();

    const now = performance.now();
    const frames = this.mod._pf_session_frames();
    if (now - this.lastSecond >= 1000) {
      this.fps = Math.round(((frames - this.lastFrames) * 1000) / (now - this.lastSecond));
      this.lastFrames = frames;
      this.lastSecond = now;
    }
    this.set({
      kind: "streaming",
      origin,
      stats: {
        width: v?.width ?? 0,
        height: v?.height ?? 0,
        fps: this.fps,
        accessUnits: frames,
        decoded: v?.decoded ?? 0,
        dropped: v?.dropped ?? 0,
        uploadMs: v?.uploadMs ?? 0,
        backend: v?.backend ?? null,
      },
    });
  }
}

/** The emscripten module, loaded once. The dynamic import is what keeps the wasm off a
 *  consumer's critical path: nothing is fetched until the first `Engine.create()`. */
let modulePromise: Promise<PunktfunkModule> | null = null;
const loadModule = (): Promise<PunktfunkModule> => {
  modulePromise ??= import("../wasm/punktfunk-client-web.js").then(
    (m) => (m.default as () => Promise<PunktfunkModule>)(),
  );
  return modulePromise;
};

/** `stringToNewUTF8` mallocs. Every caller frees, because these run on a reconnect loop and a
 *  page that leaks a string per attempt eventually stops connecting. */
function withStr<T>(mod: PunktfunkModule, strings: string[], f: (...args: number[]) => T): T {
  const ptrs = strings.map((s) => mod.stringToNewUTF8(s));
  try {
    return f(...ptrs.flatMap((p, i) => [p, new TextEncoder().encode(strings[i]).length]));
  } finally {
    for (const p of ptrs) mod._free(p);
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const engineName = (): string =>
  navigator.userAgent.includes("Firefox")
    ? "Firefox"
    : navigator.userAgent.includes("Chrome")
      ? "Chrome"
      : "Safari";

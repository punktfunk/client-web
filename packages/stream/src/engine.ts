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
// attestation against what pairing stored, load the device key, *then* dial — and dial only to
// pair or to stream. Each step can only fail in one direction, and a browser that has never paired
// simply has nothing to check.

import { chipText, updateNotice } from "./access.ts";
import type { PunktfunkModule } from "./emscripten.ts";
import { DeviceRefused, Host, type LibraryEntry, VersionSkew } from "./host.ts";
import * as pf from "./pf-connect.ts";
import { type Decodable, decodableCodecs, decodeSupported, hdrDisplay, VideoPipe, webgpuUsable } from "./video.ts";
import { type Chord, InputPipe, playRumble } from "./input.ts";
import { AudioPipe, type AudioSnapshot, opusHead, playableChannels } from "./audio.ts";
import { MicPipe, type MicState } from "./mic.ts";
import { STATS_TIERS, type StatsTier } from "./settings.ts";
import type { ConsoleEvent } from "./console-bridge.ts";
import { HostCursor } from "./cursor.ts";
import type { HostTarget } from "./pf-connect.ts";
import { deviceName } from "./platform.ts";
import { type TunnelFetch, tunnelFetch } from "./tunnel.ts";

export type { AudioSnapshot, AudioState } from "./audio.ts";
export type { MicState } from "./mic.ts";
export type { HostInfo, HostStatus, LibraryEntry } from "./host.ts";
export { VersionSkew } from "./host.ts";
export { type HostTarget, type KnownHost, type Plane, type Reach, hosts, originOf, reach } from "./pf-connect.ts";

/** `pf_cred_phase` and `pf_session_phase`, named. Kept beside the exports they mirror. */
const CRED = { EMPTY: 0, READY: 1, NEEDS_SIGNATURE: 2, PAIRING: 3, PAIRED: 4, FAILED: 5 } as const;
const SESSION = { IDLE: 0, OFFERED: 1, LIVE: 2, FAILED: 3 } as const;
/** The host's application close codes this engine reads (`punktfunk_core::reject`). */
const CLOSE = { QUIT: 0x51, PAIR_DENIED: 0x64, ACCESS_EXPIRED: 0x69, HOST_POWER: 0x6b } as const;
/** Where the stream plays was refused: an unknown profile, no seat, a seat taken or not up. The
 *  host decides these only after it admitted the device. */
const PLACEMENT_REFUSED = new Set([0x6c, 0x6d, 0x6e, 0x6f]);
/** pf-glue's code for a session that never opened: no host was heard at all. */
const NEVER_OPENED = -2;

/** How long `Offered` may last before the host is taken to have refused the credential. It
 *  closes the session without a message, so nothing else says so. */
const OFFERED_GRACE_MS = 5000;

/** How long a request for access waits. The host gives up at 180 s and says so; this is the
 *  backstop for a host that never answers. */
const KNOCK_BUDGET_MS = 185_000;

/** One stats-overlay line. `role` is how to paint it: headline, breakdown, aside or warning. */
export interface HudLine {
  role: "primary" | "detail" | "muted" | "warn";
  text: string;
}
const ROLES: readonly HudLine["role"][] = ["primary", "detail", "muted", "warn"];
const UTF8 = new TextDecoder();

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
  audio: AudioSnapshot;
  /** Is the pointer locked to the video canvas? Only ever true in `capture` mode. */
  pointerCaptured: boolean;
  /** The stats overlay at this session's tier, one entry per line. Empty at `off`. */
  hud: HudLine[];
  statsTier: StatsTier;
  /** The host's sentence for a launch that did not give the player their game, for
   *  `LAUNCH_NOTICE_MS` after it arrives. */
  launchNotice?: string;
  /** This device's access when it is limited or ends (`Controller only · ends in 12 m`). */
  access?: string;
  /** A change to that access, or the host's warning before it ends, while it shows. */
  accessNotice?: string;
  /** The microphone going up to the host: off until the player turns it on. */
  mic: MicState;
}

/** Long enough to read a sentence with its cause. */
const LAUNCH_NOTICE_MS = 10_000;

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
  /** The host holds this browser's request for access until someone approves it in the host's
   *  console, where it shows as `name`. Approval streams on this same connection. */
  | { kind: "awaiting-approval"; origin: string; name: string }
  | { kind: "pairing"; origin: string }
  /** The ceremony succeeded. The host closes after it, as it does for native clients; the
   *  consumer reconnects to stream. */
  | { kind: "paired"; origin: string }
  /** `reason` is the host's own sentence when it gave one: not armed, rate-limited, a wrong PIN,
   *  or a request for access denied or left unanswered. */
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

/**
 * The options that can change between — or during — sessions, as opposed to the canvas and the
 * transport host, which are fixed when the engine is made. `EngineOptions` sets their first
 * values and [`Engine.configure`] changes them afterwards.
 *
 * Split out because a settings screen needs exactly this set and nothing else: everything here
 * is either applied to the live input pipe at once, or picked up by the next session.
 */
export interface TunableOptions {
  videoBackend: "auto" | "webgl2" | "webgpu";
  audio: boolean;
  captureInput: boolean;
  /** `absolute` maps the local cursor onto the remote one; `capture` takes pointer lock and
   *  sends relative motion, which is what a game with mouselook needs. */
  pointer: "absolute" | "capture";
  /** Stick travel below this is rest, 0–1. */
  deadzone: number;
  /** The overlay tier a session starts at; Ctrl+Alt+Shift+S cycles it for that session. */
  statsTier: StatsTier;
  /** The overlay's Advanced vocabulary instead of the figures Moonlight shows. Applies at once. */
  advancedStats: boolean;
  /** The codec to ask the host for first. A hint: the host falls back when it cannot. */
  codec: "auto" | "h264" | "hevc" | "av1";
  /** Offer 10-bit HDR when this browser and display can show it. */
  hdr: boolean;
  /** Scroll the other way from what the wheel says. */
  invertScroll: boolean;
}

const TUNABLE_DEFAULTS: TunableOptions = {
  videoBackend: "auto",
  audio: true,
  captureInput: true,
  pointer: "absolute",
  deadzone: 0.05,
  statsTier: "off",
  advancedStats: false,
  codec: "auto",
  hdr: true,
  invertScroll: false,
};

/** `CODEC_*` bits, as `Hello::preferred_codec` names one. */
const CODEC_BIT: Record<TunableOptions["codec"], number> = { auto: 0, h264: 0x01, hevc: 0x02, av1: 0x04 };

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
  /** Play the host's audio. On by default; off for a page that only watches. */
  readonly audio?: boolean;
  /** How the mouse is sent, and the gamepad deadzone. Both changeable later through
   *  [`Engine.configure`]. */
  readonly pointer?: "absolute" | "capture";
  readonly deadzone?: number;
  readonly statsTier?: StatsTier;
  readonly advancedStats?: boolean;
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
  /** `0` or unset is Automatic: the host picks the rate the link carries and follows it. */
  bitrateKbps?: number;
  /** What the host should launch. Its `id` goes on the wire; unset streams the desktop. */
  launch?: LibraryEntry;
  /** The id of the profile to play as; unset lets the host pick (`profiles.ts`). */
  profile?: string;
}

export class Engine {
  private state: EngineState = { kind: "idle" };
  private readonly listeners = new Set<(s: EngineState) => void>();
  private readonly menuListeners = new Set<() => void>();
  private origin: string | null = null;
  /** What `connect` was last given, so the engine's own reconnects reach the host the same way. */
  private target: string | HostTarget | null = null;
  /** Where the plane is dialled for the current connection. */
  private planeHost: string | null = null;
  private plane: pf.Plane | null = null;
  /** Where this stream is dialled when the host sent it elsewhere on the box: a door's seat. */
  private seatPlane: { port: number; certHash: string } | null = null;
  /** The certificate hash the device credential is bound to, which is the plane it dials. */
  private boundHash: string | null = null;
  /** The management API over the plane, for a target that `fetch` cannot reach. Opened once the
   *  plane is known and checked; closed with the connection. */
  private tunnel: TunnelFetch | null = null;
  private video: VideoPipe | null = null;
  private input: InputPipe | null = null;
  private audio: AudioPipe | null = null;
  private mic: MicPipe | null = null;
  private readonly cursor = new HostCursor();
  private host: Host | null = null;
  private pairing = false;
  private settled = false;
  private offeredSince = 0;
  private lastFrames = 0;
  private lastSecond = 0;
  /** What the input pipe was last told the stream measures; a reconfigure moves it. */
  private inputSize = { width: 0, height: 0 };
  private tunable: TunableOptions = TUNABLE_DEFAULTS;
  private fps = 0;
  /** This session's overlay tier and its last lines; `dropped` as of the last window. */
  private tier: StatsTier = TUNABLE_DEFAULTS.statsTier;
  private hud: HudLine[] = [];
  /** What the last `streaming` notification showed, so an unchanged frame notifies no one. */
  private shown = "";
  private lastDropped = 0;
  /** The last launch notice and when it arrived (`performance.now()`). */
  private launchNotice: { text: string; at: number } | null = null;
  /** The session's last access advert, read when its counter moves, with its deadline on
   *  `performance.now()` (`null` permanent); and the last notice one made. */
  private access: { seq: number; grants: number; deadline: number | null } = { seq: 0, grants: 0, deadline: null };
  private accessNotice: { text: string; at: number } | null = null;
  private running = true;
  /** A PIN given while the connection was down, sent when the next control stream opens. */
  private pendingPin: string | null = null;
  /** A stream asked for from `ready`, sent as `Hello` when the dial it started opens. */
  private pendingStream: StreamOptions | null = null;
  /** The last stream asked for, which an SDR restart asks for again. */
  private streamed: StreamOptions | null = null;
  /** The stream is an SDR restart, which the next session says once. */
  private sdrNotice = false;
  /** A request for access, sent as `Hello` when the next control stream opens. Survives `reset`,
   *  as `pendingPin` does, for the reconnect that clears a stale pairing first. */
  private pendingKnock: StreamOptions | null = null;
  /** When the request for access went out, while it waits; `0` otherwise. */
  private knockSince = 0;
  /** Moved by every `reset`: a `connect` that comes back from an await to a newer one was
   *  cancelled or replaced, and says nothing. */
  private epoch = 0;
  /** The fingerprint the last `connect` was told to expect, for the reconnects this engine makes. */
  private expect: string | undefined;

  private constructor(
    private readonly mod: PunktfunkModule,
    private readonly opts: EngineOptions,
    /** What this browser decodes, probed once at `create`. */
    private readonly codecs: Decodable = { mask: 1, tenBit: false },
    /** How many channels this page can play: 2, 6 or 8, probed once at `create`. */
    private readonly surround = 2,
    /** Whether WebGPU gives this page an adapter, probed once at `create`: HDR needs one. */
    private readonly gpu = false,
  ) {
    this.tunable = {
      ...TUNABLE_DEFAULTS,
      videoBackend: opts.videoBackend ?? TUNABLE_DEFAULTS.videoBackend,
      audio: opts.audio ?? TUNABLE_DEFAULTS.audio,
      captureInput: opts.captureInput ?? TUNABLE_DEFAULTS.captureInput,
      pointer: opts.pointer ?? TUNABLE_DEFAULTS.pointer,
      deadzone: opts.deadzone ?? TUNABLE_DEFAULTS.deadzone,
      statsTier: opts.statsTier ?? TUNABLE_DEFAULTS.statsTier,
      advancedStats: opts.advancedStats ?? TUNABLE_DEFAULTS.advancedStats,
    };
    if (opts.uiCanvas) mod.__pfUiCanvas = opts.uiCanvas;
    mod.__pfOnDeviceReady = () => this.onDeviceReady();
    mod.__pfOnDeviceFailed = () => this.onDeviceFailed();
    mod.__pfOnCtlReady = () => this.onControlStream();
    mod.__pfOnClosed = (code, reason) => this.onClosed(code, reason);
    mod.__pfOnRefused = (code, reason) => this.onClosed(code, reason);
    mod.__pfOnRedirect = (port, certHash) => this.onRedirect(port, certHash);
    mod.__pfOnLaunchNotice = (text) => {
      this.launchNotice = { text, at: performance.now() };
    };
    mod.__pfOnRumble = (pad, low, high, lt, rt, ms) => playRumble(navigator.getGamepads(), pad, low, high, lt, rt, ms);
    mod.__pfOnCursorShape = (serial, w, h, hx, hy, rgba) => this.cursor.shape(serial, w, h, hx, hy, rgba);
    mod.__pfOnData = () => this.mod._pf_session_pump();
    requestAnimationFrame(() => this.frame());
  }

  /**
   * Load the wasm module and bring the engine up. Rejects on an engine that cannot decode
   * video, so a consumer says so instead of connecting and showing black.
   */
  static async create(opts: EngineOptions): Promise<Engine> {
    if (!decodeSupported()) {
      throw new Error("this browser can't decode video. Open this page in a current Chrome, Edge, Safari or Firefox");
    }
    // WebTransport and the device key exist only there; plain http on a LAN address is not one.
    if (!isSecureContext) {
      throw new Error("this page isn't on an https address, so the browser won't stream from it. Open it over https");
    }
    const [mod, codecs, channels, gpu] = await Promise.all([loadModule(), decodableCodecs(), playableChannels(), webgpuUsable()]);
    return new Engine(mod, opts, codecs, channels, gpu);
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

  /** Called when the player asks for the quick menu: Ctrl+Alt+Shift+O, or Back+A on a pad.
   *  The menu is the consumer's to draw. Returns the unsubscribe. */
  onMenu(listener: () => void): () => void {
    this.menuListeners.add(listener);
    return () => this.menuListeners.delete(listener);
  }

  private set(state: EngineState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  // --- verbs ---------------------------------------------------------------------------
  /**
   * Reach a host, check it and load the device key; `ready` or `needs-pairing` follows without a
   * dial. Every failure is a state, not a
   * throw: the consumer renders `blocked`, `unreachable`, `untrusted` or `error`, and each
   * says what a person can do about it.
   */
  async connect(address: string | HostTarget, opts: { expectFingerprint?: string | undefined } = {}): Promise<void> {
    let origin: string;
    if (typeof address === "string") {
      try {
        origin = pf.originOf(address);
      } catch (e) {
        return this.set({ kind: "bad-address", input: address, message: message(e) });
      }
    } else {
      origin = address.api.replace(/\/+$/, "");
    }
    // A PIN or a request for access held for one host's reconnect is never sent to another.
    if (origin !== this.origin) {
      this.pendingPin = null;
      this.pendingKnock = null;
    }
    this.reset();
    const epoch = this.epoch;
    const stale = () => epoch !== this.epoch;
    this.expect = opts.expectFingerprint;
    this.origin = origin;
    this.target = address;
    this.planeHost =
      typeof address === "string"
        ? (this.opts.transportHost ?? new URL(origin).hostname)
        : address.plane;
    this.set({ kind: "reaching", origin });

    const tunnel = typeof address === "object" && address.tunnel === true;
    if (tunnel) {
      // A packaged page: the bootstrap is the reach probe and the plane in one answer. There is
      // no certificate to accept, so `blocked` cannot happen; the host's own 404 is the one
      // failure with a sentence of its own.
      const b = await pf.bootstrap(pf.bootstrapUrl(origin, this.planeHost));
      if (stale()) return;
      if (b.reach === "unreachable") return this.set({ kind: "unreachable", origin });
      if (b.reach === "no-plane") {
        return this.set({
          kind: "error",
          origin,
          message: "browser streaming is off on this host. Turn it on in the host's console, under Host → Settings, then restart the host",
        });
      }
      this.plane = b.plane;
    } else {
      // Tell "certificate not accepted" apart from "nothing there" before saying anything: the
      // two are the same opaque error, and only one of them has a fix a person can follow.
      const { reach: state, said } = await pf.reachWhy(origin);
      if (stale()) return;
      if (state === "unreachable") {
        return said ? this.set({ kind: "error", origin, message: said }) : this.set({ kind: "unreachable", origin });
      }
      if (state === "blocked") {
        return this.set({ kind: "blocked", origin, acceptUrl: pf.acceptUrl(origin) });
      }
      let plane: pf.Plane;
      try {
        plane = await pf.fetchPlane(origin);
      } catch (e) {
        return stale() ? undefined : this.set({ kind: "error", origin, message: message(e) });
      }
      if (stale()) return;
      this.plane = plane;
    }
    // Pairing keeps the identity the attestation names. Without one, every pairing is lost at once.
    if (!this.plane.cert_hash_sig || !this.plane.host_cert_der) {
      return this.set({
        kind: "error",
        origin,
        message:
          "this host still has its older identity, which a browser can't pair with. Moving it to the new one means unpairing its other devices, restarting it and pairing them again",
      });
    }

    // A link's pin: a known host must be the one it names, and an unknown one must prove it is.
    const stored = pf.hosts.fingerprint(origin);
    const expect = opts.expectFingerprint?.toLowerCase();
    if (stored && expect && stored.toLowerCase() !== expect) {
      return this.set({ kind: "untrusted", origin, reason: "the link names a different host than the one paired here" });
    }
    const known = stored ?? expect;
    if (known) {
      try {
        await pf.verify(this.plane, known);
      } catch (e) {
        // Refuse before dialling. A host that cannot prove it is the one we paired with may still
        // be reachable — that is exactly the case this exists to catch.
        return stale() ? undefined : this.set({ kind: "untrusted", origin, reason: message(e) });
      }
      if (stale()) return;
    }
    pf.hosts.remember(origin, typeof this.target === "object" && this.target ? { plane: this.target.plane } : {});
    // Every management call from here rides the plane, pinned to the hash just verified. The
    // tunnel is dialled by the first call, not now: the key may still say this host is unpaired.
    if (tunnel) {
      this.tunnel = tunnelFetch(`https://${this.planeHost}:${this.plane.port}/mgmt`, this.plane.cert_hash_sha256);
    }
    this.set({ kind: "connecting", origin });
    // The key BEFORE the connection: the host may ask for a signature the moment the control
    // stream opens, and a key still coming out of IndexedDB would miss it.
    this.boundHash = this.plane.cert_hash_sha256;
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
        // Nothing is dialled while the PIN is typed; the request goes as the control stream opens.
        this.pendingPin = pin;
        this.set({ kind: "pairing", origin });
        this.dial();
        return;
      case "forgotten":
      case "pair-refused": {
        this.pendingPin = pin;
        // What is stored names a pairing the host no longer honours; keeping it would route the
        // reconnect back through the credential the host just refused.
        pf.hosts.unpair(origin);
        this.mod._pf_wt_close?.();
        void this.connect(this.target ?? origin, { expectFingerprint: this.expect });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Ask for access without a PIN: someone approves this browser in the host's console. Valid
   * where `pair` is, and the same reconnect applies. Approval streams `opts` on this connection;
   * a denial or a request nobody answers ends in `pair-refused` with the host's reason. An
   * approval whose stream the host can't place ends in `paired`: the device is in, and the next
   * connect picks the profile and readies its seat first.
   */
  requestAccess(opts: StreamOptions): void {
    const origin = this.origin;
    if (!origin) return;
    switch (this.state.kind) {
      case "needs-pairing":
        this.pendingKnock = opts;
        this.set({ kind: "awaiting-approval", origin, name: this.deviceName });
        this.dial();
        return;
      case "forgotten":
      case "pair-refused":
        this.pendingKnock = opts;
        pf.hosts.unpair(origin);
        this.mod._pf_wt_close?.();
        void this.connect(this.target ?? origin, { expectFingerprint: this.expect });
        return;
      default:
        return;
    }
  }

  /** Withdraw a request for access. The host drops it with the connection, so an approval that
   *  lands later admits nothing. */
  cancelRequest(): void {
    const origin = this.origin;
    if (!origin || this.state.kind !== "awaiting-approval") return;
    this.pendingKnock = null;
    this.knockSince = 0;
    this.stopSession();
    this.mod._pf_wt_close?.();
    this.set({ kind: "needs-pairing", origin });
  }

  /** The name this device pairs and asks for access under. */
  private get deviceName(): string {
    return this.opts.deviceName ?? deviceName();
  }

  private sendPairRequest(pin: string): void {
    if (!this.origin) return;
    const name = this.deviceName;
    this.pairing = true;
    this.settled = false;
    withStr(this.mod, [pin, name], (p, pl, n, nl) => this.mod._pf_pair_begin(p, pl, n, nl));
    this.set({ kind: "pairing", origin: this.origin });
  }

  /**
   * Start streaming. Valid from `ready`. Dials the plane; `Hello` goes as its control stream opens.
   *
   * `launch` names a library title to open (its `id`); the host resolves it on the real-display
   * source and streams the desktop otherwise. Left unset, the desktop streams.
   */
  startStream(opts: StreamOptions): void {
    if (!this.origin || this.state.kind !== "ready") return;
    // HDR is offered per stream: the window may have moved to another display, and the plane
    // may have been switched to WebGL2, since the last one.
    const hdr = this.tunable.hdr && this.codecs.tenBit && hdrDisplay(this.tunable.videoBackend, this.gpu);
    this.mod._pf_session_codecs?.(this.codecs.mask, hdr ? 1 : 0, CODEC_BIT[this.tunable.codec]);
    this.set({ kind: "starting", origin: this.origin });
    this.streamed = opts;
    this.pendingStream = opts;
    this.dialBox();
  }

  /**
   * The browser converted an HDR frame itself, which nothing here can undo: the same stream again
   * in SDR, on a fresh connection. The title keeps running on the host; `hdrDisplay` now says no
   * for this browser build, so this happens once.
   */
  private restartInSdr(): void {
    const origin = this.origin;
    const opts = this.streamed;
    if (!origin || !opts || (this.state.kind !== "streaming" && this.state.kind !== "starting")) return;
    this.stopSession();
    this.mod._pf_session_codecs?.(this.codecs.mask, 0, CODEC_BIT[this.tunable.codec]);
    this.sdrNotice = true;
    this.set({ kind: "starting", origin });
    this.pendingStream = opts;
    this.dialBox();
  }

  /** The browser decodes this stream neither in hardware nor in software. The title keeps
   *  running on the host, as on a Leave. */
  private undecodable(): void {
    const origin = this.origin;
    if (!origin || (this.state.kind !== "streaming" && this.state.kind !== "starting")) return;
    this.stopSession();
    // `error` before the close, so the close it answers with finds nothing left to report.
    this.set({
      kind: "error",
      origin,
      message: "this browser can't decode the host's video. Try another browser, or turn on hardware acceleration in this one",
    });
    this.mod._pf_wt_close?.();
  }

  /** Dial the host this engine connected to, with the credential bound to its plane again. */
  private dialBox(): void {
    this.seatPlane = null;
    this.bindAndDial(this.plane?.cert_hash_sha256 ?? "");
  }

  /** Dial now when the credential is bound to `hash`; else bind it, and `onDeviceReady` dials. */
  private bindAndDial(hash: string): void {
    if (!hash || hash === this.boundHash) return this.dial();
    this.boundHash = hash;
    withStr(this.mod, [hash], (p) => this.mod._pf_device_init(p));
  }

  /**
   * The host is a door and this profile plays on a seat of the box: dial the seat's browser
   * plane once, pinning the hash the door vouched for over this pinned connection, and say
   * `Hello` there. The device credential binds to that plane's certificate, as to any.
   */
  private onRedirect(port: number, certHash: string): void {
    const origin = this.origin;
    const opts = this.streamed;
    if (!origin || !opts || this.state.kind !== "starting") return;
    if (this.seatPlane || certHash.length !== 64) {
      this.stopSession();
      return this.set({ kind: "error", origin, message: "the host sent this stream elsewhere twice" });
    }
    // The door closes this connection next; closing it first keeps that close from ending the
    // dial while the credential rebinds.
    this.mod._pf_wt_close?.();
    this.mod._pf_session_reset?.();
    this.seatPlane = { port, certHash };
    this.pendingStream = opts;
    this.bindAndDial(certHash);
  }

  /** Send `Hello`, with the video plane up to take what answers it. */
  private hello(opts: StreamOptions): void {
    // Off the decoder's own callback: the restart closes that decoder.
    this.video ??= new VideoPipe(
      this.mod,
      this.opts.videoCanvas,
      this.tunable.videoBackend,
      () => setTimeout(() => this.restartInSdr(), 0),
      () => this.undecodable(),
    );
    this.video.attach();
    this.tier = this.tunable.statsTier;
    this.hud = [];
    this.lastDropped = 0;
    // The wasm frame count starts again at zero with each session.
    this.lastFrames = 0;
    this.lastSecond = performance.now();
    this.launchNotice = this.sdrNotice
      ? { text: "This browser can't show HDR video, so the stream is in SDR.", at: performance.now() }
      : null;
    this.sdrNotice = false;
    this.access = { seq: 0, grants: 0, deadline: null };
    this.accessNotice = null;
    this.mod._pf_session_audio?.(this.tunable.audio ? this.surround : 2);
    const id = opts.launch?.id ?? "";
    const profile = opts.profile ?? "";
    withStr(this.mod, [id, this.deviceName, profile], (p, len, n, nl, pr, prl) =>
      this.mod._pf_session_hello(
        opts.width,
        opts.height,
        opts.fps ?? 60,
        opts.bitrateKbps ?? 0,
        id ? p : 0,
        id ? len : 0,
        n,
        nl,
        profile ? pr : 0,
        profile ? prl : 0,
      ),
    );
  }

  /**
   * Change what can change without a new engine. The pointer mode and the deadzone reach the
   * live input pipe at once; the video backend and whether audio plays are read when the next
   * session starts, because both own a pipeline that cannot be swapped under a running decoder.
   */
  configure(next: Partial<TunableOptions>): void {
    const was = this.tunable;
    this.tunable = { ...was, ...next };
    this.input?.tune({ pointer: this.tunable.pointer, deadzone: this.tunable.deadzone, invertScroll: this.tunable.invertScroll });
    // A tier picked in settings mid-stream replaces whatever the chord left.
    if (this.tunable.statsTier !== was.statsTier) this.tier = this.tunable.statsTier;
    this.hud = this.readHud();
  }

  /** This session's overlay tier; `off` hides it. The next stream starts from settings again. */
  setStatsTier(tier: StatsTier): void {
    this.tier = tier;
    this.hud = this.readHud();
  }

  /** Off → Compact → Normal → Detailed → Off, for this session. */
  cycleStats(): void {
    this.setStatsTier(STATS_TIERS[(STATS_TIERS.indexOf(this.tier) + 1) % STATS_TIERS.length] ?? "off");
  }

  /** The last closed window as lines, at this session's tier and vocabulary. */
  private readHud(): HudLine[] {
    const len = this.mod._pf_hud_text(STATS_TIERS.indexOf(this.tier), this.tunable.advancedStats ? 1 : 0);
    if (!len) return [];
    const ptr = this.mod._pf_hud_text_ptr();
    const text = UTF8.decode(this.mod.HEAPU8.subarray(ptr, ptr + len));
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return { role: ROLES[Number(line.slice(0, tab))] ?? "primary", text: line.slice(tab + 1) };
      });
  }

  /** What the engine is currently tuned to. */
  get tuning(): TunableOptions {
    return { ...this.tunable };
  }

  /** Take or release the pointer. Must be called from a user gesture to take it — that is a
   *  browser rule, not this engine's. */
  capturePointer(on: boolean): void {
    this.input?.capture(on);
  }

  /**
   * Ask the host for a different stream size. Valid only while streaming.
   *
   * Deliberately a verb rather than something the engine does when the canvas changes: the host
   * rebuilds its capture pipeline to answer, and on the wlroots reference host that recreates
   * the output. Whoever calls this decides that the disruption is worth it.
   */
  reconfigure(width: number, height: number, fps: number): void {
    if (this.state.kind !== "streaming") return;
    // Odd dimensions have no 4:2:0 chroma grid and the host refuses them outright.
    const even = (px: number) => Math.max(2, Math.floor(px) & ~1);
    this.mod._pf_session_reconfigure?.(even(width), even(height), Math.max(1, Math.round(fps)));
  }

  /**
   * Enter or leave fullscreen; toggles when `on` is omitted. Entering needs a user gesture. In
   * fullscreen the keyboard is locked where the browser offers it (Chromium), so system shortcuts
   * such as Alt+Tab reach the host.
   */
  fullscreen(on = !document.fullscreenElement): void {
    const keyboard = (navigator as { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }).keyboard;
    // An iPhone has no element fullscreen at all, and the call would throw before anything else.
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      void document.documentElement
        .requestFullscreen()
        .then(() => keyboard?.lock?.())
        .catch(() => {});
    } else if (!on && document.fullscreenElement) {
      keyboard?.unlock?.();
      void document.exitFullscreen().catch(() => {});
    }
  }

  private chord(chord: Chord): void {
    switch (chord) {
      case "stats":
        return this.cycleStats();
      case "menu":
        for (const l of this.menuListeners) l();
        return;
      case "release":
        return this.capturePointer(false);
      case "mouse":
        return this.configure({ pointer: this.tunable.pointer === "capture" ? "absolute" : "capture" });
      case "mic":
        return this.toggleMic();
      case "fullscreen":
        return this.fullscreen();
      case "escape":
        this.capturePointer(false);
        return this.fullscreen(false);
      case "end":
      case "escape-hold":
        return this.leave(true);
    }
  }

  /** Turn the microphone on or off for this session. On needs a gesture: the browser asks. */
  toggleMic(): void {
    if (this.state.kind !== "streaming") return;
    this.mic ??= new MicPipe(this.mod);
    if (this.mic.state === "on" || this.mic.state === "starting") this.mic.stop();
    else void this.mic.start();
  }

  /** Forget a host this browser knows. Its pairing on the host side is untouched. */
  forget(origin: string): void {
    pf.hosts.forget(origin);
    if (this.origin === origin) this.disconnect();
  }

  /**
   * Leave the host. `quit` ends the title too (End); without it the host keeps the game running
   * for this device to come back to (Leave). A PIN or a request for access still waiting on a
   * reconnect goes with it.
   */
  disconnect(quit = false): void {
    this.stopSession();
    this.mod._pf_wt_close?.(quit ? CLOSE.QUIT : 0);
    this.pendingPin = null;
    this.pendingKnock = null;
    this.reset();
    this.set({ kind: "idle" });
  }

  /**
   * End the stream and stay with its host: `ready` again, so its library is a click away rather
   * than a reconnect. `quit` ends the title too. A stream that never had the management API — an
   * approved request for access — has nothing to stay with, and disconnects.
   */
  leave(quit = false): void {
    const { origin, host } = this;
    if (!origin || !host) return this.disconnect(quit);
    this.stopSession();
    this.pendingStream = null;
    // `ready` before the close, so the close it answers with finds nothing left to report.
    this.set({ kind: "ready", origin, host });
    this.mod._pf_wt_close?.(quit ? CLOSE.QUIT : 0);
  }

  /** The management API of the host this engine is with, a live stream included: `ready`
   *  carries it too, but a stream's menu has nothing else to reach it through. */
  hostApi(): Host | null {
    return this.host;
  }

  /** The hosts this browser knows, most recent first. */
  knownHosts(): Array<pf.KnownHost & { origin: string }> {
    return pf.hosts.list();
  }

  /**
   * The gamepad console — `pf-console-ui` on the upper canvas, the shell every other punktfunk
   * client draws, with the page as its host. It speaks `pf_console_ui::bridge`'s JSON both ways:
   * `push` hands it the model, and what it raises arrives through `onEvent`. Only meaningful when
   * `uiCanvas` was given; a consumer with its own interface never calls it. The canvas must be
   * sized before `start`.
   */
  readonly console = {
    /** Bring the console up from the bridge's `CreateOptions`. `false` when the browser gave the
     *  canvas no WebGL2, or the options did not parse. */
    start: (options: unknown): boolean =>
      withStr(this.mod, [JSON.stringify(options)], (p, n) => this.mod._pf_start(p, n)) === 1,
    /** Draw one frame. The console has its own loop; the engine's is for the session. `false`
     *  when it drew none: an idle console skips some, and one behind a stream draws nothing. */
    frame: (width: number, height: number): boolean => this.mod._pf_frame(width, height) === 1,
    /** A key by its index in the console's table — see `KEYS` in `apps/web/src/ui/console.ts`.
     *  `true` when the console used it. */
    key: (index: number, shift: boolean, repeat: boolean): boolean =>
      this.mod._pf_key(index, shift ? 1 : 0, repeat ? 1 : 0) === 1,
    /** Typed text while the console edits a field. */
    text: (text: string): void => withStr(this.mod, [text], (p, n) => this.mod._pf_console_text(p, n)),
    /** A pointer event in canvas pixels; see `pf_console_pointer` for the kinds. */
    pointer: (kind: number, x: number, y: number, dy = 0): boolean => this.mod._pf_console_pointer(kind, x, y, dy) === 1,
    /** Every pad merged into one sample, once a frame: buttons as bits, the left stick +y down. */
    pad: (buttons: number, lx: number, ly: number): void => this.mod._pf_console_pad(buttons, lx, ly),
    /** Where the session the console asked for stands: 0 connecting, 1 streaming, 2 failed,
     *  3 ended, 4 reconnecting. */
    phase: (phase: number, message = ""): void =>
      withStr(this.mod, [message], (p, n) => this.mod._pf_console_phase(phase, p, n)),
    /** What the console shows; see `CONSOLE_STATE`. */
    state: (): number => this.mod._pf_console_state(),
    /** Draw without the blur behind pinned chrome, without motion (a still backdrop), or without
     *  the idle frame cap. For a cost sweep, which prices each; all `false` puts them back. */
    leaveOut: (blur: boolean, motion: boolean, cap = false): void =>
      this.mod._pf_console_leave_out((blur ? 1 : 0) | (motion ? 2 : 0) | (cap ? 4 : 0)),
    /** One model update; `kind` is a `CONSOLE_PUSH` value. */
    push: (kind: number, value: unknown): void =>
      withStr(this.mod, [JSON.stringify(value ?? null)], (p, n) => this.mod._pf_console_push(kind, p, n)),
    /** One title's cover, encoded. */
    art: (id: string, bytes: Uint8Array): void => {
      const p = this.mod._malloc(bytes.length);
      try {
        this.mod.HEAPU8.set(bytes, p);
        withStr(this.mod, [id], (ip, il) => this.mod._pf_console_art(ip, il, p, bytes.length));
      } finally {
        this.mod._free(p);
      }
    },
    /** What the console raised: a bridge event or `{cmd}`, parsed. One listener. */
    onEvent: (fn: (event: ConsoleEvent) => void): void => {
      this.mod.__pfOnConsole = (json) => {
        try {
          fn(JSON.parse(json) as ConsoleEvent);
        } catch (e) {
          console.error("punktfunk: console event", e);
        }
      };
    },
  };

  /** Stop the frame loop. The module stays loaded; a page that wants it gone reloads. */
  destroy(): void {
    this.disconnect();
    this.running = false;
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------------------
  private reset(): void {
    // Drop the wasm session too, or a second connect keeps the old phase and streams a
    // torn-down decoder (black until reload).
    this.mod._pf_session_reset?.();
    this.origin = null;
    this.plane = null;
    this.seatPlane = null;
    this.boundHash = null;
    this.tunnel?.close();
    this.tunnel = null;
    this.host = null;
    this.pairing = false;
    this.settled = false;
    this.offeredSince = 0;
    this.knockSince = 0;
    this.pendingStream = null;
    this.epoch++;
    // `pendingPin` and `pendingKnock` survive: each is set right before the reconnect that calls
    // this. `connect` drops them for another host.
  }

  /**
   * The device key is loaded. The plane is dialled only to pair or to stream: the host gives a
   * session ten seconds to speak, so a browser looking at the library holds none, and `ready`
   * comes from pairing records here plus the management API.
   */
  private onDeviceReady(): void {
    const origin = this.origin;
    if (!origin) return;
    if (this.pendingPin || this.pendingStream || this.pendingKnock) return this.dial();
    const fingerprint = pf.hosts.fingerprint(origin);
    const device = this.mod.__pfDevice;
    if (!fingerprint || !device) return this.set({ kind: "needs-pairing", origin });
    this.checkHost(origin, fingerprint, device);
  }

  /** A request for access was approved: the host is pinned as a PIN pairing pins it, from its
   *  attested identity. */
  private async pinApproved(origin: string): Promise<void> {
    const plane = this.plane;
    const fp = plane ? await pf.hostFingerprint(plane) : null;
    if (fp) pf.hosts.remember(origin, { fingerprint: fp });
  }

  /** The device key could not be loaded or made, so nothing can sign for this browser. */
  private onDeviceFailed(): void {
    const origin = this.origin;
    if (!origin) return;
    this.set({
      kind: "error",
      origin,
      message: "this browser couldn't open its device key. Allow this site to store data, then try again",
    });
  }

  /** Open the plane. Only after `onDeviceReady`: the wasm side must already hold the key's SPKI. */
  private dial(): void {
    if (!this.origin || !this.plane) return;
    // `/pf2` is the host's `punktfunk/2` session; a host older than 0.43 has no such path. A
    // door's seat answers on its own port of the same address.
    const port = this.seatPlane?.port ?? this.plane.port;
    const hash = this.seatPlane?.certHash ?? this.plane.cert_hash_sha256;
    const url = `https://${this.planeHost}:${port}/pf2`;
    const ok = withStr(this.mod, [url, hash], (u, _ul, h) => this.mod._pf_wt_connect(u, h));
    if (!ok) {
      this.set({ kind: "error", origin: this.origin, message: "the browser refused the WebTransport session" });
    }
  }

  /** The control stream is open: say at once what this dial was for. */
  private onControlStream(): void {
    const origin = this.origin;
    if (!origin) return;
    const stream = this.pendingStream;
    this.pendingStream = null;
    if (stream) return this.hello(stream);
    const knock = this.pendingKnock;
    this.pendingKnock = null;
    if (knock) {
      this.streamed = knock;
      this.knockSince = performance.now();
      this.set({ kind: "awaiting-approval", origin, name: this.deviceName });
      return this.hello(knock);
    }
    const pin = this.pendingPin;
    this.pendingPin = null;
    if (pin) return this.sendPairRequest(pin);
    // A dial with nothing to say would be closed by the host within ten seconds anyway.
    this.mod._pf_wt_close?.();
  }

  /**
   * The management API is what knows whether the host still accepts this device, so `ready`
   * waits for it. Refused: unpaired there. Any other failure leaves streaming possible.
   */
  private checkHost(origin: string, fingerprint: string, device: NonNullable<PunktfunkModule["__pfDevice"]>): void {
    const host = new Host(origin, fingerprint, device, this.tunnel ?? undefined);
    this.host = host;
    void host.info().then(
      (h) => {
        pf.hosts.remember(origin, { name: h.hostname });
        this.settle(host, origin);
      },
      (e: unknown) => this.settle(host, origin, e),
    );
  }

  /** `ready` once the management API has answered for this connection, or what it refused. */
  private settle(host: Host, origin: string, e?: unknown): void {
    if (this.host !== host || this.origin !== origin) return;
    if (e instanceof DeviceRefused) return this.set({ kind: "forgotten", origin });
    if (e instanceof VersionSkew) return this.set({ kind: "error", origin, message: e.message, skew: true });
    this.set({ kind: "ready", origin, host });
  }

  /**
   * The host is closing, or has. Reaches here twice for one close — `Refused` on the control
   * plane first, then the transport's own close — and the first one settles the state: the
   * second finds it already in a terminal kind and leaves it. The host closes after every pairing
   * ceremony (nothing to say), refuses with a reason (say it), or drops a live session (say
   * that). A dial that never opened names the port to check. A close in `idle` is this engine's
   * own `disconnect`.
   */
  private onClosed(code: number, reason: string): void {
    const origin = this.origin;
    if (!origin || this.state.kind === "idle") return;
    const said = reason.trim();
    if (code === NEVER_OPENED) {
      this.stopSession();
      return this.set({
        kind: "error",
        origin,
        message: `couldn't reach the host on UDP ${this.seatPlane?.port ?? this.plane?.port}, its browser streaming port. Check that nothing between this device and the host blocks it`,
      });
    }
    switch (this.state.kind) {
      case "awaiting-approval":
        this.knockSince = 0;
        if (PLACEMENT_REFUSED.has(code)) {
          // Paired now, so the transport's own close that follows finds nothing to report.
          void this.pinApproved(origin);
          this.stopSession();
          return this.set({ kind: "paired", origin });
        }
        // Denied, unanswered, or replaced by a newer request: the host's sentence says which.
        this.stopSession();
        return this.set({ kind: "pair-refused", origin, ...(said ? { reason: said } : {}) });
      // No connection is open here: a close is the one `cancelRequest` or `leave` just made.
      case "needs-pairing":
      case "ready":
        return;
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

  /** The session's pipes and its wasm state, torn down together. Idempotent. The wasm session
   *  goes too: a refusal leaves it `Offered`, which would read as a forgotten pairing later. */
  private stopSession(): void {
    this.mod._pf_session_reset?.();
    this.mic?.stop();
    this.mic = null;
    this.input?.detach();
    this.input = null;
    this.cursor.reset(this.opts.videoCanvas);
    this.inputSize = { width: 0, height: 0 };
    this.audio?.close();
    this.audio = null;
    this.video?.close();
    this.video = null;
  }

  // --- the frame loop ------------------------------------------------------------------
  private frame(): void {
    if (!this.running) return;
    // Armed first: a throw below costs this frame, not the loop that pumps every later one.
    requestAnimationFrame(() => this.frame());
    // Signing is asynchronous and the phase can change on either side of it, so this is polled
    // rather than pushed. One check per frame costs nothing next to the draw.
    if (this.mod._pf_cred_phase() === CRED.NEEDS_SIGNATURE) this.mod._pf_device_sign();
    this.pumpCredential();
    this.mod._pf_session_pump();
    this.video?.present();
    this.updateSession();
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
        // Kept even if the page has moved on: the host has stored this device by now.
        if (fp) pf.hosts.remember(origin, { fingerprint: fp });
        if (this.origin === origin) this.set({ kind: "paired", origin });
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
    if (phase === SESSION.OFFERED && this.knockSince) {
      if (performance.now() - this.knockSince > KNOCK_BUDGET_MS) {
        this.knockSince = 0;
        this.stopSession();
        this.mod._pf_wt_close?.();
        this.set({ kind: "pair-refused", origin, reason: "nobody approved the request on the host in time" });
      }
      return;
    }
    if (phase === SESSION.OFFERED && !this.pairing) {
      this.offeredSince ||= performance.now();
      if (performance.now() - this.offeredSince > OFFERED_GRACE_MS) {
        this.offeredSince = 0;
        this.set({ kind: "forgotten", origin });
      }
      return;
    }
    // The host sent something this page can't read: nothing after it will be either.
    if (phase === SESSION.FAILED) {
      this.stopSession();
      this.set({ kind: "error", origin, message: "this page couldn't read what the host sent", skew: true });
      this.mod._pf_wt_close?.();
      return;
    }
    if (phase !== SESSION.LIVE) return;
    this.offeredSince = 0;
    if (this.knockSince) {
      this.knockSince = 0;
      void this.pinApproved(origin);
    }
    const v = this.video?.snapshot();

    // Input from the first live frame: the negotiated size is known by then (`Welcome` set it
    // before the phase turned), and absolute pointer positions are measured against it.
    if (!this.input && this.tunable.captureInput && v?.width) {
      this.inputSize = { width: v.width, height: v.height };
      this.input = new InputPipe(this.mod, this.opts.videoCanvas, {
        streamWidth: v.width,
        streamHeight: v.height,
        pointer: this.tunable.pointer,
        deadzone: this.tunable.deadzone,
        invertScroll: this.tunable.invertScroll,
        onChord: (chord) => this.chord(chord),
      });
      this.input.attach();
    }
    // A reconfigure moves the surface absolute positions are measured against, and the pipe has
    // no other way to hear about it.
    if (this.input && v?.width && (v.width !== this.inputSize.width || v.height !== this.inputSize.height)) {
      this.inputSize = { width: v.width, height: v.height };
      this.input.tune({ streamWidth: v.width, streamHeight: v.height });
    }
    this.input?.poll();
    // A pad chord in `poll` can end the stream; what follows would report it live again.
    if (!this.video) return;
    if (v?.width) {
      const input = this.input !== null;
      this.cursor.tick(this.mod, this.opts.videoCanvas, input, this.tunable.pointer === "absolute", this.input?.captured ?? false, v.width);
    }
    // Audio from the first live frame too: the channel count is `Welcome`'s.
    if (!this.audio && this.tunable.audio) {
      const channels = this.mod._pf_session_audio_channels();
      if (channels > 0) {
        this.audio = new AudioPipe(this.mod, channels, this.surroundHead(channels));
        this.audio.attach();
      }
    }

    const now = performance.now();
    this.readAccess(now);
    const frames = this.mod._pf_session_frames();
    let second = false;
    if (now - this.lastSecond >= 1000) {
      second = true;
      this.fps = Math.round(((frames - this.lastFrames) * 1000) / (now - this.lastSecond));
      this.lastFrames = frames;
      this.lastSecond = now;
      // The overlay's window closes on the same second; frames replaced before drawing are skips.
      const dropped = v?.dropped ?? 0;
      this.mod._pf_hud_drain(Math.max(0, dropped - this.lastDropped));
      this.lastDropped = dropped;
      this.hud = this.readHud();
    }
    const state: EngineState = {
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
        audio: this.audio?.snapshot() ?? { state: "off", frames: 0, lost: 0, errors: 0, underruns: 0 },
        backend: v?.backend ?? null,
        pointerCaptured: this.input?.captured ?? false,
        hud: this.hud,
        statsTier: this.tier,
        ...(this.launchNotice && now - this.launchNotice.at < LAUNCH_NOTICE_MS
          ? { launchNotice: this.launchNotice.text }
          : {}),
        ...this.accessStats(now),
        mic: this.mic?.state ?? (MicPipe.supported() ? "off" : "unsupported"),
      },
    };
    // A screen redraws on what it shows: every frame here would re-render the page 60–240 times
    // a second on the thread that also feeds the decoder. The counters move once a second.
    const s = state.stats;
    const shown = `${s.width}x${s.height}|${s.pointerCaptured}|${s.mic}|${s.launchNotice}|${s.access}|${s.accessNotice}|${s.backend}|${this.tier}`;
    if (second || shown !== this.shown || this.state.kind !== "streaming") {
      this.shown = shown;
      this.set(state);
    } else {
      this.state = state;
    }
  }

  /** The `OpusHead` for the surround the host encodes, or nothing for stereo. */
  private surroundHead(channels: number): Uint8Array | undefined {
    if (channels <= 2 || !this.mod._pf_session_audio_layout) return undefined;
    const p = this.mod._malloc(10);
    try {
      const n = this.mod._pf_session_audio_layout(p);
      if (n < 2) return undefined;
      const bytes = this.mod.HEAPU8.slice(p, p + n);
      return opusHead(channels, bytes[0]!, bytes[1]!, bytes.subarray(2));
    } finally {
      this.mod._free(p);
    }
  }

  /** Take a new access advert. The first is `Welcome`'s: it sets the chip and says nothing. */
  private readAccess(now: number): void {
    const seq = this.mod._pf_session_access_seq?.() ?? 0;
    if (seq === this.access.seq) return;
    const grants = this.mod._pf_session_access_grants?.() ?? 0;
    const secs = this.mod._pf_session_access_secs?.() ?? 0;
    if (this.access.seq) {
      const text = updateNotice(this.access.grants, grants, secs || null);
      if (text) this.accessNotice = { text, at: now };
    }
    this.access = { seq, grants, deadline: secs ? now + secs * 1000 : null };
  }

  private accessStats(now: number): Pick<SessionStats, "access" | "accessNotice"> {
    const { seq, grants, deadline } = this.access;
    const chip = seq ? chipText(grants, deadline === null ? null : (deadline - now) / 1000) : undefined;
    const notice = this.accessNotice && now - this.accessNotice.at < LAUNCH_NOTICE_MS ? this.accessNotice.text : undefined;
    return { ...(chip ? { access: chip } : {}), ...(notice ? { accessNotice: notice } : {}) };
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


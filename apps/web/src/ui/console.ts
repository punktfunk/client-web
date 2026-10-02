// The gamepad interface: `pf-console-ui` on a canvas, the same shell every other punktfunk
// client draws — Android, tvOS, webOS, the desktop session — with this page as its host.
//
// The console runs the whole way in: hosts, pairing, the library, launch, settings. The page
// feeds it the same model `app.ts` already builds (known hosts, the library and its covers,
// where the session stands), and turns what it raises into the same `Actions` the web shell
// uses, so nothing about connecting or streaming is done twice. Three screens it cannot draw
// stay the web shell's: accepting a certificate needs a link opened, a trust question needs
// reading, and a stream's own overlay is the page's.
//
// Nothing here reaches into Skia or GL: the console is wasm exports, and the one place a
// graphics object is named is `pf-glue.ts`.

import {
  CONSOLE_PUSH,
  CONSOLE_STATE,
  type ConsoleAction,
  type ConsoleCmd,
  type ConsoleEvent,
  type ConsoleGame,
  type ConsoleHostRow,
  deviceName,
  type Engine,
  gameEndNotice,
  type Host,
  type LibraryEntry,
  packaged,
  tizen,
} from "@punktfunk/stream";
import type { Actions, HostCard, Screen, Ui } from "./types.ts";

/** Index into the console's key table (`KEYS` in `rust/host.rs`). Anything absent stays the
 *  browser's, so reload, devtools and find keep working while the console has focus. */
const KEYS: Record<string, number> = {
  ArrowLeft: 0,
  ArrowRight: 1,
  ArrowUp: 2,
  ArrowDown: 3,
  Enter: 4,
  NumpadEnter: 4,
  Space: 5,
  Escape: 6,
  Backspace: 7,
  PageUp: 8,
  PageDown: 9,
  Tab: 10,
  KeyY: 11,
  KeyX: 12,
};

/** Where the console's settings persist: the native snapshot, as the shell saved it. */
const SETTINGS_KEY = "punktfunk.console.settings";

/** The screens the console cannot draw; everything else is the console's. */
const WEB_SCREENS = new Set<Screen["kind"]>(["accept", "trust", "link", "streaming"]);

/** How long a wake is waited on before the console hears it did not come back. */
const WAKE_TIMEOUT_S = 60;

/** A standard-mapping pad's buttons, in the order `pf_console_pad` reads its bits: A, B, X, Y,
 *  L1, R1, then the D-pad's up, down, left, right. */
const PAD_BITS = [0, 1, 2, 3, 4, 5, 12, 13, 14, 15];

export class ConsoleUi implements Ui {
  private actions: Actions | null = null;
  private started = false;
  private mounted = false;
  /** The console's state bits after the last frame. */
  private state = 0;
  /** The web shell was told to stand aside for a launch hold over the stream. */
  private held = false;
  private screen: Screen | null = null;
  /** Host rows by the key the console knows them by, and the origin each stands for. */
  private origins = new Map<string, string>();
  private hosts: HostCard[] = [];
  /** The shelf the console was last handed, and which covers it already has. */
  private shelf: string | null = null;
  private gamesSent = "";
  private artSent = new Set<string>();
  /** A step the console asked for that waits on the engine: a PIN for a pairing it must dial
   *  first, a request for access, a title to start once the host is ready. */
  private pendingPin: { origin: string; pin: string } | null = null;
  private pendingKnock: string | null = null;
  private pendingPlay: { origin: string; id: string | null; title: string } | null = null;
  /** A session the console dialled, so a failure or an end is reported back to it. */
  private dialled = false;
  /** A shelf the console asked for whose host is still being reached: a failure lands on it. */
  private fetching: string | null = null;
  /** The management API of the host whose shelf the console shows: its launch hold asks it what
   *  is running. */
  private hostApi: { origin: string; host: Host } | null = null;
  /** A wake the console asked for: it gates the console's navigation until it hears back. */
  private waking: { key: string; origin: string; name: string; then: boolean; since: number; timer: number } | null = null;
  private readonly live: HTMLElement;
  private readonly leave: HTMLButtonElement;
  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onPointer: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;

  constructor(
    private readonly engine: Engine,
    private readonly canvas: HTMLCanvasElement,
    /** The web shell, for the screens the console cannot draw. */
    private readonly fallback: Ui,
  ) {
    this.live = Object.assign(document.createElement("div"), { className: "sr-only" });
    this.live.setAttribute("aria-live", "polite");
    this.leave = Object.assign(document.createElement("button"), {
      type: "button",
      textContent: "Leave console mode",
      // Out of the console's way until a pointer wants it: a pad never needs it.
      className:
        "fixed right-4 bottom-4 z-3 rounded-full border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground opacity-40 backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100",
    });
    this.onKey = (e) => this.key(e);
    this.onPointer = (e) => this.pointer(e);
    this.onWheel = (e) => {
      if (!this.showing()) return;
      const [x, y] = this.at(e);
      if (this.engine.console.pointer(4, x, y, -Math.sign(e.deltaY))) e.preventDefault();
    };
  }

  /** The web shell's toaster shows over the canvas too; the console has no line of its own
   *  for something that is not a screen. */
  notify(text: string, tone?: "error"): void {
    this.fallback.notify(text, tone);
  }

  mount(actions: Actions): void {
    this.actions = actions;
    this.fallback.mount(actions);
    document.body.append(this.live);
    // A packaged page has no other interface to leave for: no address bar, and a remote.
    if (!packaged()) document.body.append(this.leave);
    this.leave.addEventListener("click", () => actions.consoleMode(false));
    window.addEventListener("keydown", this.onKey);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      this.canvas.addEventListener(type, this.onPointer as EventListener);
    }
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.engine.console.onEvent((e) => this.event(e));
    // Its own loop: the engine's frame loop is for the session, and the console must draw at
    // the display's rate whether or not anything is streaming.
    this.mounted = true;
    const loop = () => {
      if (!this.mounted) return;
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  render(screen: Screen): void {
    const was = this.screen;
    this.screen = screen;
    const web = (WEB_SCREENS.has(screen.kind) && !this.held) || !this.started;
    this.fallback.render(web ? screen : { kind: "console" });
    if (!this.started) return;
    this.follow(was, screen);
  }

  destroy(): void {
    this.mounted = false;
    this.endWake(false);
    window.removeEventListener("keydown", this.onKey);
    this.live.remove();
    this.leave.remove();
    this.fallback.destroy();
  }

  // --- drawing ------------------------------------------------------------------------------
  private frame(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (!this.started) {
      // Deferred to the first frame: the canvas is sized by then, and a console started against
      // a zero-sized canvas comes up with a broken surface.
      this.started = this.engine.console.start({
        device_name: deviceName(),
        gpu_cache_bytes: 40 << 20,
        // A TV: no clipboard to copy a link to, no phone sensors to offer rows for.
        tv: tizen(),
        settings: savedSettings(),
      });
      if (!this.started) {
        console.error("punktfunk: the console could not start; the web shell stays up");
        this.mounted = false;
        return;
      }
      if (this.screen) this.render(this.screen);
    }
    if (this.showing()) this.pad();
    this.engine.console.frame(width, height);
    this.state = this.engine.console.state();
    // A launch hold covers the stream until the game is up: the page's own overlay waits.
    const holding = !!(this.state & CONSOLE_STATE.HOLDS_LAUNCH);
    if (holding !== this.held && this.screen) {
      this.held = holding;
      this.fallback.render(holding ? { kind: "console" } : this.screen);
    }
    const showing = this.showing();
    // The canvas takes the pointer only while the console is on it; over a stream the pointer
    // is the game's, and the empty canvas leaves the compositor too, so each video frame is not
    // blended under a transparent full-window layer.
    this.canvas.style.pointerEvents = showing ? "auto" : "none";
    this.canvas.style.visibility = showing ? "" : "hidden";
    this.leave.hidden = !showing;
  }

  /** The console is on screen: before and between streams, and over one it is holding. */
  private showing(): boolean {
    if (!this.started) return false;
    if (this.state & CONSOLE_STATE.HOLDS_LAUNCH) return true;
    return !(this.state & CONSOLE_STATE.IN_STREAM) && !WEB_SCREENS.has(this.screen?.kind ?? "console");
  }

  // --- input ----------------------------------------------------------------------------------
  private key(e: KeyboardEvent): void {
    if (!this.showing() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.state & CONSOLE_STATE.EDITING && e.key.length === 1) {
      e.preventDefault();
      this.engine.console.text(e.key);
      return;
    }
    const key = KEYS[e.code];
    if (key === undefined) return;
    e.preventDefault();
    this.engine.console.key(key, e.shiftKey, e.repeat);
  }

  private at(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [
      ((e.clientX - r.left) * this.canvas.width) / Math.max(1, r.width),
      ((e.clientY - r.top) * this.canvas.height) / Math.max(1, r.height),
    ];
  }

  private pointer(e: PointerEvent): void {
    if (!this.showing()) return;
    const [x, y] = this.at(e);
    const kind =
      e.type === "pointermove" ? 0
        : e.type === "pointerup" ? 2
          : e.type === "pointercancel" ? 5
            : e.button === 2 ? 3
              : e.pointerType === "touch" ? 6
                : 1;
    if (this.engine.console.pointer(kind, x, y)) e.preventDefault();
  }

  /** Every standard-mapping pad, merged into one sample: any pad can drive the console. */
  private pad(): void {
    let buttons = 0;
    let lx = 0;
    let ly = 0;
    for (const g of navigator.getGamepads()) {
      if (!g || g.mapping !== "standard") continue;
      PAD_BITS.forEach((b, bit) => {
        if (g.buttons[b]?.pressed) buttons |= 1 << bit;
      });
      const x = g.axes[0] ?? 0;
      const y = g.axes[1] ?? 0;
      if (Math.hypot(x, y) > Math.hypot(lx, ly) / 32767) {
        lx = Math.round(x * 32767);
        ly = Math.round(y * 32767);
      }
    }
    this.engine.console.pad(buttons, lx, ly);
  }

  // --- the model in ---------------------------------------------------------------------------
  /** Hand the console what the app's latest screen says. */
  private follow(was: Screen | null, s: Screen): void {
    const c = this.engine.console;
    switch (s.kind) {
      case "home":
        this.hosts = s.hosts;
        this.pushHosts();
        if (s.error) this.fetchFailed("The host did not answer", s.error);
        if (was?.kind === "streaming" || (this.dialled && was?.kind !== "home")) {
          this.dialled = false;
          c.phase(3);
        }
        return;
      case "connecting":
        if (this.dialled) c.phase(0);
        return;
      case "pair": {
        const pin = this.pendingPin;
        if (pin && pin.origin === s.origin && !s.error) {
          this.pendingPin = null;
          this.actions?.pair(pin.pin);
          c.push(CONSOLE_PUSH.PAIR, "Busy");
          return;
        }
        if (this.pendingKnock === s.origin) {
          this.pendingKnock = null;
          this.actions?.requestAccess();
          return;
        }
        if (s.error) c.push(CONSOLE_PUSH.PAIR, { Failed: s.error });
        else if (!s.busy) c.push(CONSOLE_PUSH.NAVIGATE, { pair: this.row(s.origin) });
        return;
      }
      case "library":
        // A stream left with `leave` comes back to its host's library rather than home.
        if (was?.kind === "streaming") {
          this.dialled = false;
          c.phase(3);
        }
        this.library(s);
        return;
      case "streaming":
        if (was?.kind !== "streaming") c.phase(1);
        return;
      case "error":
        this.dialled = false;
        this.fetchFailed(s.head, s.text);
        c.phase(2, `${s.head}. ${s.text}`);
        c.push(CONSOLE_PUSH.PAIR, "Idle");
        return;
      default:
        return;
    }
  }

  /** The shelf the console is waiting on could not be reached: say so on it, with a retry. */
  private fetchFailed(title: string, body: string): void {
    if (!this.fetching) return;
    this.fetching = null;
    this.engine.console.push(CONSOLE_PUSH.LIBRARY_PHASE, { Error: { title, body, can_retry: true } });
  }

  /** The library for the host the engine is on: its titles, their covers, what is running. */
  private library(s: Extract<Screen, { kind: "library" }>): void {
    // The console reaches a library only through a host it connected to, so it has a shelf.
    if (s.origin === null) return;
    const origin = s.origin;
    const c = this.engine.console;
    if (this.fetching === origin) this.fetching = null;
    if (this.shelf !== origin) {
      this.shelf = origin;
      const now = this.engine.current;
      if (now.kind === "ready" && now.origin === origin) this.hostApi = { origin: origin, host: now.host };
      this.gamesSent = "";
      this.artSent.clear();
      // A pairing that just finished: the console's Pair screen waits for this.
      const fp = this.fingerprint(origin);
      if (fp) c.push(CONSOLE_PUSH.PAIR, { Paired: { key: fp } });
      this.pushHosts();
      c.push(CONSOLE_PUSH.NAVIGATE, { library: this.row(origin) });
      c.push(CONSOLE_PUSH.LIBRARY_BEGIN, null);
    }
    const play = this.pendingPlay;
    if (play && play.origin === origin) {
      this.pendingPlay = null;
      this.actions?.play(play.id ? ({ id: play.id, title: play.title } as LibraryEntry) : undefined);
      return;
    }
    const sig = `${s.entries.length}:${s.running ?? ""}:${s.error ?? ""}:${s.busy ? 1 : 0}`;
    if (sig !== this.gamesSent) {
      this.gamesSent = sig;
      if (s.error) {
        c.push(CONSOLE_PUSH.LIBRARY_PHASE, { Error: { title: "The library could not be read", body: s.error, can_retry: true } });
      } else if (s.entries.length === 0) {
        c.push(CONSOLE_PUSH.LIBRARY_PHASE, s.busy ? "Loading" : "Empty");
      } else {
        c.push(CONSOLE_PUSH.LIBRARY_GAMES, s.entries.map((e) => game(e, s.running)));
        c.push(CONSOLE_PUSH.LIBRARY_PHASE, "Ready");
      }
      const running = s.entries.find((e) => e.title === s.running);
      c.push(CONSOLE_PUSH.LIBRARY_RUNNING, running ? [{ app_id: running.id, title: running.title, state: "running" }] : []);
    }
    for (const [id, url] of s.art) {
      if (this.artSent.has(id)) continue;
      this.artSent.add(id);
      void fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => {
          if (this.shelf === origin) c.art(id, new Uint8Array(b));
        })
        .catch(() => this.artSent.delete(id));
    }
  }

  private pushHosts(): void {
    const known = new Map(this.engine.knownHosts().map((h) => [h.origin, h]));
    this.origins.clear();
    const rows = this.hosts.map((h) => {
      const row = this.rowOf(h, known.get(h.origin)?.fingerprint ?? h.fingerprint);
      this.origins.set(row.key, h.origin);
      return row;
    });
    this.engine.console.push(CONSOLE_PUSH.HOSTS, rows);
  }

  private rowOf(h: HostCard, fp: string | undefined): ConsoleHostRow {
    const url = new URL(h.origin);
    const addr = h.plane ?? url.hostname;
    const mgmt = Number(url.port) || 47990;
    return {
      key: fp ?? `${addr}:${mgmt}`,
      id: h.origin,
      name: h.label ?? h.name ?? addr,
      addr,
      port: 9778,
      fp_hex: fp ?? "",
      paired: !!fp,
      saved: true,
      online: h.reach === "ok",
      mgmt_port: mgmt,
      can_wake: !!h.wake && h.reach !== "ok",
      last_used: h.seen ? Math.floor(h.seen / 1000) : null,
      os: "",
      pin: null,
      bound_preset: null,
    };
  }

  /** The row for an origin, from the home list or, for one only just added, from what the
   *  engine knows. */
  private row(origin: string): ConsoleHostRow {
    const card = this.hosts.find((h) => h.origin === origin) ?? ({ origin } as HostCard);
    return this.rowOf(card, this.fingerprint(origin));
  }

  private fingerprint(origin: string): string | undefined {
    return this.engine.knownHosts().find((h) => h.origin === origin)?.fingerprint;
  }

  // --- what the console raised ------------------------------------------------------------------
  private event(e: ConsoleEvent): void {
    if ("action" in e) return this.action(e.action);
    if ("cmd" in e) return this.command(e.cmd);
    if ("announce" in e) {
      this.live.textContent = e.announce;
      return;
    }
    if ("settings" in e) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(e.settings));
      } catch {
        // A private window: the settings last this visit.
      }
      this.actions?.setSettings(pageSettings(e.settings));
    }
  }

  private action(a: ConsoleAction): void {
    if (a === "CancelConnect") {
      this.pendingPlay = null;
      this.pendingPin = null;
      this.pendingKnock = null;
      this.dialled = false;
      // A request for access is withdrawn, so a late approval admits nothing.
      if (this.engine.current.kind === "awaiting-approval") this.actions?.cancelRequest();
      else this.actions?.back();
      return;
    }
    if (typeof a === "string") return;
    if ("CopyText" in a) {
      void navigator.clipboard?.writeText(a.CopyText).catch(() => {});
      return;
    }
    const l = a.Launch;
    const origin = this.originOf(l.fp_hex, l.addr);
    if (!origin) return;
    this.dialled = true;
    if (l.request_access) {
      this.pendingKnock = origin;
      this.actions?.connect(origin);
      return;
    }
    const now = this.engine.current;
    if (now.kind === "ready" && now.origin === origin) {
      this.actions?.play(l.launch ? ({ id: l.launch, title: l.title } as LibraryEntry) : undefined);
      return;
    }
    this.pendingPlay = { origin, id: l.launch, title: l.title };
    this.actions?.connect(origin);
  }

  private command(cmd: ConsoleCmd): void {
    const [name, body] = typeof cmd === "string" ? [cmd, {}] : (Object.entries(cmd)[0] ?? ["", {}]);
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const origin = this.originOf(str("fp_hex") || str("key"), str("addr"));
    switch (name) {
      case "FetchLibrary": {
        if (!origin) return;
        const now = this.engine.current;
        if (now.kind === "ready" && now.origin === origin) {
          // Already there: hand the shelf what the app has.
          this.gamesSent = "";
          this.artSent.clear();
          if (this.screen?.kind === "library") this.library(this.screen);
          return;
        }
        this.fetching = origin;
        this.actions?.connect(origin);
        return;
      }
      case "Pair": {
        if (!origin) return;
        const pin = str("pin");
        if (this.screen?.kind === "pair" && this.screen.origin === origin) {
          this.actions?.pair(pin);
          this.engine.console.push(CONSOLE_PUSH.PAIR, "Busy");
        } else {
          this.pendingPin = { origin, pin };
          this.actions?.connect(origin);
        }
        return;
      }
      case "SaveHost":
        if (str("addr")) this.actions?.connect(str("addr"));
        return;
      case "UpdateHost":
        if (origin) this.actions?.rename(origin, str("name"));
        return;
      case "ForgetHost":
      case "UnpairHost":
        if (origin) this.actions?.forget(origin);
        return;
      case "Wake":
        if (origin) this.startWake(str("key"), origin, body["then_connect"] === true);
        return;
      case "CancelWake":
        this.endWake(true);
        return;
      case "RefreshRunning":
        if (origin) this.refreshRunning(origin);
        return;
      case "EndGame":
        if (origin) void this.endGame(origin, str("app_id"), str("title"));
        return;
      default:
        // Presets, the speed test, pad tests, licences and host tools are the native clients';
        // the page offers what it has through the web shell.
        return;
    }
  }

  /** What the host runs, as the console's launch hold and Resume badge read it. Unanswered,
   *  the hold gives up after 15 s and covers the stream with a failure. */
  private refreshRunning(origin: string): void {
    const api = this.hostApi;
    if (!api || api.origin !== origin) return;
    void api.host
      .status()
      .then((st) =>
        this.engine.console.push(
          CONSOLE_PUSH.LIBRARY_RUNNING,
          st.games.map((g) => ({
            app_id: g.app_id ?? null,
            title: g.title,
            state: g.state,
            awaiting_window: !!g.awaiting_window,
            endable: !!g.endable,
          })),
        ),
      )
      .catch(() => {});
  }

  /** End a title this device launched, say how it went, then re-read what the host runs so the
   *  poster's badge follows. */
  private async endGame(origin: string, appId: string, title: string): Promise<void> {
    const api = this.hostApi;
    if (!api || api.origin !== origin || !appId) return;
    const outcome = await api.host.endGame(appId);
    this.engine.console.push(CONSOLE_PUSH.NOTICE, gameEndNotice(outcome, title));
    this.refreshRunning(origin);
  }

  /** Wake a host and keep the console's wake card current: seconds while the page's own wake
   *  polls it, then online (the console connects by itself if asked to) or timed out. */
  private startWake(key: string, origin: string, then: boolean): void {
    this.endWake(false);
    const name = this.hosts.find((h) => h.origin === origin)?.name ?? key;
    const since = Date.now();
    const tick = () => {
      const w = this.waking;
      if (!w) return;
      const seconds = Math.floor((Date.now() - w.since) / 1000);
      const online = this.hosts.find((h) => h.origin === w.origin)?.reach === "ok";
      const timedOut = !online && seconds >= WAKE_TIMEOUT_S;
      this.engine.console.push(CONSOLE_PUSH.WAKE, { key, name, seconds, timed_out: timedOut, online, then_connect: then });
      if (online || timedOut) {
        clearInterval(w.timer);
        // Online without a connect to follow: the card has said so, and goes.
        if (online && !then) window.setTimeout(() => this.endWake(true), 1500);
      }
    };
    this.waking = { key, origin, name, then, since, timer: window.setInterval(tick, 1000) };
    this.actions?.wake(origin);
    tick();
  }

  private endWake(clear: boolean): void {
    if (this.waking) clearInterval(this.waking.timer);
    this.waking = null;
    if (clear && this.started) this.engine.console.push(CONSOLE_PUSH.WAKE, null);
  }

  /** The origin a console key or address stands for. */
  private originOf(key: string, addr: string): string | undefined {
    const byKey = this.origins.get(key);
    if (byKey) return byKey;
    for (const [k, o] of this.origins) if (k.startsWith(`${addr}:`)) return o;
    return this.hosts.find((h) => (h.plane ?? new URL(h.origin).hostname) === addr)?.origin;
  }
}

/** A library entry as the console's shelf draws it. */
function game(e: LibraryEntry, running: string | undefined): ConsoleGame {
  return {
    id: e.id,
    title: e.title,
    store: e.store,
    launcher: e.role === "launcher",
    icon: e.icon ?? "",
    platform: e.platform ?? null,
    developer: e.developer ?? null,
    year: e.release_year ?? null,
    genres: [...(e.genres ?? [])],
    running: e.title === running,
  };
}

/** The settings the console saved last visit, or its defaults. */
function savedSettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The part of the console's settings the page's own stream reads: size, rate and bitrate. */
function pageSettings(s: Record<string, unknown>): { width?: number; height?: number; fps?: number; bitrateKbps?: number } {
  const n = (k: string) => (typeof s[k] === "number" ? (s[k] as number) : undefined);
  const out: { width?: number; height?: number; fps?: number; bitrateKbps?: number } = {};
  const width = n("width");
  const height = n("height");
  const fps = n("refresh_hz");
  const bitrate = n("bitrate_kbps");
  if (width !== undefined && height !== undefined) {
    out.width = width;
    out.height = height;
  }
  if (fps) out.fps = fps;
  if (bitrate !== undefined) out.bitrateKbps = bitrate;
  return out;
}

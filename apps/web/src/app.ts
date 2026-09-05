// The app: an `Engine` from `@punktfunk/stream`, an interface to draw it, and the mapping
// between the two.
//
// The engine's state carries facts — `blocked`, `needs-pairing`, `forgotten` — and this file
// turns each into a `Screen` with words on it. That is the whole of what the app owns: the
// wording, the choice of interface, the library grid's art, and the two pieces of presentation
// state no engine fact covers (whether the address field is showing, and what a reachability
// probe last said about each known host). Everything about hosts, trust, pairing and the session
// lives in the library, which is what lets the same engine sit under a TV app without a line of
// this file.

import {
  Engine,
  type EngineState,
  hosts,
  type LibraryEntry,
  type Reach,
  reach,
  type Settings,
  settings,
  VersionSkew,
} from "@punktfunk/stream";
import { ConsoleUi } from "./ui/console.ts";
import { WebShell } from "./ui/shell.tsx";
import type { HostCard, Screen, Ui } from "./ui/types.ts";

/** How long a reachability probe is believed. Long enough that returning to the home screen
 *  does not re-probe every host, short enough that a machine woken in the meantime shows up. */
const REACH_TTL_MS = 30_000;

/**
 * How long the window must sit still before the stream is resized to match it.
 *
 * Long, and deliberately so: the host rebuilds its capture pipeline to answer a `Reconfigure`,
 * and on the wlroots reference host that recreates the output. A drag across the screen must
 * cost one renegotiation at the end, not one per frame.
 */
const RESIZE_DEBOUNCE_MS = 700;

class App {
  private screen: Screen = { kind: "home", hosts: [], adding: true };
  /** The library, once `ready` has read it, with object URLs for art as it arrives. */
  private entries: LibraryEntry[] = [];
  private readonly art = new Map<string, string>();
  private libraryFor: string | null = null;
  /** Has the library been read yet? Not the same as "is it empty": a host with nothing in it
   *  answers instantly with an empty list, and deriving the spinner from the entry count left
   *  that host spinning for ever instead of saying so. */
  private libraryLoaded = false;
  private hostName: string | undefined;
  private running: string | undefined;
  private statusTimer = 0;
  /** Is the address field in front? Forced on when there is no card to click instead. */
  private adding = false;
  /** What a probe last said about each known host, and when. */
  private readonly reachCache = new Map<string, { reach: Reach; at: number }>();
  private probing = false;
  /** The settings sheet renders over whatever is showing, so it is a flag rather than a state. */
  private settingsOpen = false;
  private diagnostics = false;
  private prefs: Settings = settings.get();
  private resizeTimer = 0;

  constructor(
    private readonly engine: Engine,
    private readonly ui: Ui,
    private readonly uiCanvas: HTMLCanvasElement,
  ) {
    ui.mount({
      connect: (address) => {
        this.adding = false;
        void engine.connect(address);
      },
      pair: (pin) => engine.pair(pin),
      retry: () => {
        const s = engine.current;
        if ("origin" in s && s.origin) void engine.connect(s.origin);
      },
      back: () => engine.disconnect(),
      play: (entry) => this.play(entry),
      forget: (origin) => this.forget(origin),
      disconnect: () => engine.disconnect(),
      setAdding: (on) => {
        this.adding = on;
        if (engine.current.kind === "idle") this.render(engine.current);
      },
      rename: (origin, label) => {
        hosts.rename(origin, label);
        this.render(engine.current);
      },
      openSettings: (on) => {
        this.settingsOpen = on;
        this.render(engine.current);
      },
      setSettings: (patch) => {
        this.prefs = settings.set(patch);
        this.applyPrefs();
        this.render(engine.current);
      },
      toggleCapture: () => {
        const s = engine.current;
        engine.capturePointer(s.kind === "streaming" ? !s.stats.pointerCaptured : true);
      },
      showDiagnostics: (on) => {
        this.diagnostics = on;
        this.render(engine.current);
      },
    });
    this.applyPrefs();
    this.watchSize();
    engine.onState((s) => this.render(s));
  }

  private show(screen: Screen): void {
    this.screen = screen;
    this.ui.render(screen);
  }

  /** Facts in, words out. */
  private render(s: EngineState): void {
    if (this.settingsOpen) {
      return this.show({ kind: "settings", values: this.prefs, streaming: s.kind === "streaming" });
    }
    switch (s.kind) {
      case "idle":
        this.clearLibrary();
        return this.home();
      case "bad-address":
        // The field stays in front: what was typed is wrong and this is where it is fixed.
        this.adding = true;
        return this.home(s.message);
      case "reaching":
        return this.show({ kind: "connecting", origin: s.origin, phase: "reaching" });
      case "blocked":
        return this.show({ kind: "accept", origin: s.origin, url: s.acceptUrl });
      case "unreachable":
        return this.show({
          kind: "error",
          head: "No answer",
          text: `Nothing responded at ${bare(s.origin)}. Check the address, and that the host is running.`,
          retry: true,
        });
      case "untrusted":
        return this.show({ kind: "trust", origin: s.origin, reason: s.reason });
      case "connecting":
        return this.show({ kind: "connecting", origin: s.origin, phase: "connecting" });
      case "needs-pairing":
        return this.show({ kind: "pair", origin: s.origin, mode: "first" });
      case "pairing":
        return this.show({ kind: "pair", origin: s.origin, mode: "first", busy: true });
      case "paired": {
        this.show({ kind: "pair", origin: s.origin, mode: "first", busy: true });
        // The host closes after the ceremony, as it does for native clients; streaming is a
        // fresh connection.
        const origin = s.origin;
        setTimeout(() => void this.engine.connect(origin), 300);
        return;
      }
      case "pair-refused":
        return this.show({
          kind: "pair",
          origin: s.origin,
          mode: "first",
          error: s.reason ?? "That PIN was refused.",
        });
      case "forgotten":
        return this.show({ kind: "pair", origin: s.origin, mode: "again" });
      case "ready":
        if (this.libraryFor !== s.origin) void this.openLibrary(s);
        return this.redrawLibrary(s);
      case "starting":
        return this.show({ kind: "connecting", origin: s.origin, phase: "starting" });
      case "streaming":
        return this.show({
          kind: "streaming",
          stats: { origin: s.origin, ...s.stats },
          diagnostics: this.diagnostics,
        });
      case "error":
        return this.show({
          kind: "error",
          head: s.skew ? "This host speaks a different version" : "Something went wrong",
          text: s.skew ? `${s.message}. Update the host, or this page, so the two agree.` : s.message,
          retry: !s.skew,
        });
    }
  }

  // --- the home screen -------------------------------------------------------------------
  private home(error?: string): void {
    const known = this.engine.knownHosts();
    const hosts: HostCard[] = known.map((h) => {
      const seen = this.reachCache.get(h.origin);
      return seen ? { ...h, reach: seen.reach } : h;
    });
    this.show({
      kind: "home",
      hosts,
      // Nothing to click means the field is the only way forward.
      adding: this.adding || hosts.length === 0,
      ...(error ? { error } : {}),
    });
    void this.probe(known.map((h) => h.origin));
  }

  /**
   * Ask each known host whether it is there, then redraw. Cheap and stale-tolerant: a probe is
   * one `/health` fetch, its answer is believed for `REACH_TTL_MS`, and the grid is already on
   * screen and clickable before any of them answer.
   */
  private async probe(origins: string[]): Promise<void> {
    if (this.probing) return;
    const now = Date.now();
    const stale = origins.filter((o) => now - (this.reachCache.get(o)?.at ?? 0) > REACH_TTL_MS);
    if (stale.length === 0) return;
    this.probing = true;
    try {
      await Promise.all(
        stale.map(async (origin) => {
          this.reachCache.set(origin, { reach: await reach(origin), at: Date.now() });
          // Redraw per answer rather than once at the end: the first host to reply should not
          // wait on the slowest, which is the one that will take the full timeout.
          if (this.engine.current.kind === "idle") this.home();
        }),
      );
    } finally {
      this.probing = false;
    }
  }

  /** Forget a host. From the trust screen this is "forget and pair again", so the reconnect
   *  follows — with the stored fingerprint gone, the next connection is a first one. */
  private forget(origin: string): void {
    const reconnect = this.screen.kind === "trust" && this.screen.origin === origin;
    this.reachCache.delete(origin);
    this.engine.forget(origin);
    if (reconnect) void this.engine.connect(origin);
  }

  // --- the library ---------------------------------------------------------------------
  private async openLibrary(s: Extract<EngineState, { kind: "ready" }>): Promise<void> {
    this.libraryFor = s.origin;
    this.libraryLoaded = false;
    this.entries = [];
    try {
      this.entries = [...(await s.host.library())];
    } catch (e) {
      if (e instanceof VersionSkew) {
        return this.show({
          kind: "error",
          head: "This host speaks a different version",
          text: `${e.message}. Update the host, or this page, so the two agree.`,
        });
      }
      // The stream still works without a library, so this is a line on the screen rather than a
      // dead end.
      this.libraryLoaded = true;
      return this.redrawLibrary(s, e instanceof Error ? e.message : String(e));
    }
    this.libraryLoaded = true;
    this.redrawLibrary(s);
    // The one thing worth refreshing while someone looks at the grid: what the host is running.
    // Polled, because the event stream is not on this browser's lane; five seconds is plenty.
    const poll = async () => {
      const now = this.engine.current;
      if (now.kind !== "ready" || now.origin !== s.origin) return;
      try {
        const st = await s.host.status();
        const live = st.games.find((g) => g.state === "running" || g.state === "launching");
        this.running = live?.title;
        this.redrawLibrary(now);
      } catch {
        // A failed poll is not news; the next one will say.
      }
      this.statusTimer = window.setTimeout(() => void poll(), 5000);
    };
    void poll();
    void s.host.info().then((h) => {
      this.hostName = h.hostname;
      const now = this.engine.current;
      if (now.kind === "ready") this.redrawLibrary(now);
    }).catch(() => {});
    // Art after the grid, per entry: the grid should appear before its covers do.
    for (const entry of this.entries) {
      const art = entry.art.portrait ?? entry.art.header;
      if (!art || this.art.has(entry.id)) continue;
      void s.host.art(art).then((url) => {
        if (!url) return;
        this.art.set(entry.id, url);
        const now = this.engine.current;
        if (now.kind === "ready") this.redrawLibrary(now);
      });
    }
  }

  private redrawLibrary(s: Extract<EngineState, { kind: "ready" }>, error?: string): void {
    this.show({
      kind: "library",
      origin: s.origin,
      entries: this.entries,
      art: this.art,
      busy: this.libraryFor === s.origin && !this.libraryLoaded,
      ...(this.hostName ? { host: this.hostName } : {}),
      ...(this.running ? { running: this.running } : {}),
      ...(error ? { error: `${error} — you can still stream the desktop.` } : {}),
    });
  }

  private clearLibrary(): void {
    clearTimeout(this.statusTimer);
    this.libraryFor = null;
    this.libraryLoaded = false;
    this.hostName = undefined;
    this.running = undefined;
    this.entries = [];
    for (const url of this.art.values()) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
    this.art.clear();
  }

  // --- settings and the window ------------------------------------------------------------
  /** Push the tunable half of the settings at the engine. The rest — size, rate, bitrate — is
   *  read when a stream starts, because it is `StreamOptions` and not an engine property. */
  private applyPrefs(): void {
    this.engine.configure({
      videoBackend: this.prefs.videoBackend,
      audio: this.prefs.audio,
      captureInput: this.prefs.captureInput,
      pointer: this.prefs.pointer,
      deadzone: this.prefs.deadzone,
    });
  }

  /**
   * Follow the window, when asked to. Debounced hard, and no-op sizes are dropped before the
   * timer is even armed: a `Reconfigure` costs the host a pipeline rebuild, so the only ones
   * worth sending are the ones that change something.
   */
  private watchSize(): void {
    const observer = new ResizeObserver(() => {
      if (!this.prefs.resizeStream) return;
      const now = this.engine.current;
      if (now.kind !== "streaming") return;
      const [width, height] = size(this.uiCanvas);
      if (width === now.stats.width && height === now.stats.height) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        // Re-checked after the wait: the window may have gone back to where it started, and
        // the session may have ended while the timer ran.
        const then = this.engine.current;
        if (then.kind !== "streaming") return;
        const [w, h] = size(this.uiCanvas);
        if (w === then.stats.width && h === then.stats.height) return;
        this.engine.reconfigure(w, h, this.prefs.fps);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(this.uiCanvas);
  }

  private play(entry?: LibraryEntry): void {
    const [fit, fitHeight] = size(this.uiCanvas);
    const width = this.prefs.width || fit;
    const height = this.prefs.height || fitHeight;
    this.engine.startStream({
      width,
      height,
      fps: this.prefs.fps,
      bitrateKbps: this.prefs.bitrateKbps,
      ...(entry ? { launch: entry } : {}),
    });
  }
}

/** An origin without its scheme. Every screen shows a host this way; nothing gains from the
 *  `https://` that `originOf` put there. */
const bare = (origin: string): string => origin.replace(/^https:\/\//, "");

/** The stream mode from the canvas: device pixels capped at 2×, and always even.
 *
 * H.264/HEVC are 4:2:0 — one chroma sample per 2×2 luma block — so a codec has no valid chroma
 * grid for an odd width or height, and the host refuses one. The window is whatever size it is,
 * so round each dimension down to even here rather than send the host something it must reject. */
function size(canvas: HTMLCanvasElement): [number, number] {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const even = (px: number) => Math.max(2, Math.floor(px) & ~1);
  const w = even(canvas.clientWidth * dpr);
  const h = even(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return [w, h];
}

/**
 * Which interface to wear.
 *
 * `?ui=console` asks for the gamepad shell — the same `pf-console-ui` every other client draws,
 * which is what a TV or a controller wants. Anything else gets the web-native one on React,
 * because a browser is usually held by a mouse and a keyboard and the console cannot offer a
 * text field.
 */
function pickUi(engine: Engine, uiCanvas: HTMLCanvasElement): Ui {
  const shell = new WebShell(document.body);
  const wanted = new URLSearchParams(location.search).get("ui");
  return wanted === "console" ? new ConsoleUi(engine, uiCanvas, shell) : shell;
}

/** Set by `vite.config.ts` when the dev server proxies a host; absent in a build. */
declare const __PF_TRANSPORT_HOST__: string | undefined;

const uiCanvas = document.getElementById("pf-ui") as HTMLCanvasElement;
const videoCanvas = document.getElementById("pf-video") as HTMLCanvasElement;

try {
  const engine = await Engine.create({
    videoCanvas,
    uiCanvas,
    ...(__PF_TRANSPORT_HOST__ ? { transportHost: __PF_TRANSPORT_HOST__ } : {}),
  });
  new App(engine, pickUi(engine, uiCanvas), uiCanvas);
} catch (e) {
  // Before there is an engine there is no interface to say this on; the one sheet the page
  // carries for exactly this case does.
  const shell = new WebShell(document.body);
  shell.mount({
    connect() {}, pair() {}, retry() {}, back() {}, play() {}, forget() {}, disconnect() {},
    setAdding() {}, rename() {}, openSettings() {}, setSettings() {}, toggleCapture() {},
    showDiagnostics() {},
  });
  shell.render({
    kind: "error",
    head: "This browser cannot run the client",
    text: e instanceof Error ? e.message : String(e),
  });
}

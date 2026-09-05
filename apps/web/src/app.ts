// The app: an `Engine` from `@punktfunk/stream`, an interface to draw it, and the mapping
// between the two.
//
// The engine's state carries facts — `blocked`, `needs-pairing`, `forgotten` — and this file
// turns each into a `Screen` with words on it. That is the whole of what the app owns: the
// wording, the choice of interface, and the library grid's art. Everything about hosts, trust,
// pairing and the session lives in the library, which is what lets the same engine sit under
// the website or a TV app without a line of this file.

import { Engine, type EngineState, type LibraryEntry, VersionSkew } from "@punktfunk/stream";
import { ConsoleUi } from "./ui/console.ts";
import { WebShell } from "./ui/shell.ts";
import type { Screen, Ui } from "./ui/types.ts";

class App {
  private screen: Screen = { kind: "picker", hosts: [] };
  /** The library, once `ready` has read it, with object URLs for art as it arrives. */
  private entries: LibraryEntry[] = [];
  private readonly art = new Map<string, string>();
  private libraryFor: string | null = null;
  private hostName: string | undefined;

  constructor(
    private readonly engine: Engine,
    private readonly ui: Ui,
    private readonly uiCanvas: HTMLCanvasElement,
  ) {
    ui.mount({
      connect: (address) => void engine.connect(address),
      pair: (pin) => engine.pair(pin),
      retry: () => {
        const s = engine.current;
        if ("origin" in s && s.origin) void engine.connect(s.origin);
      },
      back: () => engine.disconnect(),
      play: (entry) => this.play(entry),
      forget: (origin) => engine.forget(origin),
      disconnect: () => engine.disconnect(),
    });
    engine.onState((s) => this.render(s));
  }

  private show(screen: Screen): void {
    this.screen = screen;
    this.ui.render(screen);
  }

  /** Facts in, words out. */
  private render(s: EngineState): void {
    switch (s.kind) {
      case "idle":
        this.clearLibrary();
        return this.show({ kind: "picker", hosts: this.engine.knownHosts() });
      case "reaching":
        return this.show({ kind: "picker", hosts: this.engine.knownHosts(), busy: true });
      case "blocked":
        return this.show({ kind: "accept", origin: s.origin, url: s.acceptUrl });
      case "unreachable":
        return this.show({
          kind: "error",
          head: "No answer",
          text: `Nothing responded at ${s.origin}. Check the address, and that the host is running.`,
        });
      case "untrusted":
        return this.show({
          kind: "error",
          head: "This is not the same host",
          text: `${s.reason}. Forget it on the previous screen to connect anyway.`,
        });
      case "connecting":
        return this.show({ kind: "connecting", origin: s.origin });
      case "needs-pairing":
        return this.show({ kind: "pair", origin: s.origin, message: "Enter the PIN this host is showing." });
      case "pairing":
        return this.show({ kind: "pair", origin: s.origin, message: "Pairing…", busy: true });
      case "paired":
        this.show({ kind: "pair", origin: s.origin, message: "Paired. Reconnecting…", busy: true });
        // The host closes after the ceremony, as it does for native clients; streaming is a
        // fresh connection.
        setTimeout(() => location.reload(), 1200);
        return;
      case "pair-refused":
        return this.show({
          kind: "pair",
          origin: s.origin,
          message: "Enter the PIN this host is showing.",
          error: "That PIN was refused.",
        });
      case "forgotten":
        return this.show({
          kind: "pair",
          origin: s.origin,
          message: "This host no longer knows this browser. Enter its PIN to pair again.",
        });
      case "ready":
        if (this.libraryFor !== s.origin) void this.openLibrary(s);
        return this.redrawLibrary(s);
      case "starting":
        return this.show({ kind: "connecting", origin: s.origin });
      case "streaming":
        return this.show({ kind: "streaming", stats: { origin: s.origin, ...s.stats } });
      case "error":
        return this.show({
          kind: "error",
          head: s.skew ? "This host speaks a different version" : "Something went wrong",
          text: s.skew ? `${s.message}. Update the host, or this page, so the two agree.` : s.message,
        });
    }
  }

  // --- the library ---------------------------------------------------------------------
  private async openLibrary(s: Extract<EngineState, { kind: "ready" }>): Promise<void> {
    this.libraryFor = s.origin;
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
      return this.redrawLibrary(s, e instanceof Error ? e.message : String(e));
    }
    this.redrawLibrary(s);
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
      busy: this.libraryFor === s.origin && this.entries.length === 0 && !error,
      ...(this.hostName ? { host: this.hostName } : {}),
      ...(error ? { error: `${error} — you can still stream the desktop.` } : {}),
    });
  }

  private clearLibrary(): void {
    this.libraryFor = null;
    this.hostName = undefined;
    this.entries = [];
    for (const url of this.art.values()) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
    this.art.clear();
  }

  private play(entry?: LibraryEntry): void {
    const [width, height] = size(this.uiCanvas);
    this.engine.startStream({ width, height, fps: 60, bitrateKbps: 20000, ...(entry ? { launch: entry } : {}) });
  }
}

/** Device pixels, capped at 2× — beyond that a 4K panel costs more than it shows. */
function size(canvas: HTMLCanvasElement): [number, number] {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
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
 * which is what a TV or a controller wants. Anything else gets the web-native one, because a
 * browser is usually held by a mouse and a keyboard and the console cannot offer a text field.
 */
function pickUi(engine: Engine, uiCanvas: HTMLCanvasElement): Ui {
  const shell = new WebShell(document.body);
  const wanted = new URLSearchParams(location.search).get("ui");
  return wanted === "console" ? new ConsoleUi(engine, uiCanvas, shell) : shell;
}

const uiCanvas = document.getElementById("pf-ui") as HTMLCanvasElement;
const videoCanvas = document.getElementById("pf-video") as HTMLCanvasElement;

try {
  const engine = await Engine.create({ videoCanvas, uiCanvas });
  new App(engine, pickUi(engine, uiCanvas), uiCanvas);
} catch (e) {
  // Before there is an engine there is no interface to say this on; the one sheet the page
  // carries for exactly this case does.
  const shell = new WebShell(document.body);
  shell.mount({ connect() {}, pair() {}, retry() {}, back() {}, play() {}, forget() {}, disconnect() {} });
  shell.render({
    kind: "error",
    head: "This browser cannot run the client",
    text: e instanceof Error ? e.message : String(e),
  });
}

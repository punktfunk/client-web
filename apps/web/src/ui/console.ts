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
  exitApp,
  gameEndNotice,
  type Host,
  type LibraryEntry,
  packaged,
  pageLog,
  remoteKey,
  tizen,
  tvBack,
} from "@punktfunk/stream";
import { FrameMeter, type Row, type Step, Sweep, table } from "./console-cost.ts";
import { coverBytes } from "./cover.ts";
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

/** The kit's settings key for its reduced interface, on every platform but webOS. */
const REDUCED_KEY = "android.reduce_ui_resolution";

/** How much drawing one cost line in the page's log covers. */
const COST_WINDOW_MS = 60_000;

/** Set by `vite.config.ts` from `PF_BENCH=1`. */
declare const __PF_BENCH__: boolean;

/**
 * A measuring page: built as one, or opened with `?bench`. It prices the console on the first
 * screen as a desktop draws it, reloads, prices it reduced, and shows both over the console.
 * F9 or the remote's red key then prices whatever screen is showing.
 */
const MEASURING =
  (typeof __PF_BENCH__ !== "undefined" && __PF_BENCH__) || new URLSearchParams(location.search).has("bench");

/** Set by `vite.config.ts` from `PF_BENCH_REPORT`: a URL a measuring page also posts its
 *  tables to, for a set whose screen nobody at the desk can read. */
declare const __PF_BENCH_REPORT__: string | undefined;
const REPORT_URL = typeof __PF_BENCH_REPORT__ === "undefined" ? undefined : __PF_BENCH_REPORT__;

/** Where a measuring page keeps its place across its own reload: this tab only. */
const BOOT_KEY = "pf.bench";

/** A measuring page's place: the interface this load draws, and the rows the last one counted.
 *  `swept` once both have been, so a later reload does not start over. */
interface Boot {
  reduced: boolean;
  rows: Row[];
  swept: boolean;
}

/** The remote's red key, once the set has been asked for it. */
const RED_KEY = 403;

/** A screen that has shown this long with no cover arriving and no change is settled, and a
 *  measuring page prices it once more: a remote with no spare key still gets every screen. */
const QUIET_MS = 15_000;

/** The screens the console cannot draw; everything else is the console's. */
const WEB_SCREENS = new Set<Screen["kind"]>(["accept", "trust", "link", "streaming"]);

/** How long a wake is waited on before the console hears it did not come back. */
const WAKE_TIMEOUT_S = 60;

/** Covers handed to the console a frame — what its host decodes in one — and covers the browser
 *  decodes at once. */
const COVERS_PER_FRAME = 3;
const COVERS_DECODING = 4;

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
  /** The set's own keyboard, for the fields the console opens: an offscreen input that the IME
   *  types into, whose text is fed to the console. Only on a TV; elsewhere the console draws
   *  its own tray. */
  private readonly ime: HTMLInputElement | null;
  /** What the IME field last held, so an `input` event is read as the characters that changed. */
  private imeText = "";
  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onPointer: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  /** What console frames cost, closed into a line a minute for the page's log. */
  private readonly meter = new FrameMeter();
  /** A measuring page's place, the sweep it is running, and the panel the table goes on. */
  private readonly boot: Boot | null = MEASURING ? readBoot() : null;
  private sweep: Sweep | null = null;
  private readonly panel: HTMLPreElement | null;
  /** Why the running sweep runs, as its heading says. */
  private why = "at start";
  /** When the last cover was handed over, when the player last moved, and when the last settled
   *  sweep began: one settled sweep per rest, where a rest is quiet on all three. */
  private artAt = 0;
  private inputAt = 0;
  private settledAt = -1;
  /** Covers the browser has decoded, waiting to go over a few a frame, with the shelf each is
   *  for; and the decodes still to run, a few at once. */
  private readonly covers: Array<[string, string, Uint8Array]> = [];
  private readonly toDecode: Array<() => Promise<void>> = [];
  private decoding = 0;
  /** The main thread's long tasks that were not a console frame, in ms since the last frame
   *  counted, told apart from the frames by when they ran. */
  private other = 0;
  private readonly frames: Array<{ start: number; end: number }> = [];
  private observer: PerformanceObserver | null = null;
  /** The drawing buffer's share of the canvas, each way: a sweep's step may draw smaller. */
  private scale = 1;

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
    this.ime = tizen() ? imeField() : null;
    this.panel = MEASURING
      ? Object.assign(document.createElement("pre"), {
          hidden: true,
          className:
            "pointer-events-none fixed top-4 left-4 z-3 m-0 rounded-md bg-black/85 px-4 py-3 font-mono text-sm leading-relaxed text-white",
        })
      : null;
    if (MEASURING && "PerformanceObserver" in window) {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const t of list.getEntries()) {
            const end = t.startTime + t.duration;
            // The task that ran a console frame counts only for what it did beside that frame.
            const frame = this.frames.find((f) => f.start < end && t.startTime < f.end);
            this.other += frame ? Math.max(0, t.duration - (frame.end - frame.start)) : t.duration;
          }
        });
        this.observer.observe({ type: "longtask", buffered: false });
      } catch {
        this.observer = null;
      }
    }
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
    if (this.ime) {
      document.body.append(this.ime);
      this.ime.addEventListener("input", () => this.imeInput());
      this.ime.addEventListener("keydown", (e) => this.imeKey(e));
    }
    if (this.panel) {
      document.body.append(this.panel);
      remoteKey("ColorF0Red");
    }
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
    // A page-level change of screen counts as a move, as a key does.
    if (was?.kind !== screen.kind) this.inputAt = performance.now();
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
    this.ime?.remove();
    this.panel?.remove();
    this.observer?.disconnect();
    this.fallback.destroy();
  }

  // --- drawing ------------------------------------------------------------------------------
  private frame(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.scale;
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
        // The host sets the budget itself, at the kit's floor; this is the kit's record of it.
        gpu_cache_bytes: 96 << 20,
        // A TV: no clipboard to copy a link to, no phone sensors to offer rows for. Its own
        // keyboard types into the console's fields, so the console draws no tray of its own.
        tv: tizen(),
        system_keyboard: tizen(),
        // The console kit's Tizen platform: the page's rows, a remote's glyphs, and an exit.
        tizen: tizen(),
        settings: this.startSettings(),
      });
      if (!this.started) {
        console.error("punktfunk: the console could not start; the web shell stays up");
        this.mounted = false;
        return;
      }
      if (this.screen) this.render(this.screen);
      // Once the first screen has settled, and unasked: a set may have no key to ask with.
      if (this.boot && !this.boot.swept) setTimeout(() => this.measure("at start"), 3000);
    }
    if (this.showing()) this.pad();
    // Covers go over at the rate the console takes them in a frame, so its queue stays short.
    // Timed with the frame: the copy into wasm is this page's own cost of a cover.
    const before = performance.now();
    for (let n = 0; n < COVERS_PER_FRAME && this.covers.length > 0; n++) {
      const [shelf, id, bytes] = this.covers.shift()!;
      if (shelf !== this.shelf) continue;
      this.artAt = before;
      this.engine.console.art(id, bytes);
    }
    // Room again for the next decodes.
    if (this.toDecode.length > 0) this.decodeNext();
    const drew = this.engine.console.frame(width, height);
    const now = performance.now();
    if (drew && this.observer) {
      this.frames.push({ start: before, end: now });
      if (this.frames.length > 16) this.frames.shift();
    }
    if (drew) this.cost(now - before, now, width, height);
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
    if (!showing) {
      // A window across a stream would count its minutes as frames not drawn.
      this.meter.reset();
      if (this.sweep?.step) {
        this.sweep = null;
        this.drawAs(undefined);
      }
      if (this.panel) this.panel.hidden = true;
    } else if (this.boot?.swept && !this.sweep?.step) {
      this.measureSettled(now);
    }
  }

  /** What the console starts from. The reduced interface is a start-time fact: the console
   *  reads its settings again only when the player changes one. */
  private startSettings(): Record<string, unknown> {
    const saved = savedSettings();
    if (this.boot) return { ...saved, [REDUCED_KEY]: this.boot.reduced };
    // A set's graphics chip is far slower than its panel, as on the kit's other TV hosts. The
    // kit learns this default at the next pin; until then the page says it.
    return tizen() ? { [REDUCED_KEY]: true, ...saved } : saved;
  }

  // --- what a frame costs ---------------------------------------------------------------------
  /** One drawn frame's time: into the sweep while one runs, else into the minute's line. */
  private cost(ms: number, now: number, width: number, height: number): void {
    const sweep = this.sweep;
    if (sweep?.step) {
      const other = this.other;
      this.other = 0;
      if (!sweep.frame(ms, now, other)) return;
      this.drawAs(sweep.step);
      if (!sweep.step) this.swept(sweep.rows);
      return;
    }
    const w = this.meter.add(ms, now, COST_WINDOW_MS);
    if (!w) return;
    console.info(
      `punktfunk: console ${width}x${height}: ${w.frames} frames in ${w.seconds.toFixed(1)} s, ` +
        `main thread ${w.meanMs.toFixed(1)} ms mean, ${w.peakMs.toFixed(1)} ms peak`,
    );
  }

  /** Price the screen that is showing, step by step. A running sweep finishes first. */
  private measure(why: string): void {
    if (!this.boot || !this.showing() || this.sweep?.step) return;
    this.why = why;
    this.sweep = new Sweep(performance.now());
    this.drawAs(this.sweep.step);
  }

  /** Price the screen once more once it has settled: no cover and no input for a while, and
   *  not since the player last moved. The page cannot see where the console went, so the rest
   *  after each move is what names a screen; the heading says whether it is the root. */
  private measureSettled(now: number): void {
    if (this.settledAt > this.inputAt || now - this.artAt < QUIET_MS || now - this.inputAt < QUIET_MS) return;
    this.settledAt = now;
    this.measure(`settled${this.state & CONSOLE_STATE.AT_ROOT ? " at the root" : ""}`);
  }

  /** Draw as a sweep's step says; with none, as the console draws by itself. A sweep also
   *  lifts the idle frame cap, so its rate is the device's. */
  private drawAs(step: Step | undefined): void {
    this.engine.console.leaveOut(step ? !step.blur : false, step ? !step.motion : false, !!step);
    this.scale = step?.scale ?? 1;
    if (step && this.panel) {
      this.panel.textContent = `measuring: ${this.tier()}, ${step.name}`;
      this.panel.hidden = false;
    }
  }

  /** The interface this load draws, as a sweep's rows name it. */
  private tier(): string {
    return this.boot?.reduced ? "reduced" : "full";
  }

  /**
   * A finished sweep. The first load's is the full interface: its rows are kept and the page
   * loads again reduced. After that a table goes over the console, and into the page's log for
   * a sent one.
   */
  private swept(rows: readonly Row[]): void {
    const boot = this.boot;
    if (!boot) return;
    const mine = rows.map((r) => ({ ...r, step: `${this.tier()}: ${r.step}` }));
    const first = !boot.swept && !boot.reduced;
    const all = boot.swept || first ? mine : [...boot.rows, ...mine];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = `${Math.round(this.canvas.clientWidth * dpr)}x${Math.round(this.canvas.clientHeight * dpr)}`;
    const lines = table(`${this.screen?.kind ?? "console"}, ${this.why}, at ${size}`, all);
    for (const line of lines) console.info(`punktfunk: console sweep: ${line}`);
    // A beacon, so the first load's half is not lost to the reload that follows it. The log's
    // tail goes with it: what the page and the wasm said while the rows were counted.
    if (REPORT_URL) {
      const tail = pageLog().split("\n").slice(-40).join("\n");
      // Chromium's own heap figure, where it has one: the page's memory on a 2 GB set.
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
      const state = `heap ${heap ? Math.round(heap / 1e6) : "?"} MB, covers queued ${this.covers.length}, to decode ${this.toDecode.length}`;
      navigator.sendBeacon?.(REPORT_URL, [navigator.userAgent, ...lines, state, "--- log", tail].join("\n"));
    }
    if (first) {
      writeBoot({ reduced: true, rows: mine, swept: false });
      location.reload();
      return;
    }
    boot.swept = true;
    boot.rows = [];
    writeBoot(boot);
    if (!this.panel) return;
    this.panel.textContent = lines.join("\n");
    this.panel.hidden = false;
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
    if (MEASURING && (e.code === "F9" || e.keyCode === RED_KEY)) {
      e.preventDefault();
      if (!e.repeat) this.measure("on request");
      return;
    }
    // A table that has been read gives the console its corner back at the next key.
    if (this.panel && !this.sweep?.step) this.panel.hidden = true;
    // The set's keyboard has the field: its keys are its own (`imeKey`), not the console's.
    if (this.ime && document.activeElement === this.ime) return;
    if (this.state & CONSOLE_STATE.EDITING && e.key.length === 1) {
      e.preventDefault();
      this.engine.console.text(e.key);
      return;
    }
    const key = KEYS[e.code];
    if (key === undefined) return;
    e.preventDefault();
    this.inputAt = performance.now();
    this.engine.console.key(key, e.shiftKey, e.repeat);
  }

  /**
   * The console opened a field. On a TV the set's keyboard takes it: the offscreen input gets
   * the field's text and focus, which opens the on-screen keyboard, and what is typed there
   * reaches the console through `imeInput`. Closed, the input lets go.
   */
  private editField(field: { text: string; digits: boolean } | null): void {
    if (!this.ime) return;
    if (!field) {
      this.imeText = "";
      this.ime.value = "";
      this.ime.blur();
      return;
    }
    this.imeText = field.text;
    this.ime.value = field.text;
    // A PIN or a port wants the number pad; an address wants the dot beside the digits.
    this.ime.inputMode = field.digits ? "numeric" : "decimal";
    this.ime.focus();
    this.ime.setSelectionRange(field.text.length, field.text.length);
  }

  /** The IME changed the field: the console hears the characters that went, then those that
   *  came. It edits at the caret's end, which is where a remote's keyboard types. */
  private imeInput(): void {
    if (!this.ime) return;
    const next = this.ime.value;
    const was = this.imeText;
    let common = 0;
    while (common < was.length && common < next.length && was[common] === next[common]) common++;
    for (let i = common; i < was.length; i++) this.engine.console.key(KEYS["Backspace"]!, false, false);
    if (next.length > common) this.engine.console.text(next.slice(common));
    this.imeText = next;
  }

  /** The keys the set's keyboard sends the field itself: Done (`Select`) and Enter confirm,
   *  Back leaves the field. Everything else is the keyboard's own. */
  private imeKey(e: KeyboardEvent): void {
    if (e.key === "Select" || e.key === "Enter") {
      e.preventDefault();
      this.engine.console.key(KEYS["Enter"]!, false, false);
    } else if (tvBack(e)) {
      e.preventDefault();
      this.engine.console.key(KEYS["Escape"]!, false, false);
    }
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
    if (buttons || lx || ly) this.inputAt = performance.now();
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
      this.toDecode.push(async () => {
        try {
          const blob = await (await fetch(url)).blob();
          // Decoded and sized by the browser where it can; the encoded bytes otherwise.
          const bytes = (await coverBytes(blob)) ?? new Uint8Array(await blob.arrayBuffer());
          if (this.shelf === origin) this.covers.push([origin, id, bytes]);
        } catch {
          this.artSent.delete(id);
        }
      });
    }
    this.decodeNext();
  }

  /** Run the waiting cover decodes, [`COVERS_DECODING`] at once, and none while the console
   *  is behind on taking them: a decode is faster than a slow frame, and a library's worth of
   *  bitmaps waiting in the heap is what put a 2 GB set into seconds-long pauses. */
  private decodeNext(): void {
    while (
      this.decoding < COVERS_DECODING &&
      this.toDecode.length > 0 &&
      this.covers.length + this.decoding < COVERS_PER_FRAME * 3
    ) {
      const job = this.toDecode.shift()!;
      this.decoding++;
      void job().finally(() => {
        this.decoding--;
        this.decodeNext();
      });
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
    if ("edit_text" in e) return this.editField(e.edit_text);
    if ("editing" in e) {
      if (!e.editing) this.editField(null);
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
    // Back at the console's root, on a platform that can quit: the exit prompt said yes.
    if (a === "Quit") {
      if (!exitApp()) console.warn("punktfunk: the console asked to quit, and this page cannot");
      return;
    }
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

/** The input the set's keyboard types into. Off screen and out of the tab order, but a real
 *  field: Samsung's runtime opens its on-screen keyboard for a focused one and nothing else. */
function imeField(): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0";
  return input;
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

/** A measuring page's place, or the start. `?bench=full` starts on the full interface and
 *  reloads into the reduced one after its first sweep; otherwise the page starts reduced, which
 *  is what a set draws, and never reloads. */
function readBoot(): Boot {
  try {
    const boot = JSON.parse(sessionStorage.getItem(BOOT_KEY) ?? "") as Boot;
    if (typeof boot.reduced === "boolean" && Array.isArray(boot.rows)) return boot;
  } catch {
    // Nothing kept, or no storage: the start.
  }
  const full = new URLSearchParams(location.search).get("bench") === "full";
  return { reduced: !full, rows: [], swept: false };
}

function writeBoot(boot: Boot): void {
  try {
    sessionStorage.setItem(BOOT_KEY, JSON.stringify(boot));
  } catch {
    // No storage: the reload starts over, and the full interface is priced twice.
  }
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

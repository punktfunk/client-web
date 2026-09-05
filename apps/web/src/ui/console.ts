// The gamepad interface: `pf-console-ui` on a canvas, the same shell every other punktfunk
// client draws — Android, tvOS, webOS, the desktop session.
//
// It is the right interface across a room with a controller, and the wrong one for typing a host
// address into a browser: it has no text field, because a D-pad shell cannot have one. So this
// composes rather than replaces. The web shell keeps the screens where someone has to type or
// point, and the console takes over once a session is live, which is where a gamepad shell earns
// its place.
//
// Nothing here reaches into Skia or GL: `pf_start` and `pf_frame` are wasm exports, and the one
// place a graphics object is named is `pf-glue.ts`.

import type { Engine } from "@punktfunk/stream";
import type { Actions, Screen, Ui } from "./types.ts";

/** Index into the console's key table (`KEYS` in `src/host.rs`). Anything absent stays the
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

export class ConsoleUi implements Ui {
  private started = false;
  private live = false;
  private mounted = false;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(
    private readonly engine: Engine,
    private readonly canvas: HTMLCanvasElement,
    /** The screens a canvas shell cannot draw. Everything before a session belongs to it. */
    private readonly fallback: Ui,
  ) {
    this.onKey = (e) => {
      if (!this.live) return;
      const key = KEYS[e.code];
      if (key === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      this.engine.console.key(key, e.shiftKey, e.repeat);
    };
  }

  mount(actions: Actions): void {
    this.fallback.mount(actions);
    window.addEventListener("keydown", this.onKey);
    // Its own loop: the engine's frame loop is for the session, and the console must draw at
    // the display's rate whether or not anything is streaming.
    const loop = () => {
      if (!this.mounted) return;
      this.frame();
      requestAnimationFrame(loop);
    };
    this.mounted = true;
    requestAnimationFrame(loop);
  }

  render(screen: Screen): void {
    this.live = screen.kind === "streaming";
    // Before a session, and on any error, the web shell is the only one that can say anything
    // useful. Streaming screens go through untouched: the web shell draws only its HUD there,
    // which leaves the console's canvas unobstructed.
    this.fallback.render(screen);
  }

  private frame(): void {
    if (!this.live) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (!this.started) {
      // Deferred to the first live frame: the canvas is sized by then, and a console started
      // against a zero-sized canvas comes up with a broken surface.
      this.started = this.engine.console.start(width, height);
      if (!this.started) {
        console.error("punktfunk: the console could not start; the web shell stays up");
        this.live = false;
        return;
      }
    }
    this.engine.console.frame(width, height);
  }

  destroy(): void {
    this.mounted = false;
    window.removeEventListener("keydown", this.onKey);
    this.fallback.destroy();
  }
}

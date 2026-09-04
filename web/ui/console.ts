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

import type { PunktfunkModule } from "../emscripten.js";
import type { Actions, Screen, Ui } from "./types.js";

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
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(
    private readonly mod: PunktfunkModule,
    /** The screens a canvas shell cannot draw. Everything before a session belongs to it. */
    private readonly fallback: Ui,
  ) {
    this.onKey = (e) => {
      if (!this.live) return;
      const key = KEYS[e.code];
      if (key === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      this.mod._pf_key(key, e.shiftKey ? 1 : 0, e.repeat ? 1 : 0);
    };
  }

  mount(actions: Actions): void {
    this.fallback.mount(actions);
    window.addEventListener("keydown", this.onKey);
  }

  render(screen: Screen): void {
    this.live = screen.kind === "streaming";
    // Before a session, and on any error, the web shell is the only one that can say anything
    // useful. It renders an empty screen while streaming, so the canvas is unobstructed.
    this.fallback.render(this.live ? { kind: "streaming", stats: screen_stats(screen) } : screen);
  }

  frame(width: number, height: number): void {
    if (!this.live) return;
    if (!this.started) {
      // Deferred to the first live frame: the canvas is sized by then, and a console started
      // against a zero-sized canvas comes up with a broken surface.
      this.started = this.mod._pf_start(width, height) === 1;
      if (!this.started) {
        console.error("punktfunk: the console could not start; the web shell stays up");
        this.live = false;
        return;
      }
    }
    this.mod._pf_frame(width, height);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKey);
    this.fallback.destroy();
  }
}

// `render` narrows to the streaming arm above; this keeps that readable without a cast at the
// call site.
function screen_stats(screen: Screen): Extract<Screen, { kind: "streaming" }>["stats"] {
  if (screen.kind !== "streaming") throw new Error("not a streaming screen");
  return screen.stats;
}

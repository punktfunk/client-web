// Browser events in, host input out.
//
// The only file that reads a `KeyboardEvent`, a `PointerEvent` or `navigator.getGamepads()`.
// What it produces is the vocabulary core's `InputKind` documents: a Windows virtual-key code
// per physical key, GameStream button ids for the mouse, wheel notches in 120ths, stick values
// with +y up. Rust encodes; this decides what to say and when.
//
// Attached while a session streams and detached the moment it stops, so a page that shows the
// picker again is not still swallowing its own keystrokes.

import type { PunktfunkModule } from "./emscripten.ts";

/** `InputKind`, by number. Kept beside the wire it mirrors. */
const KIND = {
  KEY_DOWN: 0,
  KEY_UP: 1,
  MOUSE_MOVE: 2,
  MOUSE_MOVE_ABS: 3,
  MOUSE_BUTTON_DOWN: 4,
  MOUSE_BUTTON_UP: 5,
  MOUSE_SCROLL: 6,
  TOUCH_DOWN: 9,
  TOUCH_MOVE: 10,
  TOUCH_UP: 11,
} as const;

/** Core's `gamepad::BTN_*`, indexed by the Standard Gamepad button order. */
const STANDARD_BUTTONS: readonly number[] = [
  0x1000, // 0 A
  0x2000, // 1 B
  0x4000, // 2 X
  0x8000, // 3 Y
  0x0100, // 4 LB
  0x0200, // 5 RB
  0, // 6 LT — an axis on the wire
  0, // 7 RT
  0x0020, // 8 Back
  0x0010, // 9 Start
  0x0040, // 10 LS click
  0x0080, // 11 RS click
  0x0001, // 12 D-pad up
  0x0002, // 13 down
  0x0004, // 14 left
  0x0008, // 15 right
  0x0400, // 16 Guide
];

/**
 * `KeyboardEvent.code` → Windows virtual-key code, which is what the wire carries and what
 * the host maps back to its own keyboard. Physical position, not what the key prints: a layout
 * is the host's business. Unlisted keys (media, browser shortcuts) are not sent.
 */
const VK: Readonly<Record<string, number>> = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, NumpadEnter: 0x0d, Pause: 0x13, CapsLock: 0x14,
  Escape: 0x1b, Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, PrintScreen: 0x2c,
  Insert: 0x2d, Delete: 0x2e,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34, Digit5: 0x35,
  Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46, KeyG: 0x47,
  KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4a, KeyK: 0x4b, KeyL: 0x4c, KeyM: 0x4d, KeyN: 0x4e,
  KeyO: 0x4f, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52, KeyS: 0x53, KeyT: 0x54, KeyU: 0x55,
  KeyV: 0x56, KeyW: 0x57, KeyX: 0x58, KeyY: 0x59, KeyZ: 0x5a,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64, Numpad5: 0x65,
  Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69, NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78,
  F10: 0x79, F11: 0x7a, F12: 0x7b, F13: 0x7c, F14: 0x7d, F15: 0x7e, F16: 0x7f, F17: 0x80,
  F18: 0x81, F19: 0x82, F20: 0x83, F21: 0x84, F22: 0x85, F23: 0x86, F24: 0x87,
  NumLock: 0x90, ScrollLock: 0x91,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4,
  AltRight: 0xa5,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf,
  Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde,
  IntlBackslash: 0xe2,
};

/** Browser `MouseEvent.button` → GameStream button id (X1/X2 are 4/5 there). */
const MOUSE_BUTTON: readonly number[] = [1, 2, 3, 4, 5];

/** One wheel notch on the wire. */
const WHEEL_NOTCH = 120;

/** Sticks: the browser gives −1..1, the wire wants i16. */
const STICK = 32767;

export interface InputOptions {
  /** The surface the pointer is measured against: the stream's own size in pixels. */
  streamWidth: number;
  streamHeight: number;
  /** `absolute` maps the local cursor onto the remote one; `capture` takes pointer lock and
   *  sends relative motion. Stick travel below `deadzone` is rest. */
  pointer: "absolute" | "capture";
  deadzone: number;
}

/**
 * Every listener the session needs, on one canvas. `attach` starts them, `detach` removes
 * every one; `poll` reads the gamepads and is called once per frame by the engine's loop.
 */
export class InputPipe {
  private readonly off: Array<() => void> = [];
  private pads = new Set<number>();
  /** Fractional wheel travel carried to the next event, so slow scrolls still arrive. */
  private wheel = { x: 0, y: 0 };
  private touches = new Map<number, number>();

  constructor(
    private readonly mod: PunktfunkModule,
    private readonly canvas: HTMLCanvasElement,
    private opts: InputOptions,
  ) {}

  /** Is the pointer locked to the canvas right now? Asking the document rather than tracking a
   *  flag: the browser releases the lock on its own (Escape, losing the tab) and never asks. */
  get captured(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /**
   * Change what can change mid-session: the pointer mode, the deadzone, and the stream size a
   * reconfigure just negotiated. Leaving `capture` releases the lock immediately — a mode the
   * shell has turned off must not still be holding the mouse.
   */
  tune(next: Partial<InputOptions>): void {
    const was = this.opts.pointer;
    this.opts = { ...this.opts, ...next };
    // Only a real move away from capture releases. Tuning the deadzone, or the size a
    // reconfigure just negotiated, must not drop a lock someone took by hand.
    if (was === "capture" && this.opts.pointer !== "capture" && this.captured) {
      document.exitPointerLock();
    }
  }

  /**
   * Take or release the pointer now, whatever the mode says.
   *
   * The mode decides whether a click on the picture grabs the mouse; this is the shell's own
   * button, and it has to work either way. Taking the lock needs a user gesture, so this only
   * succeeds when called from one — the browser rejects it otherwise, and the promise is caught
   * because a refusal is not an error worth propagating.
   */
  capture(on: boolean): void {
    if (on === this.captured) return;
    if (on) void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    else document.exitPointerLock();
  }

  attach(): void {
    const c = this.canvas;
    c.tabIndex = 0;
    c.style.touchAction = "none";
    this.on(window, "keydown", (e: KeyboardEvent) => this.key(e, true));
    this.on(window, "keyup", (e: KeyboardEvent) => this.key(e, false));
    this.on(c, "pointerdown", (e: PointerEvent) => this.pointer(e, "down"));
    this.on(c, "pointermove", (e: PointerEvent) => this.pointer(e, "move"));
    this.on(c, "pointerup", (e: PointerEvent) => this.pointer(e, "up"));
    this.on(c, "pointercancel", (e: PointerEvent) => this.pointer(e, "up"));
    this.on(c, "wheel", (e: WheelEvent) => this.scroll(e), { passive: false });
    this.on(c, "contextmenu", (e: Event) => e.preventDefault());
    // The pad set is polled; these only keep the arrival and removal events honest.
    this.on(window, "gamepadconnected", (e: GamepadEvent) => this.arrive(e.gamepad.index));
    this.on(window, "gamepaddisconnected", (e: GamepadEvent) => this.leave(e.gamepad.index));
    for (const g of navigator.getGamepads()) if (g) this.arrive(g.index);
    c.focus();
  }

  detach(): void {
    for (const f of this.off.splice(0)) f();
    for (const pad of [...this.pads]) this.leave(pad);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.touches.clear();
  }

  /** Once per frame: the pads. Buttons and sticks are read whole; Rust sends what changed. */
  poll(): void {
    for (const g of navigator.getGamepads()) {
      if (!g || !this.pads.has(g.index)) continue;
      let buttons = 0;
      g.buttons.forEach((b, i) => {
        if (b.pressed && STANDARD_BUTTONS[i]) buttons |= STANDARD_BUTTONS[i]!;
      });
      const stick = (v: number | undefined) => {
        const x = v ?? 0;
        return Math.abs(x) < this.opts.deadzone ? 0 : Math.round(x * STICK);
      };
      const trigger = (i: number) => Math.round((g.buttons[i]?.value ?? 0) * 255);
      // Browser sticks are +y down; the wire is +y up.
      this.mod._pf_gamepad(
        g.index, buttons,
        stick(g.axes[0]), -stick(g.axes[1]),
        stick(g.axes[2]), -stick(g.axes[3]),
        trigger(6), trigger(7),
      );
    }
  }

  // --- keyboard --------------------------------------------------------------------------
  private key(e: KeyboardEvent, down: boolean): void {
    // A field elsewhere on the page keeps its keys: the HUD has none, but a consumer's might.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const vk = VK[e.code];
    if (vk === undefined) return;
    // Held keys repeat on the host; the browser's own repeat would double them.
    if (down && e.repeat) return;
    e.preventDefault();
    this.mod._pf_input(down ? KIND.KEY_DOWN : KIND.KEY_UP, vk, 0, 0, 0);
  }

  // --- pointer ---------------------------------------------------------------------------
  private pointer(e: PointerEvent, phase: "down" | "move" | "up"): void {
    if (e.pointerType === "touch") return this.touch(e, phase);
    e.preventDefault();
    if (phase === "down") {
      this.canvas.focus();
      // Pointer lock can only be taken from a gesture, so the first click in capture mode is
      // what arms it. `catch` because the browser refuses one that follows an exit too closely.
      if (this.opts.pointer === "capture" && !this.captured) {
        void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
      }
    }
    // Locked, the cursor does not move and only the delta means anything; unlocked, the local
    // cursor maps onto the remote one, which is what a desktop wants — the pointer tracks on
    // hover, with no click needed.
    if (phase === "move") {
      if (this.captured) {
        if (e.movementX || e.movementY) {
          this.mod._pf_input(KIND.MOUSE_MOVE, 0, e.movementX, e.movementY, 0);
        }
        return;
      }
      const [x, y] = this.stream(e);
      this.mod._pf_input(KIND.MOUSE_MOVE_ABS, 0, x, y, this.extent());
      return;
    }
    const button = MOUSE_BUTTON[e.button];
    if (button === undefined) return;
    // Put the pointer where the click is before the click lands — but not while locked, where
    // there is no local position to speak of and sending one would teleport the remote cursor.
    if (!this.captured) {
      const [x, y] = this.stream(e);
      this.mod._pf_input(KIND.MOUSE_MOVE_ABS, 0, x, y, this.extent());
    }
    this.mod._pf_input(phase === "down" ? KIND.MOUSE_BUTTON_DOWN : KIND.MOUSE_BUTTON_UP, button, 0, 0, 0);
  }

  private touch(e: PointerEvent, phase: "down" | "move" | "up"): void {
    e.preventDefault();
    let slot = this.touches.get(e.pointerId);
    if (slot === undefined) {
      if (phase !== "down") return;
      slot = 0;
      while ([...this.touches.values()].includes(slot)) slot++;
      this.touches.set(e.pointerId, slot);
    }
    if (phase === "up") {
      this.touches.delete(e.pointerId);
      this.mod._pf_input(KIND.TOUCH_UP, slot, 0, 0, 0);
      return;
    }
    const [x, y] = this.stream(e);
    this.mod._pf_input(phase === "down" ? KIND.TOUCH_DOWN : KIND.TOUCH_MOVE, slot, x, y, this.extent());
  }

  private scroll(e: WheelEvent): void {
    e.preventDefault();
    // Pixels, lines or pages, in that order of `deltaMode`; each to notches. 100 px and 3
    // lines are what a notch is in the engines that report those units.
    const notch = e.deltaMode === 0 ? 100 : e.deltaMode === 1 ? 3 : 1;
    this.wheel.y += (e.deltaY / notch) * WHEEL_NOTCH;
    this.wheel.x += (e.deltaX / notch) * WHEEL_NOTCH;
    const vy = Math.trunc(this.wheel.y);
    if (vy) {
      this.wheel.y -= vy;
      this.mod._pf_input(KIND.MOUSE_SCROLL, 0, vy, 0, 0);
    }
    const vx = Math.trunc(this.wheel.x);
    if (vx) {
      this.wheel.x -= vx;
      this.mod._pf_input(KIND.MOUSE_SCROLL, 1, vx, 0, 0);
    }
  }

  /** Where on the stream a pointer is, in the stream's own pixels. */
  private stream(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * this.opts.streamWidth;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * this.opts.streamHeight;
    return [Math.round(x), Math.round(y)];
  }

  /** `(width << 16) | height`, the absolute-position reference the wire carries. */
  private extent(): number {
    return (((this.opts.streamWidth & 0xffff) << 16) | (this.opts.streamHeight & 0xffff)) >>> 0;
  }

  // --- gamepads --------------------------------------------------------------------------
  private arrive(index: number): void {
    if (this.pads.has(index)) return;
    this.pads.add(index);
    this.mod._pf_gamepad_arrival(index);
  }

  private leave(index: number): void {
    if (!this.pads.delete(index)) return;
    this.mod._pf_gamepad_remove(index);
  }

  private on<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  private on(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn as EventListener, opts);
    this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }
}

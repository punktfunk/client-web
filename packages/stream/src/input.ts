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
import { type Action, type Device, Engine, keyName, MODIFIER_VKS, type Out, type Shortcuts } from "./shortcuts.ts";

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

/** `MouseEvent.buttons` bits, each with the `button` index it stands for: right is the second
 *  bit but the third index. */
const BUTTON_BITS: ReadonlyArray<readonly [bit: number, button: number]> = [
  [1, 0],
  [2, 2],
  [4, 1],
  [8, 3],
  [16, 4],
];

/** Both Meta keys' virtual-key codes. */
const META: ReadonlySet<number> = new Set([0x5b, 0x5c]);

/** Left and right Shift, Ctrl and Alt, as the one modifier a shortcut names. */
const FOLD: Readonly<Record<number, number>> = { 0xa0: 0x10, 0xa1: 0x10, 0xa2: 0x11, 0xa3: 0x11, 0xa4: 0x12, 0xa5: 0x12 };

/** The stored name of the key at `code`, for a recorded shortcut; undefined for a key the wire lacks. */
export function shortcutKey(code: string): string | undefined {
  const vk = VK[code];
  return vk === undefined ? undefined : keyName(FOLD[vk] ?? vk);
}

/** A standard-mapping pad's pressed buttons as core's `gamepad::BTN_*` bits. */
export function padButtons(g: Gamepad): number {
  let buttons = 0;
  g.buttons.forEach((b, i) => {
    if (b.pressed && STANDARD_BUTTONS[i]) buttons |= STANDARD_BUTTONS[i]!;
  });
  return buttons;
}

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
  /** Scroll against the wheel's own direction. */
  invertScroll?: boolean;
  /** The bindings the keyboard and each pad run on, read when the pipe is made. Pass only the
   *  actions `onShortcut` performs. */
  shortcuts?: Shortcuts;
  /** A shortcut fired, on a pad or the keyboard; its keys never reach the host. The remote's
   *  Back fires `ring`. */
  onShortcut?: (action: Action, device: Device) => void;
}

/**
 * A TV remote's Back. Samsung's runtime sends it as `code: "Escape"` with `key: "XF86Back"` and
 * `keyCode` 10009; the page's way out of a stream is this key, so it opens the menu and is never
 * forwarded to the host as Escape — a keyboard's Escape still is.
 */
export function tvBack(e: KeyboardEvent): boolean {
  return e.key === "XF86Back" || e.keyCode === 10009;
}

/**
 * Every listener the session needs, on one canvas. `attach` starts them, `detach` removes
 * every one; `poll` reads the gamepads and is called once per frame by the engine's loop.
 */
export class InputPipe {
  private readonly off: Array<() => void> = [];
  /** Fractional wheel travel carried to the next event, so slow scrolls still arrive. */
  private wheel = { x: 0, y: 0 };
  private touches = new Map<number, number>();
  /** Keys and mouse buttons (`MouseEvent.buttons`) the host holds down, for a lost focus to let go of. */
  private keys = new Set<number>();
  /** Keys that went down while Meta was held. macOS sends no keyup for those, so Meta's own
   *  release lets go of them. */
  private underMeta = new Set<number>();
  private held = 0;
  /** The keyboard's shortcuts. Its ids are VKs with the modifiers folded (`FOLD`). */
  private readonly kb: Engine;
  /** The side of a folded modifier the host holds, by the engine's id. */
  private sides = new Map<number, number>();
  /** Per pad: its shortcuts, the buttons physically down, and the buttons the host holds. */
  private padState = new Map<number, { engine: Engine; physical: number; host: number }>();

  constructor(
    private readonly mod: PunktfunkModule,
    private readonly canvas: HTMLCanvasElement,
    private opts: InputOptions,
  ) {
    this.kb = new Engine(opts.shortcuts?.bindings ?? [], "key");
  }

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
   * succeeds when called from one.
   */
  capture(on: boolean): void {
    if (on === this.captured) return;
    if (on) this.lock();
    else document.exitPointerLock();
  }

  /**
   * Lock the pointer to the canvas with the mouse's own counts, before the OS's acceleration:
   * the host applies its pointer curve once, as for a local mouse. macOS keeps its curve: its
   * raw counts move the pointer a third as far as macOS does, and no host curve makes up the
   * rest. A browser that cannot drop the acceleration rejects with `NotSupportedError` and
   * gets a plain lock. Any other refusal (no gesture, an exit too recent) is not an error
   * worth propagating.
   */
  private lock(): void {
    const plain = () => Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    if (/^Mac/.test(navigator.platform)) return void plain();
    void Promise.resolve(this.canvas.requestPointerLock({ unadjustedMovement: true })).catch((e: unknown) =>
      (e as DOMException | undefined)?.name === "NotSupportedError" ? plain() : undefined,
    );
  }

  attach(): void {
    const c = this.canvas;
    c.tabIndex = 0;
    c.style.touchAction = "none";
    this.on(window, "keydown", (e: KeyboardEvent) => this.key(e, true));
    this.on(window, "keyup", (e: KeyboardEvent) => this.key(e, false));
    this.on(c, "pointerdown", (e: PointerEvent) => this.pointer(e, "down"));
    // Mouse motion raw where the browser has it (Chromium): `pointermove` arrives once a frame,
    // which holds every move back by up to a refresh. Touch keeps `pointermove`.
    if ("onpointerrawupdate" in c) {
      this.on(c, "pointerrawupdate" as "pointermove", (e: PointerEvent) => {
        if (e.pointerType !== "touch") this.pointer(e, "move");
      });
      // A second button pressed while one is held may come only as `pointermove`.
      this.on(c, "pointermove", (e: PointerEvent) => {
        if (e.pointerType === "touch") this.pointer(e, "move");
        else this.press(e.buttons);
      });
    } else {
      this.on(c, "pointermove", (e: PointerEvent) => this.pointer(e, "move"));
    }
    this.on(c, "pointerup", (e: PointerEvent) => this.pointer(e, "up"));
    this.on(c, "pointercancel", (e: PointerEvent) => this.pointer(e, "up"));
    this.on(c, "wheel", (e: WheelEvent) => this.scroll(e), { passive: false });
    this.on(c, "contextmenu", (e: Event) => e.preventDefault());
    // A release that lands in another window or tab never comes back here.
    this.on(window, "blur", () => this.release());
    this.on(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.release();
    });
    // The pad set is polled; these only keep the arrival and removal events honest.
    this.on(window, "gamepadconnected", (e: GamepadEvent) => this.arrive(e.gamepad));
    this.on(window, "gamepaddisconnected", (e: GamepadEvent) => this.leave(e.gamepad.index));
    for (const g of navigator.getGamepads()) if (g) this.arrive(g);
    c.focus();
  }

  detach(): void {
    for (const f of this.off.splice(0)) f();
    for (const pad of [...this.padState.keys()]) this.leave(pad);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.touches.clear();
  }

  /**
   * Once per frame: the pads. Buttons go through the pad's shortcuts, which decide what the host
   * holds; that and the sticks are sent whole, and Rust sends what changed. A bit that flips back
   * within one frame is sent between, so a tap's release is never folded away.
   */
  poll(): void {
    const now = performance.now();
    for (const g of navigator.getGamepads()) {
      const p = g && this.padState.get(g.index);
      if (!g || !p) continue;
      const buttons = padButtons(g);
      const outs: Out[] = [];
      for (let bit = 1, changed = buttons ^ p.physical; changed; bit <<= 1) {
        if (!(changed & bit)) continue;
        changed &= ~bit;
        outs.push(...p.engine.step(bit, (buttons & bit) !== 0, now));
      }
      p.physical = buttons;
      outs.push(...p.engine.tick(now));
      const stick = (v: number | undefined) => {
        const x = v ?? 0;
        return Math.abs(x) < this.opts.deadzone ? 0 : Math.round(x * STICK);
      };
      const trigger = (i: number) => Math.round((g.buttons[i]?.value ?? 0) * 255);
      // Browser sticks are +y down; the wire is +y up.
      const send = () =>
        this.mod._pf_gamepad(
          g.index, p.host,
          stick(g.axes[0]), -stick(g.axes[1]),
          stick(g.axes[2]), -stick(g.axes[3]),
          trigger(6), trigger(7),
        );
      let touched = 0;
      for (const o of outs) {
        if ("fire" in o) {
          // The lift reaches the host before the action runs.
          if (touched) send();
          touched = 0;
          this.fire(o, "pad");
          continue;
        }
        const [mask, down] = "forward" in o ? o.forward : [o.lift.reduce((a, b) => a | b, 0), false];
        const next = down ? p.host | mask : p.host & ~mask;
        const flip = next ^ p.host;
        if (touched & flip) {
          send();
          touched = 0;
        }
        touched |= flip;
        p.host = next;
      }
      send();
    }
  }

  // --- keyboard --------------------------------------------------------------------------
  private key(e: KeyboardEvent, down: boolean): void {
    // A field elsewhere on the page keeps its keys (the HUD has none, but a consumer's might), and
    // so does the page's own menu while it has focus.
    const t = e.target as HTMLElement | null;
    const local =
      !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || !!t.closest?.("[data-pf-keys=local]"));
    const vk = VK[e.code];
    // A release reaches the shortcuts wherever it lands: in the menu, a field, or after a chord.
    if (local) {
      if (!down && vk !== undefined) this.feed(vk, false, false);
      return;
    }
    if (tvBack(e)) {
      e.preventDefault();
      if (down && !e.repeat) this.opts.onShortcut?.("ring", "key");
      return;
    }
    if (vk === undefined) return;
    // Before the repeat check: a held Tab's own repeat would walk focus off the canvas.
    e.preventDefault();
    // Held keys repeat on the host; the browser's own repeat would double them.
    if (down && e.repeat) return;
    this.feed(vk, down, e.metaKey);
  }

  /** One key through the keyboard's shortcuts; what they forward reaches the host. */
  private feed(vk: number, down: boolean, meta: boolean): void {
    const id = FOLD[vk] ?? vk;
    if (down && id !== vk && !this.sides.has(id)) this.sides.set(id, vk);
    for (const o of this.kb.step(id, down, performance.now())) {
      if ("fire" in o) this.fire(o, "key");
      else if ("lift" in o) for (const k of o.lift) this.up(this.side(k));
      else if (!o.forward[1]) this.up(this.side(o.forward[0]));
      else {
        const real = this.sides.get(o.forward[0]) ?? o.forward[0];
        this.keys.add(real);
        if (meta && !META.has(real)) this.underMeta.add(real);
        this.mod._pf_input(KIND.KEY_DOWN, real, 0, 0, 0);
      }
    }
  }

  /** The VK the host holds for the engine's `id`; a modifier's side is forgotten with it. */
  private side(id: number): number {
    const vk = this.sides.get(id) ?? id;
    this.sides.delete(id);
    return vk;
  }

  /** The host lets go of `vk`, if it holds it. A Meta release also lets go of the keys pressed
   *  under it that are still down: their own keyups never come on macOS. */
  private up(vk: number): void {
    if (!this.keys.delete(vk)) return;
    this.underMeta.delete(vk);
    this.mod._pf_input(KIND.KEY_UP, vk, 0, 0, 0);
    if (!META.has(vk)) return;
    const under = [...this.underMeta];
    this.underMeta.clear();
    for (const k of under) this.feed(k, false, false);
  }

  /** A fired shortcut. `once` and `tap` run it; a key-like action's `down` and `up` have nothing
   *  to run here, since the page binds none. */
  private fire({ fire: [action, phase] }: { fire: [Action, string] }, device: Device): void {
    if (phase === "once" || phase === "tap") this.opts.onShortcut?.(action, device);
  }

  /** Let go of every key, button and pad the host holds. The next poll presses a pad's buttons
   *  that are still down again. */
  private release(): void {
    for (const o of this.kb.flush()) if ("lift" in o) for (const k of o.lift) this.up(this.side(k));
    for (const vk of this.keys) this.mod._pf_input(KIND.KEY_UP, vk, 0, 0, 0);
    this.keys.clear();
    this.underMeta.clear();
    this.sides.clear();
    this.press(0);
    for (const [pad, p] of this.padState) {
      p.engine.flush();
      p.physical = p.host = 0;
      this.mod._pf_gamepad(pad, 0, 0, 0, 0, 0, 0, 0);
    }
  }

  /** Send what changed in `MouseEvent.buttons`. A second button pressed or released while one is
   *  held arrives as `pointermove`, never as its own down or up, so every event is compared. */
  private press(buttons: number): void {
    const changed = buttons ^ this.held;
    this.held = buttons;
    for (const [bit, index] of BUTTON_BITS) {
      if (changed & bit) {
        this.mod._pf_input(buttons & bit ? KIND.MOUSE_BUTTON_DOWN : KIND.MOUSE_BUTTON_UP, MOUSE_BUTTON[index]!, 0, 0, 0);
      }
    }
  }

  // --- pointer ---------------------------------------------------------------------------
  private pointer(e: PointerEvent, phase: "down" | "move" | "up"): void {
    if (e.pointerType === "touch") return this.touch(e, phase);
    e.preventDefault();
    if (phase === "down") {
      this.canvas.focus();
      // Unlocked, a release over the HUD or another overlay still comes here.
      if (!this.captured) {
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {
          // A pointer the browser no longer tracks: nothing to capture.
        }
      }
      // Pointer lock can only be taken from a gesture, so the first click in capture mode is
      // what arms it.
      if (this.opts.pointer === "capture" && !this.captured) this.lock();
    }
    // Locked, the cursor does not move and only the delta means anything; unlocked, the local
    // cursor maps onto the remote one, which is what a desktop wants — the pointer tracks on
    // hover, with no click needed.
    if (phase === "move") {
      if (this.captured) {
        if (e.movementX || e.movementY) {
          this.mod._pf_input(KIND.MOUSE_MOVE, 0, e.movementX, e.movementY, 0);
        }
      } else {
        const [x, y] = this.stream(e);
        this.mod._pf_input(KIND.MOUSE_MOVE_ABS, 0, x, y, this.extent());
      }
      return this.press(e.buttons);
    }
    // Put the pointer where the click is before the click lands — but not while locked, where
    // there is no local position to speak of and sending one would teleport the remote cursor.
    if (!this.captured) {
      const [x, y] = this.stream(e);
      this.mod._pf_input(KIND.MOUSE_MOVE_ABS, 0, x, y, this.extent());
    }
    this.press(e.buttons);
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
    const notch = (e.deltaMode === 0 ? 100 : e.deltaMode === 1 ? 3 : 1) * (this.opts.invertScroll ? -1 : 1);
    // The wire's vertical is up-positive (core `input::scroll`); a browser's `deltaY` is down-positive.
    this.wheel.y -= (e.deltaY / notch) * WHEEL_NOTCH;
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

  /** Where on the stream a pointer is, in the stream's own pixels. The picture is fitted inside
   *  the element (`object-fit: contain`), so the bars map to the nearest edge. */
  private stream(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const { streamWidth: sw, streamHeight: sh } = this.opts;
    const cw = this.canvas.width || sw;
    const ch = this.canvas.height || sh;
    const scale = Math.min(r.width / cw, r.height / ch) || 1;
    const left = r.left + (r.width - cw * scale) / 2;
    const top = r.top + (r.height - ch * scale) / 2;
    const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
    const x = clamp(((e.clientX - left) / (cw * scale)) * sw, sw - 1);
    const y = clamp(((e.clientY - top) / (ch * scale)) * sh, sh - 1);
    return [Math.round(x), Math.round(y)];
  }

  /** `(width << 16) | height`, the absolute-position reference the wire carries. */
  private extent(): number {
    return (((this.opts.streamWidth & 0xffff) << 16) | (this.opts.streamHeight & 0xffff)) >>> 0;
  }

  // --- gamepads --------------------------------------------------------------------------
  /** Only a standard-mapping pad is forwarded: its button indices are the only ones this reads,
   *  and any other layout would press the wrong buttons on the host. */
  private arrive(g: Gamepad): void {
    if (this.padState.has(g.index) || g.mapping !== "standard") return;
    this.padState.set(g.index, { engine: new Engine(this.opts.shortcuts?.bindings ?? [], "pad"), physical: 0, host: 0 });
    this.mod._pf_gamepad_arrival(g.index, padKind(g.id));
  }

  /** The host drops a removed pad whole, so nothing its shortcuts held needs lifting. */
  private leave(index: number): void {
    if (!this.padState.delete(index)) return;
    this.mod._pf_gamepad_remove(index);
  }

  private on<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  private on<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    fn: (e: DocumentEventMap[K]) => void,
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

/**
 * The `GamepadPref` wire byte for a pad, by the rules the native clients use: the vendor and
 * product where the browser gives them (Chromium and Firefox put them in the id), else the name
 * (Safari gives only that). Unknown pads get Xbox 360, which every game reads.
 */
export function padKind(id: string): number {
  const ids = /Vendor: ([0-9a-f]{4}) Product: ([0-9a-f]{4})/i.exec(id) ?? /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  const vid = ids ? parseInt(ids[1]!, 16) : -1;
  const pid = ids ? parseInt(ids[2]!, 16) : -1;
  const name = id.toLowerCase();
  if ((vid === 0x054c && pid === 0x0df2) || name.includes("dualsense edge")) return PAD_KIND.DUALSENSE_EDGE;
  if ((vid === 0x054c && pid === 0x0ce6) || name.includes("dualsense")) return PAD_KIND.DUALSENSE;
  if ((vid === 0x054c && [0x05c4, 0x09cc, 0x0ba0].includes(pid)) || name.includes("dualshock")) return PAD_KIND.DUALSHOCK4;
  if (vid === 0x28de && pid === 0x1205) return PAD_KIND.STEAM_DECK;
  if (vid === 0x28de && [0x1102, 0x1142].includes(pid)) return PAD_KIND.STEAM_CONTROLLER;
  if ((vid === 0x057e && [0x2009, 0x200e].includes(pid)) || name.includes("pro controller")) return PAD_KIND.SWITCH_PRO;
  if (vid === 0x045e ? ![0x028e, 0x028f, 0x0719].includes(pid) : name.includes("xbox") && !name.includes("360")) {
    return PAD_KIND.XBOX_ONE;
  }
  return PAD_KIND.XBOX_360;
}

/** The slice of `GamepadHapticActuator` this uses; `effects` is not in every DOM lib yet. */
interface Actuator {
  readonly effects?: readonly string[];
  playEffect(type: string, params: Record<string, number>): Promise<unknown>;
  reset?(): Promise<unknown>;
}

/**
 * Play one rumble command from core's policy on the pad the host names. The wire's pad number is
 * the `Gamepad.index` the page forwards. Levels are the wire's 0–65535; `ms` is how long the level
 * holds, and `0` is a stop. A pad without an actuator (Firefox, most pads on Safari) stays still.
 */
export function playRumble(
  pads: readonly (Gamepad | null)[],
  pad: number,
  low: number,
  high: number,
  lt: number,
  rt: number,
  ms: number,
): void {
  const actuator = (pads[pad] as { vibrationActuator?: Actuator | null } | null | undefined)?.vibrationActuator;
  if (!actuator) return;
  if (ms === 0) {
    void actuator.reset?.().catch(() => {});
    return;
  }
  const level = (v: number) => v / 0xffff;
  // Trigger motors only where the browser drives them (Chromium, Xbox pads on Windows).
  const triggers = (lt > 0 || rt > 0) && (actuator.effects?.includes("trigger-rumble") ?? false);
  // The low-frequency motor is the strong one.
  void actuator
    .playEffect(triggers ? "trigger-rumble" : "dual-rumble", {
      duration: ms,
      strongMagnitude: level(low),
      weakMagnitude: level(high),
      ...(triggers ? { leftTrigger: level(lt), rightTrigger: level(rt) } : {}),
    })
    .catch(() => {});
}

/** `punktfunk_core::config::GamepadPref::to_u8`. */
const PAD_KIND = {
  XBOX_360: 1,
  DUALSENSE: 2,
  XBOX_ONE: 3,
  DUALSHOCK4: 4,
  STEAM_CONTROLLER: 5,
  STEAM_DECK: 6,
  DUALSENSE_EDGE: 7,
  SWITCH_PRO: 8,
} as const;

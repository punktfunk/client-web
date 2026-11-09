// In-stream shortcuts: a press or hold of controller buttons or keys, bound to a quick action.
// The TypeScript twin of punktfunk's `pf_client_core::shortcuts`; `shortcuts.test.ts` replays
// `shortcut-vectors.json` as the Rust, Swift and Kotlin twins do, so a rule changes there first.

/** Pad buttons by their stored name, with core's `gamepad::BTN_*` wire bits. */
export const BUTTONS: ReadonlyArray<readonly [name: string, bit: number]> = [
  ["a", 0x1000],
  ["b", 0x2000],
  ["x", 0x4000],
  ["y", 0x8000],
  ["lb", 0x0100],
  ["rb", 0x0200],
  ["ls", 0x0040],
  ["rs", 0x0080],
  ["start", 0x0010],
  ["select", 0x0020],
  ["guide", 0x0400],
  ["up", 0x0001],
  ["down", 0x0002],
  ["left", 0x0004],
  ["right", 0x0008],
  ["touchpad", 0x10_0000],
  ["misc1", 0x20_0000],
  ["misc2", 0x40_0000],
  ["paddle1", 0x1_0000],
  ["paddle2", 0x2_0000],
  ["paddle3", 0x4_0000],
  ["paddle4", 0x8_0000],
];

const ALIASES: Readonly<Record<string, string>> = { back: "select", r4: "paddle1", l4: "paddle2", r5: "paddle3", l5: "paddle4" };

/** The wire bit of a stored button name, any case; `back` is `select`, and the pad art's grip
 *  names (`r4`, `l4`, `r5`, `l5`) are the paddles. */
export function buttonBit(name: string): number | undefined {
  const n = name.trim().toLowerCase();
  const key = ALIASES[n] ?? n;
  return BUTTONS.find(([k]) => k === key)?.[1];
}

export function buttonName(bit: number): string | undefined {
  return BUTTONS.find(([, b]) => b === bit)?.[0];
}

/** The keyboard modifiers a shortcut may hold, in display order. ⌘ and Win are the host's. */
export const MODIFIERS = ["ctrl", "alt", "shift"] as const;

function modifier(name: string): (typeof MODIFIERS)[number] | undefined {
  const n = name.trim().toLowerCase();
  return n === "ctrl" || n === "control" ? "ctrl" : n === "alt" || n === "option" ? "alt" : n === "shift" ? "shift" : undefined;
}

const KEY_NAMES: Readonly<Record<string, number>> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, option: 0x12, win: 0x5b, cmd: 0x5b, super: 0x5b,
  meta: 0x5b, escape: 0x1b, esc: 0x1b, tab: 0x09, enter: 0x0d, return: 0x0d, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21,
  pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, printscreen: 0x2c, pause: 0x13,
  capslock: 0x14,
};

/** F1–F24 as a number, else undefined. */
function fNumber(n: string): number | undefined {
  const f = /^f(\d+)$/.exec(n);
  const v = f ? Number(f[1]) : 0;
  return v >= 1 && v <= 24 ? v : undefined;
}

/** Windows VK for a stored key name: core's `input::key_vk`. */
export function keyVk(name: string): number | undefined {
  const n = name.trim().toLowerCase();
  if (Object.hasOwn(KEY_NAMES, n)) return KEY_NAMES[n];
  if (/^[a-z]$/.test(n)) return 0x41 + n.charCodeAt(0) - 97;
  if (/^[0-9]$/.test(n)) return 0x30 + n.charCodeAt(0) - 48;
  const f = fNumber(n);
  return f === undefined ? undefined : 0x70 + f - 1;
}

/** The first stored name of a VK: the inverse of `keyVk`. */
export function keyName(vk: number): string | undefined {
  const named = Object.entries(KEY_NAMES).find(([, v]) => v === vk)?.[0];
  if (named) return named;
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk + 32);
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  return vk >= 0x70 && vk <= 0x87 ? `f${vk - 0x6f}` : undefined;
}

/** The VKs a modifier folds onto: left and right are one key to the engine. */
export const MODIFIER_VKS: ReadonlySet<number> = new Set([0x11, 0x12, 0x10]);

/** A client family with its own defaults. This page runs as `web` or `tizen`; the others are
 *  here for the shared vectors. */
export type Client = "desktop" | "android" | "apple" | "mac" | "webos" | "web" | "tizen" | "ps5" | "switch";

/** Where a trigger is pressed; one `Engine` runs per pad and one for the keyboard. */
export type Device = "pad" | "key";

/** What the player presses. Pad buttons are wire bits in stored order; keys are `keyVk` names,
 *  modifiers in `MODIFIERS` order. A keyboard trigger is always a press. */
export type Trigger = { on: "pad"; buttons: number[]; hold: boolean } | { on: "key"; modifiers: string[]; key: string };

const holds = (t: Trigger): boolean => t.on === "pad" && t.hold;

/** What the engine matches, sorted: wire bits, or the VKs of the modifiers and the key. */
export function triggerIds(t: Trigger): number[] {
  const ids = t.on === "pad" ? t.buttons : [...t.modifiers, t.key].map(keyVk).filter((v) => v !== undefined);
  return [...new Set(ids)].sort((a, b) => a - b);
}

const SLOTS: ReadonlySet<string> = new Set([
  "end_stream", "end_game", "disconnect_linger", "touch_mode", "keyboard", "stats", "mic", "pad",
  "send_text", "guide", "qam", "pad_mouse", "pad_type", "stream_mute", "swap_screens",
  "release_input", "mouse_mode", "fullscreen", "minimize", "clipboard",
]);

/** An action id: a quick-action slot id, `host:<id>`, `shortcut:<id>` or `ring`. Anything else is
 *  an id from a newer client: its row stays, and the engine never sees it. */
export type Action = string;

export function knownAction(id: Action): boolean {
  return id === "ring" || SLOTS.has(id) || /^(host|shortcut):./.test(id);
}

/** Guide, Quick access and a key combination keep their key down on the host while held. */
export function keyLike(id: Action): boolean {
  return id === "guide" || id === "qam" || /^shortcut:./.test(id);
}

export interface Binding {
  trigger: Trigger;
  action: Action;
}

/** Why the editor refuses a binding; `index` points into `Shortcuts.bindings`. */
export type Conflict =
  | { kind: "identical" | "press_subset"; index: number }
  | { kind: "single_press" | "no_modifier" | "no_key" };

/** What to press: the chord, or "Hold …", or either of two chords (`or`). */
export interface Press {
  keys: string;
  hold?: boolean;
  or?: string;
}

/** One row: a binding's (`action` and `binding`), or a fixed one (`text`, a message key). */
export interface Row {
  press: Press;
  action?: Action;
  text?: "controls_open_menu" | "controls_release_mouse_page";
  binding?: number;
}

export interface Group {
  kind: "remote" | "keyboard" | "pad";
  items: Row[];
}

const BUTTON_LABEL: Readonly<Record<number, string>> = {
  0x1000: "A", 0x2000: "B", 0x4000: "X", 0x8000: "Y", 0x0100: "L1", 0x0200: "R1", 0x0040: "L3",
  0x0080: "R3", 0x0010: "Start", 0x0020: "Select", 0x0400: "Guide", 0x0001: "Up", 0x0002: "Down",
  0x0004: "Left", 0x0008: "Right", 0x10_0000: "Touchpad", 0x20_0000: "Share", 0x40_0000: "C",
  0x1_0000: "R4", 0x2_0000: "L4", 0x4_0000: "R5", 0x8_0000: "L5",
};

const LEGEND: Readonly<Record<string, string>> = {
  ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt", option: "Alt", win: "Win", cmd: "Win",
  super: "Win", meta: "Win", escape: "Esc", esc: "Esc", enter: "Enter", return: "Enter",
  backspace: "Backspace", delete: "Del", del: "Del", insert: "Ins", pageup: "PgUp", pagedown: "PgDn",
  printscreen: "PrtSc", capslock: "Caps", up: "↑", down: "↓", left: "←", right: "→",
};

/** A key's keycap word: core's `overlay_actions::key_legend`. */
export function keyLegend(k: string): string {
  const n = k.trim().toLowerCase();
  return Object.hasOwn(LEGEND, n) ? LEGEND[n]! : n.charAt(0).toUpperCase() + n.slice(1);
}

/** The keys alone: "Select + A", "Ctrl+Alt+Shift+Q". */
export function chord(t: Trigger): string {
  return t.on === "pad"
    ? t.buttons.map((b) => BUTTON_LABEL[b] ?? "?").join(" + ")
    : [...t.modifiers, t.key].map(keyLegend).join("+");
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** One stored binding, or undefined where this build can't read it. */
function stored(v: unknown): Binding | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { on, keys, hold, do: action } = v as Record<string, unknown>;
  if (typeof on !== "string" || !strings(keys) || typeof action !== "string") return undefined;
  if (hold !== undefined && hold !== null && typeof hold !== "boolean") return undefined;
  if (on === "pad") {
    const buttons: number[] = [];
    for (const name of keys) {
      const bit = buttonBit(name);
      if (bit === undefined) return undefined;
      if (!buttons.includes(bit)) buttons.push(bit);
    }
    return buttons.length ? { trigger: { on, buttons, hold: hold === true }, action } : undefined;
  }
  if (on !== "key" || keys.length === 0) return undefined;
  const key = keys.at(-1)!.trim().toLowerCase();
  const mods = keys.slice(0, -1).map(modifier);
  if (keyVk(key) === undefined || mods.includes(undefined)) return undefined;
  return { trigger: { on, modifiers: MODIFIERS.filter((m) => mods.includes(m)), key }, action };
}

/** Every shortcut of one device and preset, in display order: the `shortcuts` settings blob. */
export class Shortcuts {
  static readonly SCHEMA_VERSION = 1;

  constructor(readonly bindings: Binding[] = []) {}

  /** Never throws: an unparseable blob is empty, and a binding with a name this build does not
   *  know is dropped. An unknown action keeps its row. */
  static parse(json: string): Shortcuts {
    return Shortcuts.read(json) ?? new Shortcuts();
  }

  /** Undefined when the blob is not a shortcuts blob at all; the caller takes the defaults. */
  static read(json: string): Shortcuts | undefined {
    try {
      const bindings: unknown = (JSON.parse(json) as { bindings?: unknown }).bindings;
      if (!Array.isArray(bindings)) return undefined;
      return new Shortcuts(bindings.map(stored).filter((b) => b !== undefined));
    } catch {
      return undefined;
    }
  }

  /** The blob as an object: `JSON.stringify(shortcuts)` is what the setting stores. A pad binding
   *  always writes `hold`, a key binding never does. */
  toJSON(): { v: number; bindings: Array<{ on: string; keys: string[]; hold?: boolean; do: string }> } {
    return {
      v: Shortcuts.SCHEMA_VERSION,
      bindings: this.bindings.map(({ trigger: t, action }) =>
        t.on === "pad"
          ? { on: "pad", keys: t.buttons.map(buttonName).filter((n) => n !== undefined), hold: t.hold, do: action }
          : { on: "key", keys: [...t.modifiers, t.key], do: action },
      ),
    };
  }

  /** Whether `candidate` may join these bindings, null when it may. An edit is checked against
   *  the list without the binding it changes. */
  validate(candidate: Binding): Conflict | null {
    const t = candidate.trigger;
    if (t.on === "key") {
      if (!t.key || modifier(t.key)) return { kind: "no_key" };
      if (t.modifiers.length === 0 && fNumber(t.key) === undefined) return { kind: "no_modifier" };
    } else if (t.buttons.length < 2 && !(t.hold && t.buttons.length === 1)) {
      return { kind: "single_press" };
    }
    const ids = triggerIds(t);
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const peers = this.bindings.map((b, index) => ({ b, index })).filter(({ b }) => b.trigger.on === t.on);
    const twin = peers.find(({ b }) => holds(b.trigger) === holds(t) && same(triggerIds(b.trigger), ids));
    if (twin) return { kind: "identical", index: twin.index };
    // Modifiers are down before the key, so only pad presses can cut a chord short.
    if (t.on === "pad") {
      const strict = (small: number[], big: number[]) => small.length < big.length && small.every((x) => big.includes(x));
      const cut = peers.find(({ b }) => {
        const other = triggerIds(b.trigger);
        return (!t.hold && strict(ids, other)) || (!holds(b.trigger) && strict(other, ids));
      });
      if (cut) return { kind: "press_subset", index: cut.index };
    }
    return null;
  }

  /** The groups the browser's Shortcuts screen shows: the Samsung remote, the keyboard with the
   *  page's own Esc, then the pad. The page labels a binding row by its action. */
  rows(client: "web" | "tizen"): Group[] {
    const out: Group[] = [];
    if (client === "tizen") out.push({ kind: "remote", items: [{ press: { keys: "Back" }, text: "controls_open_menu" }] });
    const keys = this.items("key");
    if (client === "web") keys.push({ press: { keys: "Esc" }, text: "controls_release_mouse_page" });
    if (keys.length) out.push({ kind: "keyboard", items: keys });
    out.push({ kind: "pad", items: this.items("pad") });
    return out;
  }

  /** The first trigger on `device` bound to `action`, for the exit hint and the menu's line. */
  hint(action: Action, device: Device): Press | undefined {
    const b = this.bindings.find((b) => b.action === action && b.trigger.on === device);
    return b && { keys: chord(b.trigger), hold: holds(b.trigger) };
  }

  /** One row per binding on `device`; two presses of one action share a row. */
  private items(device: Device): Row[] {
    const shown = new Set<number>();
    const rows: Row[] = [];
    this.bindings.forEach((b, i) => {
      if (shown.has(i) || b.trigger.on !== device) return;
      const keys = chord(b.trigger);
      const j = holds(b.trigger)
        ? -1
        : this.bindings.findIndex((o, k) => k > i && o.action === b.action && o.trigger.on === device && !holds(o.trigger));
      if (j >= 0) shown.add(j);
      const press: Press = holds(b.trigger) ? { keys, hold: true } : j >= 0 ? { keys, or: chord(this.bindings[j]!.trigger) } : { keys };
      rows.push({ press, action: b.action, binding: i });
    });
    return rows;
  }
}

const EXIT = ["lb", "rb", "start", "select"];
const PS5_EXIT = ["lb", "rb", "start", "touchpad"];

const pad = (names: string[], hold: boolean, action: Action): Binding => ({
  trigger: { on: "pad", buttons: names.map(buttonBit).filter((b) => b !== undefined), hold },
  action,
});
const key = (modifiers: string[], k: string, action: Action): Binding => ({ trigger: { on: "key", modifiers, key: k }, action });

/** This client's shortcuts when the player has changed none. `legacyGuideGesture` is the old
 *  *Hold Select for guide* value: `on` and `off` decide that row, anything else is automatic. */
export function defaults(client: Client, gameMode: boolean, legacyGuideGesture: string): Shortcuts {
  const guide =
    legacyGuideGesture === "on" || (legacyGuideGesture !== "off" && (client === "desktop" ? gameMode : client === "apple"));
  // The clients with their own pad path; the others' dial is their only pad chord.
  const native = client === "desktop" || client === "android" || client === "apple" || client === "mac";
  // The dial opener is Select + the confirm button: Minus + A (east, wire `b`) on a Switch.
  const [open, exit] = client === "ps5" ? [["touchpad", "a"], PS5_EXIT] : [["select", client === "switch" ? "b" : "a"], EXIT];
  const b: Binding[] = [pad(open, false, "ring")];
  if (native) b.push(pad(["select", "x"], false, "stats"));
  if (client === "android") b.push(pad(["select", "y"], false, "mic"));
  if (native && guide) b.push(pad(["select"], true, "guide"));
  if (client === "desktop" || client === "web" || client === "tizen") b.push(pad(exit, false, "release_input"));
  b.push(pad(exit, true, "end_stream"));
  const chord = (k: string, action: Action) => key(["ctrl", "alt", "shift"], k, action);
  if (client === "desktop" || client === "web" || client === "tizen") {
    b.push(chord("q", "release_input"), chord("d", "end_stream"), chord("s", "stats"), chord("o", "ring"));
    b.push(chord("v", "mic"), chord("m", "mouse_mode"), key([], "f11", "fullscreen"), key(["alt"], "enter", "fullscreen"));
  } else if (client === "android") {
    b.push(chord("q", "release_input"), chord("o", "ring"));
  } else if (client === "apple" || client === "mac") {
    b.push(chord("q", "release_input"), chord("d", "end_stream"), chord("s", "stats"), chord("o", "ring"));
    if (client === "mac") b.push(chord("m", "mouse_mode"));
    b.push(chord("c", "clipboard"), chord("a", "mic"));
  }
  return new Shortcuts(b);
}

/** The stored blob, or this client's defaults when it is empty or unreadable. */
export function resolve(blob: string, client: Client, gameMode: boolean, legacyGuideGesture: string): Shortcuts {
  return Shortcuts.read(blob) ?? defaults(client, gameMode, legacyGuideGesture);
}

/** A held trigger fires after this long. */
export const HOLD_MS = 1000;
/** A held-back tap's release follows its press by this, so the two don't fold into one pad state. */
export const TAP_PRESS_MS = 50;
/** A key-like hold released after this long is a tap of its key, not of the button. */
export const KEY_TAP_MS = 350;

export type Phase = "once" | "down" | "up" | "tap";

/** `forward`: send this transition to the host (it obeys the input mask). `fire`: run the action.
 *  `lift`: release these on the host, mask or not — the rest of a chord that fired. */
export type Out = { forward: [id: number, down: boolean] } | { fire: [action: Action, phase: Phase] } | { lift: number[] };

interface Rule {
  ids: number[];
  hold: boolean;
  action: Action;
}

/**
 * One pad's or the keyboard's shortcuts, by the rules of `design/client-shortcuts.md` §4. Ids are
 * wire bits, or VKs with left and right modifiers folded onto `MODIFIER_VKS`. Feed every
 * transition to `step`, call `tick` on every poll (late only delays), and `flush` when the device
 * goes away. Pass only the actions this client can perform. Pure: the caller owns clock and wire.
 */
export class Engine {
  private readonly rules: Rule[];
  /** Physically down, in press order. */
  private down: number[] = [];
  /** Down on the host because of a `forward`. */
  private forwarded: number[] = [];
  /** Pressed, not sent: a held chord's presses, only while its hold is armed. */
  private heldBack: number[] = [];
  /** `twin`: the press with the same buttons, which fires when the chord lifts before `HOLD_MS`. */
  private armed: { since: number; hold: number; twin: number | undefined } | undefined;
  /** Buttons of a chord that fired: their releases are dropped. */
  private claimed: number[] = [];
  /** A key-like hold that went down, and the buttons whose first lift ends it. */
  private keyDown: { action: Action; ids: number[] } | undefined;
  /** A tap's release, due at the instant. */
  private owed: Array<[due: number, id: number]> = [];

  /** Keeps `device`'s bindings the engine can act on: no unknown actions, no keyboard holds, and
   *  no one-button pad press (that tap is the game's). */
  constructor(
    bindings: readonly Binding[],
    private readonly device: Device,
  ) {
    this.rules = bindings
      .filter((b) => b.trigger.on === device && knownAction(b.action))
      .map((b) => ({ ids: triggerIds(b.trigger), hold: holds(b.trigger), action: b.action }))
      .filter((r) => (device === "pad" ? r.hold || r.ids.length >= 2 : !r.hold && r.ids.length > 0));
  }

  /** One transition at `nowMs`. A tick that was due runs first. */
  step(id: number, down: boolean, nowMs: number): Out[] {
    const out = this.tick(nowMs);
    if (down) this.press(id, nowMs, out);
    else this.release(id, nowMs, out);
    this.settle(nowMs, out);
    return out;
  }

  /** Owed tap releases, and an armed hold that came due. */
  tick(nowMs: number): Out[] {
    const out: Out[] = [];
    this.owed = this.owed.filter(([due, id]) => {
      if (nowMs < due) return true;
      out.push({ forward: [id, false] });
      return false;
    });
    if (this.armed && nowMs - this.armed.since >= HOLD_MS) {
      const hold = this.armed.hold;
      this.fire(hold, keyLike(this.rules[hold]!.action) ? "down" : "once", out);
    }
    return out;
  }

  /** The device is gone: a key-like hold comes up, and the host lets go of everything this engine
   *  sent down or still owes. Forgets every press. */
  flush(): Out[] {
    const out: Out[] = [];
    if (this.keyDown) out.push({ fire: [this.keyDown.action, "up"] });
    const lift = [...this.owed.map(([, id]) => id), ...this.forwarded];
    if (lift.length) out.push({ lift });
    this.keyDown = this.armed = undefined;
    this.owed = [];
    this.forwarded = [];
    this.down = [];
    this.heldBack = [];
    this.claimed = [];
    return out;
  }

  private press(b: number, now: number, out: Out[]): void {
    // Key repeat, or a press the engine already counts.
    if (this.down.includes(b)) return;
    const owed = this.owed.findIndex(([, id]) => id === b);
    if (owed >= 0) {
      this.owed.splice(owed, 1);
      out.push({ forward: [b, false] });
    }
    this.down.push(b);
    this.armed = undefined;
    // While a key-like hold is down, a press is the host's: Guide+A is Steam's chord.
    if (!this.isModifier(b) && !this.keyDown) {
      const press = this.exact(false);
      const hold = this.exact(true);
      if (press !== undefined && hold === undefined) {
        return this.fire(press, keyLike(this.rules[press]!.action) ? "tap" : "once", out);
      }
      if (hold !== undefined) {
        this.heldBack.push(b);
        this.armed = { since: now, hold, twin: press };
        return;
      }
    }
    // A partner that completes nothing makes a held-back press real, sent first.
    this.sendHeldBack(out);
    this.forwarded.push(b);
    out.push({ forward: [b, true] });
  }

  private release(b: number, now: number, out: Out[]): void {
    const i = this.down.indexOf(b);
    if (i < 0) {
      // Pressed before this engine: the host may hold it.
      out.push({ forward: [b, false] });
      return;
    }
    this.down.splice(i, 1);
    if (this.keyDown?.ids.includes(b)) {
      out.push({ fire: [this.keyDown.action, "up"] });
      this.keyDown = undefined;
    }
    if (remove(this.claimed, b)) return;
    // Armed means down was the hold's chord, so `b` is one of its buttons.
    const armed = this.armed;
    this.armed = undefined;
    if (armed) {
      if (armed.twin !== undefined) {
        return this.fire(armed.twin, keyLike(this.rules[armed.twin]!.action) ? "tap" : "once", out);
      }
      if (keyLike(this.rules[armed.hold]!.action) && now - armed.since >= KEY_TAP_MS) {
        return this.fire(armed.hold, "tap", out);
      }
    }
    if (remove(this.heldBack, b)) {
      out.push({ forward: [b, true] });
      this.owed.push([now + TAP_PRESS_MS, b]);
      return;
    }
    remove(this.forwarded, b);
    out.push({ forward: [b, false] });
  }

  /** The rule fires: the host lets go of the chord first, the held-back press is never sent, and
   *  every button still down is the chord's until it lifts. */
  private fire(rule: number, phase: Phase, out: Out[]): void {
    if (this.forwarded.length) out.push({ lift: this.forwarded });
    this.forwarded = [];
    const r = this.rules[rule]!;
    out.push({ fire: [r.action, phase] });
    if (phase === "down") this.keyDown = { action: r.action, ids: r.ids };
    this.heldBack = [];
    this.armed = undefined;
    for (const b of this.down) if (!this.claimed.includes(b)) this.claimed.push(b);
  }

  /** A press stays held back only while its hold is armed. When a release disarms it, a hold still
   *  exactly down (a nested one) arms from `now`; otherwise the press goes out. */
  private settle(now: number, out: Out[]): void {
    if (this.armed || this.heldBack.length === 0) return;
    const hold = this.exact(true);
    if (hold !== undefined) this.armed = { since: now, hold, twin: this.exact(false) };
    else this.sendHeldBack(out);
  }

  private sendHeldBack(out: Out[]): void {
    for (const h of this.heldBack) {
      this.forwarded.push(h);
      out.push({ forward: [h, true] });
    }
    this.heldBack = [];
  }

  /** The rule whose buttons are exactly what is down. */
  private exact(hold: boolean): number | undefined {
    const i = this.rules.findIndex((r) => r.hold === hold && r.ids.length === this.down.length && this.down.every((b) => r.ids.includes(b)));
    return i < 0 ? undefined : i;
  }

  /** A modifier never completes a keyboard shortcut and is never held back. */
  private isModifier(b: number): boolean {
    return this.device === "key" && MODIFIER_VKS.has(b);
  }
}

/** Remove `x` from `list`; whether it was there. */
function remove(list: number[], x: number): boolean {
  const i = list.indexOf(x);
  if (i >= 0) list.splice(i, 1);
  return i >= 0;
}

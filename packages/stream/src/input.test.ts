// The page's shortcuts on a pad and the keyboard, through the engine `shortcuts.test.ts` pins.
// Rumble plays on the pad the host names, through the actuator the browser offers.
//
// `InputPipe` uses constructor parameter properties, so `npm test` runs node with
// `--experimental-transform-types` rather than plain type stripping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { InputPipe, playRumble } from "./input.ts";
import { defaults } from "./shortcuts.ts";

/** A standard-mapping pad with these button indices held. */
const pad = (...held: number[]): Gamepad =>
  ({
    index: 0,
    id: "",
    mapping: "standard",
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i), value: held.includes(i) ? 1 : 0 })),
    axes: [0, 0, 0, 0],
  }) as unknown as Gamepad;

/** Standard indices: A, LB, RB, Back, Start. */
const A = 0, LB = 4, RB = 5, SELECT = 8, START = 9;
const WEB = defaults("web", false, "");

test("Select + A opens the menu; the exit chord releases input, or held ends the stream", () => {
  const fired: string[] = [];
  const sent: number[] = [];
  const mod = { _pf_gamepad: (_pad: number, buttons: number) => sent.push(buttons), _pf_gamepad_arrival: () => {} };
  const pipe = new InputPipe(mod as never, {} as HTMLCanvasElement, {
    streamWidth: 1920,
    streamHeight: 1080,
    pointer: "absolute",
    deadzone: 0.05,
    shortcuts: WEB,
    onShortcut: (action, device) => fired.push(`${action}:${device}`),
  });
  let now = 1000;
  let g = pad();
  const realNow = performance.now;
  performance.now = () => now;
  Object.defineProperty(navigator, "getGamepads", { value: () => [g], configurable: true });
  (pipe as unknown as { arrive(g: Gamepad): void }).arrive(g);
  const frame = (ms: number, ...held: number[]) => {
    g = pad(...held);
    pipe.poll();
    now += ms;
  };
  try {
    frame(16, SELECT);
    frame(16, SELECT, A);
    assert.deepEqual(fired, ["ring:pad"]);
    assert.equal(sent[0], 0x20, "Select alone is the game's");
    assert.ok(sent.at(-1) === 0 && !sent.some((b) => b & 0x1000), "Select lifted when A completes the chord; A never sent");
    frame(16);

    fired.length = sent.length = 0;
    frame(16, LB);
    frame(16, LB, RB);
    frame(16, LB, RB, START);
    frame(300, LB, RB, START, SELECT);
    assert.deepEqual(fired, [], "the hold is armed");
    frame(16);
    assert.deepEqual(fired, ["release_input:pad"], "released before 1 s: the press stage");
    assert.ok(!sent.some((b) => b & 0x20) && sent.at(-1) === 0, "Select never sent, the rest lifted");

    fired.length = 0;
    frame(16, LB, RB, START, SELECT);
    frame(1000, LB, RB, START, SELECT);
    frame(16, LB, RB, START, SELECT);
    frame(16);
    assert.deepEqual(fired, ["end_stream:pad"], "held 1 s: End stream, and nothing at release");
  } finally {
    performance.now = realNow;
    delete (navigator as { getGamepads?: unknown }).getGamepads;
  }
});

/** A pad whose actuator records what it was asked to play. */
const rumblePad = (effects?: string[]) => {
  const calls: unknown[] = [];
  const actuator = {
    ...(effects ? { effects } : {}),
    playEffect: (type: string, params: Record<string, number>) => (calls.push([type, params]), Promise.resolve()),
    reset: () => (calls.push("reset"), Promise.resolve()),
  };
  return { pad: { vibrationActuator: actuator } as unknown as Gamepad, calls };
};

test("rumble plays on the pad the host names, strong on the low motor", () => {
  const a = rumblePad();
  const b = rumblePad();
  playRumble([a.pad, b.pad], 1, 0xffff, 0, 0, 0, 800);
  assert.deepEqual(a.calls, []);
  assert.deepEqual(b.calls, [["dual-rumble", { duration: 800, strongMagnitude: 1, weakMagnitude: 0 }]]);
});

test("a stop resets the actuator", () => {
  const a = rumblePad();
  playRumble([a.pad], 0, 0, 0, 0, 0, 0);
  assert.deepEqual(a.calls, ["reset"]);
});

test("trigger levels play only where the browser offers trigger rumble", () => {
  const plain = rumblePad(["dual-rumble"]);
  playRumble([plain.pad], 0, 0, 0, 0xffff, 0, 400);
  assert.equal((plain.calls[0] as [string])[0], "dual-rumble");
  const xbox = rumblePad(["dual-rumble", "trigger-rumble"]);
  playRumble([xbox.pad], 0, 0, 0, 0xffff, 0, 400);
  assert.deepEqual(xbox.calls, [
    ["trigger-rumble", { duration: 400, strongMagnitude: 0, weakMagnitude: 0, leftTrigger: 1, rightTrigger: 0 }],
  ]);
});

test("a pad without an actuator, or no pad at all, is left alone", () => {
  assert.doesNotThrow(() => playRumble([{} as Gamepad, null], 0, 0xffff, 0, 0, 0, 400));
  assert.doesNotThrow(() => playRumble([], 3, 0xffff, 0, 0, 0, 400));
});

test("a second mouse button held with the first is pressed and released", () => {
  const sent: string[] = [];
  const mod = { _pf_input: (kind: number, code: number) => sent.push(`${kind}:${code}`) };
  const canvas = { focus() {} } as HTMLCanvasElement;
  const pipe = new InputPipe(mod as never, canvas, { streamWidth: 1920, streamHeight: 1080, pointer: "capture", deadzone: 0.05 });
  const doc = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { pointerLockElement: canvas };
  const pointer = (phase: "down" | "move" | "up", buttons: number) =>
    (pipe as unknown as { pointer(e: unknown, phase: string): void }).pointer(
      { pointerType: "mouse", buttons, movementX: 0, movementY: 0, preventDefault() {} },
      phase,
    );
  try {
    // Left down, right down, left up, right up: the browser sends the middle two as moves.
    pointer("down", 1);
    pointer("move", 3);
    pointer("move", 2);
    pointer("up", 0);
    assert.deepEqual(sent, ["4:1", "4:3", "5:1", "5:3"]);
  } finally {
    (globalThis as { document?: unknown }).document = doc;
  }
});

test("the lock asks for the mouse's own counts, and falls back to a plain lock only when unsupported", async () => {
  const lockWith = async (refusal: string | undefined) => {
    const asked: unknown[] = [];
    const canvas = {
      requestPointerLock(options?: PointerLockOptions) {
        asked.push(options);
        return refusal && options ? Promise.reject(new DOMException("refused", refusal)) : Promise.resolve();
      },
    } as HTMLCanvasElement;
    const pipe = new InputPipe({} as never, canvas, { streamWidth: 1920, streamHeight: 1080, pointer: "capture", deadzone: 0.05 });
    const doc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { pointerLockElement: null };
    try {
      pipe.capture(true);
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      (globalThis as { document?: unknown }).document = doc;
    }
    return asked;
  };
  assert.deepEqual(await lockWith(undefined), [{ unadjustedMovement: true }]);
  assert.deepEqual(await lockWith("NotSupportedError"), [{ unadjustedMovement: true }, undefined]);
  assert.deepEqual(await lockWith("SecurityError"), [{ unadjustedMovement: true }], "no gesture, no second try");
});

test("a wheel turned down scrolls down: the wire is up-positive, the browser down-positive", () => {
  const sent: Array<[number, number, number]> = [];
  const mod = { _pf_input: (kind: number, code: number, x: number) => sent.push([kind, code, x]) };
  const pipe = new InputPipe(mod as never, {} as HTMLCanvasElement, { streamWidth: 1920, streamHeight: 1080, pointer: "absolute", deadzone: 0.05 });
  const wheel = (deltaX: number, deltaY: number) =>
    (pipe as unknown as { scroll(e: unknown): void }).scroll({ deltaMode: 0, deltaX, deltaY, preventDefault() {} });
  wheel(0, 100);
  wheel(100, 0);
  assert.deepEqual(sent, [
    [6, 0, -120],
    [6, 1, 120],
  ]);
});

/** A pipe on the page's default shortcuts whose sends are recorded as `kind:code`, what fired,
 *  and a key event aimed at `target`. */
const keyPipe = () => {
  const sent: string[] = [];
  const fired: string[] = [];
  const mod = {
    _pf_input: (kind: number, code: number) => sent.push(`${kind}:${code}`),
    _pf_gamepad: (pad: number, ...rest: number[]) => sent.push(`pad${pad}:${rest.join(",")}`),
    _pf_gamepad_arrival: () => {},
  };
  const pipe = new InputPipe(mod as never, {} as HTMLCanvasElement, {
    streamWidth: 1920,
    streamHeight: 1080,
    pointer: "absolute",
    deadzone: 0.05,
    shortcuts: WEB,
    onShortcut: (action) => fired.push(action),
  });
  const key = (code: string, down: boolean, target: unknown, mods: Partial<KeyboardEvent> = {}) => {
    let prevented = false;
    (pipe as unknown as { key(e: unknown, down: boolean): void }).key(
      { code, target, repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods, preventDefault: () => (prevented = true) },
      down,
    );
    return prevented;
  };
  return { sent, fired, pipe, key };
};

const PICTURE = { tagName: "CANVAS", closest: () => null };
const IN_MENU = { tagName: "BUTTON", closest: () => ({}) };
const CHORD = { ctrlKey: true, altKey: true, shiftKey: true };

test("a key chord fires on its key and lifts the modifiers; the rest of it stays with the menu", () => {
  const { sent, fired, key } = keyPipe();
  // Ctrl+Alt+Shift+O opens the menu, which takes focus before the keys come up.
  key("ControlLeft", true, PICTURE, { ctrlKey: true });
  key("AltLeft", true, PICTURE, { ctrlKey: true, altKey: true });
  key("ShiftLeft", true, PICTURE, CHORD);
  key("KeyO", true, PICTURE, CHORD);
  assert.deepEqual(fired, ["ring"]);
  assert.deepEqual(sent, ["0:162", "0:164", "0:160", "1:162", "1:164", "1:160"], "O never sent, each side lifted");
  assert.equal(key("KeyO", false, IN_MENU, CHORD), false, "never sent, so the menu keeps it");
  assert.equal(key("ShiftLeft", false, IN_MENU, { ctrlKey: true, altKey: true }), false, "the menu's event keeps its default");
  key("AltLeft", false, IN_MENU, { ctrlKey: true });
  key("ControlLeft", false, IN_MENU);
  assert.equal(sent.length, 6, "the chord's releases are dropped");

  // Right Ctrl and Alt, then F11 alone, then Alt+Enter: each fires, nothing of it repeats.
  sent.length = fired.length = 0;
  key("F11", true, PICTURE);
  key("F11", true, PICTURE, { repeat: true });
  key("F11", false, PICTURE);
  key("AltRight", true, PICTURE, { altKey: true });
  key("Enter", true, PICTURE, { altKey: true });
  key("Enter", false, PICTURE, { altKey: true });
  key("AltRight", false, PICTURE);
  assert.deepEqual(fired, ["fullscreen", "fullscreen"]);
  assert.deepEqual(sent, ["0:165", "1:165"]);

  sent.length = 0;
  key("KeyW", true, IN_MENU);
  key("KeyW", false, IN_MENU);
  assert.deepEqual(sent, [], "a key that went down in the menu stays there");

  // S held, then released with the chord's modifiers down: the release is not the stats chord.
  key("KeyS", true, PICTURE);
  assert.equal(key("KeyS", false, PICTURE, CHORD), true);
  assert.deepEqual(sent, ["0:83", "1:83"]);
});

test("Meta's release lets go of the keys pressed under it, not those held before it", () => {
  const { sent, key } = keyPipe();
  key("KeyW", true, PICTURE);
  key("MetaLeft", true, PICTURE, { metaKey: true });
  key("KeyV", true, PICTURE, { metaKey: true });
  key("KeyV", false, PICTURE, { metaKey: true });
  // macOS sends no keyup for C while Cmd is down.
  key("KeyC", true, PICTURE, { metaKey: true });
  key("MetaLeft", false, PICTURE);
  assert.deepEqual(sent, ["0:87", "0:91", "0:86", "1:86", "0:67", "1:91", "1:67"]);
  sent.length = 0;
  key("KeyW", false, PICTURE);
  assert.deepEqual(sent, ["1:87"]);
});

test("a lost focus lets go of keys and pads", () => {
  const { sent, pipe, key } = keyPipe();
  const internals = pipe as unknown as { arrive(g: unknown): void; release(): void };
  internals.arrive({ index: 2, mapping: "standard", id: "" });
  key("KeyA", true, PICTURE);
  internals.release();
  assert.deepEqual(sent, ["0:65", "1:65", "pad2:0,0,0,0,0,0,0"]);
});

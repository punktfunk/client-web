// The pad chords: each fires on its edge, and the escape chord's hold fires once, at 1.5 s.
// Rumble plays on the pad the host names, through the actuator the browser offers.
//
// `InputPipe` uses constructor parameter properties, so `npm test` runs node with
// `--experimental-transform-types` rather than plain type stripping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { type Chord, InputPipe, playRumble } from "./input.ts";

/** A standard-mapping pad with these button indices held. */
const pad = (...held: number[]): Gamepad =>
  ({
    index: 0,
    mapping: "standard",
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i), value: held.includes(i) ? 1 : 0 })),
    axes: [0, 0, 0, 0],
  }) as unknown as Gamepad;

const ESCAPE = [4, 5, 8, 9];
const MENU = [8, 0];

test("the pad chords fire on their edges, and the escape hold once", () => {
  const fired: Chord[] = [];
  const pipe = new InputPipe({} as never, {} as HTMLCanvasElement, {
    streamWidth: 1920,
    streamHeight: 1080,
    pointer: "absolute",
    deadzone: 0.05,
    onChord: (c) => fired.push(c),
  });
  let now = 1000;
  const realNow = performance.now;
  performance.now = () => now;
  const poll = (g: Gamepad) => (pipe as unknown as { padChords(g: Gamepad): void }).padChords(g);
  try {
    poll(pad(...ESCAPE));
    now += 500;
    poll(pad(...ESCAPE));
    assert.deepEqual(fired, ["escape"], "a press releases input once, however long it is held");
    now += 1000;
    poll(pad(...ESCAPE));
    now += 1000;
    poll(pad(...ESCAPE));
    assert.deepEqual(fired, ["escape", "escape-hold"], "held 1.5 s, it ends the stream once");

    poll(pad());
    poll(pad(...ESCAPE));
    assert.deepEqual(fired.at(-1), "escape", "released and pressed again, it starts over");

    fired.length = 0;
    poll(pad(...MENU));
    poll(pad(...MENU));
    poll(pad());
    poll(pad(...MENU));
    assert.deepEqual(fired, ["menu", "menu"]);
  } finally {
    performance.now = realNow;
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

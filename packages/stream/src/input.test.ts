// The pad chords: each fires on its edge, and the escape chord's hold fires once, at 1.5 s.
//
// `InputPipe` uses constructor parameter properties, so `npm test` runs node with
// `--experimental-transform-types` rather than plain type stripping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { type Chord, InputPipe } from "./input.ts";

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

import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameMeter, STEPS, Sweep, table } from "./console-cost.ts";

test("a meter closes its window with the rate the frames arrived at", () => {
  const meter = new FrameMeter();
  let closed = null;
  // A frame every 100 ms: 10 fps, each 20 ms on the main thread, one of them 50.
  for (let t = 0; t <= 1000 && !closed; t += 100) closed = meter.add(t === 300 ? 50 : 20, t, 1000);
  assert.ok(closed);
  assert.equal(closed.frames, 11);
  assert.equal(closed.fps, 10);
  assert.equal(closed.peakMs, 50);
  assert.equal(Math.round(closed.meanMs * 10), 227);
  // The next window starts empty.
  assert.equal(meter.add(20, 5000, 1000), null);
});

test("a sweep walks every step once and prices each", () => {
  const sweep = new Sweep(0);
  const seen: string[] = [];
  let now = 0;
  // A slow device: 4 fps, 40 ms of it on the main thread.
  while (sweep.step && now < 600_000) {
    now += 250;
    const name = sweep.step.name;
    if (seen.at(-1) !== name) seen.push(name);
    sweep.frame(40, now, 10);
  }
  assert.deepEqual(seen, STEPS.map((s) => s.name));
  // 250 ms a frame: 40 drawing, 10 in other long tasks, the rest waiting.
  assert.deepEqual(sweep.rows, STEPS.map((s) => ({ step: s.name, fps: 4, cpuMs: 40, otherMs: 10, waitMs: 200 })));
  assert.equal(sweep.frame(40, now + 250), false);
  const lines = table("hosts", sweep.rows);
  assert.equal(lines.length, STEPS.length + 2);
  assert.match(lines[2] ?? "", /^as started\s+4\.0\s+40\.0\s+10\.0\s+200\.0$/);
});

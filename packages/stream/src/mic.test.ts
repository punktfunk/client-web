// The microphone: a start overtaken by a stop, or by a stop and another start, closes what it
// opened, so exactly one capture is ever live. The worklet's resampler brings any rate to 48 kHz.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MicPipe, RESAMPLER } from "./mic.ts";

/** Browser stand-ins for one test; `prompts` resolves each `getUserMedia` the page asked for. */
function fakeBrowser() {
  const tracks: Array<{ stopped: boolean }> = [];
  const contexts: Array<{ closed: boolean }> = [];
  const prompts: Array<() => void> = [];
  const session = { type: "playback" };
  const stubs: Record<string, unknown> = {
    navigator: {
      audioSession: session,
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) =>
            prompts.push(() => {
              const track = { stopped: false, stop: () => (track.stopped = true) };
              tracks.push(track);
              resolve({ getTracks: () => [track] });
            }),
          ),
      },
    },
    AudioContext: class {
      closed = false;
      sampleRate = 48_000;
      destination = {};
      audioWorklet = { addModule: async () => {} };
      constructor() {
        contexts.push(this);
      }
      createMediaStreamSource = () => ({ connect: (n: unknown) => n });
      createGain = () => ({ gain: { value: 1 }, connect: (n: unknown) => n });
      resume = async () => {};
      close = async () => {
        this.closed = true;
      };
    },
    AudioWorkletNode: class {
      port = { onmessage: null };
      connect = (n: unknown) => n;
    },
    AudioEncoder: class {
      state = "configured";
      configure() {}
      close() {}
    },
  };
  const saved = Object.keys(stubs).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  for (const [k, v] of Object.entries(stubs)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const restore = () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { tracks, contexts, prompts, session, restore };
}

test("on, off and on during the prompt leaves one capture live, and off closes it", async () => {
  const b = fakeBrowser();
  try {
    const mic = new MicPipe({} as never);
    const first = mic.start();
    mic.stop();
    const second = mic.start();
    for (const allow of b.prompts) allow();
    await Promise.all([first, second]);
    assert.equal(mic.state, "on");
    assert.deepEqual(b.tracks.map((t) => t.stopped), [true, false], "the overtaken prompt's track is stopped");
    assert.equal(b.contexts.length, 1);
    assert.equal(b.session.type, "play-and-record");
    mic.stop();
    assert.equal(b.session.type, "playback");
    assert.deepEqual(b.tracks.map((t) => t.stopped), [true, true]);
    await Promise.resolve();
    assert.ok(b.contexts.every((c) => c.closed));
  } finally {
    b.restore();
  }
});

test("a stop while the worklet loads closes that start's capture", async () => {
  const b = fakeBrowser();
  try {
    const mic = new MicPipe({} as never);
    const started = mic.start();
    b.prompts[0]!();
    // Let `getUserMedia` settle and the worklet load begin, then turn the microphone off.
    await new Promise((r) => setTimeout(r, 0));
    mic.stop();
    await started;
    assert.equal(mic.state, "off");
    assert.deepEqual(b.tracks.map((t) => t.stopped), [true]);
    assert.ok(b.contexts.every((c) => c.closed));
  } finally {
    b.restore();
  }
});

type Resampler = { push(x: Float32Array, emit: (v: number) => void): void };
const Resampler = new Function(`${RESAMPLER}; return Resampler;`)() as new (from: number) => Resampler;

/** One second of a ramp at `rate`, pushed in render quanta; what comes out at 48 kHz. */
const resampled = (rate: number): number[] => {
  const r = new Resampler(rate);
  const out: number[] = [];
  const ramp = Float32Array.from({ length: rate }, (_, i) => i);
  for (let at = 0; at < ramp.length; at += 128) r.push(ramp.subarray(at, at + 128), (v) => out.push(v));
  return out;
};

test("the resampler brings a ramp to 48 kHz across block edges, up and down", () => {
  for (const rate of [44_100, 16_000, 96_000]) {
    const out = resampled(rate);
    // A second in is a second out, less the samples still waiting on the next block.
    assert.ok(out.length <= 48_000 && out.length >= 48_000 - 3, `${rate}: ${out.length}`);
    const step = rate / 48_000;
    out.forEach((v, j) => assert.ok(Math.abs(v - j * step) < 1e-3, `${rate} sample ${j}: ${v}`));
  }
});

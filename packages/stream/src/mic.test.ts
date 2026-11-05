// The microphone: a start overtaken by a stop, or by a stop and another start, closes what it
// opened, so exactly one capture is ever live.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MicPipe } from "./mic.ts";

/** Browser stand-ins for one test; `prompts` resolves each `getUserMedia` the page asked for. */
function fakeBrowser() {
  const tracks: Array<{ stopped: boolean }> = [];
  const contexts: Array<{ closed: boolean }> = [];
  const prompts: Array<() => void> = [];
  const stubs: Record<string, unknown> = {
    navigator: {
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
  return { tracks, contexts, prompts, restore };
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
    mic.stop();
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

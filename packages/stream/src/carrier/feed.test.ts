// The feed against a stand-in wasm module: a four-slot ring of eight bytes, and a heap the tests
// read back. What is pinned is where bytes land and when the session is pumped.

import { test } from "node:test";
import assert from "node:assert/strict";

/** The per-burst tick, run by hand: `pending` is how many posts are waiting. */
const ports: Array<{ onmessage: (() => void) | null; pending: number }> = [];
class HandChannel {
  port1 = { onmessage: null as (() => void) | null, pending: 0 };
  port2 = { postMessage: () => this.port1.pending++ };
  constructor() {
    ports.push(this.port1);
  }
}
Object.assign(globalThis, { MessageChannel: HandChannel });
const { wasmFeed } = await import("./feed.ts");

const BASE = 64;
const STRIDE = 8;

function fakeModule(slots = 4) {
  const heap = new Uint8Array(256);
  const log: string[] = [];
  let free = slots;
  let next = 200;
  const mod = {
    HEAPU8: heap,
    _pf_rx_base: () => BASE,
    _pf_rx_stride: () => STRIDE,
    _pf_rx_claim: () => (free > 0 ? slots - free-- : -1),
    _pf_rx_commit: (slot: number, len: number) => log.push(`commit ${slot} ${len}`),
    _malloc: (n: number) => {
      log.push(`malloc ${n}`);
      return (next += 16) - 16;
    },
    _free: (p: number) => log.push(`free ${p}`),
    _pf_ctl_recv: (p: number, n: number) => log.push(`ctl ${[...heap.subarray(p, p + n)]}`),
    _pf_uni_recv: (p: number, n: number) => log.push(`uni ${[...heap.subarray(p, p + n)]}`),
    __pfOnData: () => {
      log.push("pump");
      free = slots;
    },
  };
  return { mod, heap, log };
}

const feedOf = (mod: object) => wasmFeed(mod as Parameters<typeof wasmFeed>[0]);

test("a datagram lands in the slot Rust claimed, and the burst is pumped once", () => {
  const { mod, heap, log } = fakeModule();
  const feed = feedOf(mod);
  feed.datagram(new Uint8Array([1, 2, 3]));
  feed.datagram(new Uint8Array([4, 5]));
  assert.deepEqual([...heap.subarray(BASE, BASE + 3)], [1, 2, 3]);
  assert.deepEqual([...heap.subarray(BASE + STRIDE, BASE + STRIDE + 2)], [4, 5]);
  assert.deepEqual(log, ["commit 0 3", "commit 1 2"], "nothing is pumped inside the burst");
  const port = ports.at(-1)!;
  assert.equal(port.pending, 1, "one tick for the whole burst");
  port.onmessage!();
  assert.deepEqual(log.at(-1), "pump");
});

test("a full ring is drained before the datagram, not dropped", () => {
  const { mod, heap, log } = fakeModule(1);
  const feed = feedOf(mod);
  feed.datagram(new Uint8Array([7]));
  feed.datagram(new Uint8Array([8, 9]));
  assert.deepEqual(log, ["commit 0 1", "pump", "commit 0 2"]);
  assert.deepEqual([...heap.subarray(BASE, BASE + 2)], [8, 9]);
});

test("a datagram longer than a slot is not written", () => {
  const { mod, log } = fakeModule();
  feedOf(mod).datagram(new Uint8Array(STRIDE + 1));
  assert.deepEqual(log, []);
});

test("control and stream bytes cross through a buffer freed after the call", () => {
  const { mod, log } = fakeModule();
  const feed = feedOf(mod);
  feed.control(new Uint8Array([0, 9]));
  feed.uni(new Uint8Array([5]));
  feed.uni(new Uint8Array(0));
  assert.deepEqual(log, ["malloc 2", "ctl 0,9", "free 200", "malloc 1", "uni 5", "free 216"]);
});

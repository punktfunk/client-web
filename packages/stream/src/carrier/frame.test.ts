// The tag codec, as a table. The byte-for-byte cases are the ones the page server's
// `server/src/bridge/frame.rs` pins too: either side drifting fails here or there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, encode, type Frame, TAG } from "./frame.ts";

const bytes = (...b: number[]) => new Uint8Array(b);

test("every frame round-trips", () => {
  const frames: Frame[] = [
    { tag: TAG.DATAGRAM, bytes: bytes(5, 1, 2) },
    { tag: TAG.CONTROL, bytes: bytes() },
    { tag: TAG.UNI, bytes: bytes(9, 9) },
    { tag: TAG.CLOSE, code: 0x51, reason: "beendet · quit" },
    { tag: TAG.CLOSE, code: 0xffff_ffff, reason: "" },
    { tag: TAG.PING, sentMs: 1234.5 },
    { tag: TAG.PING, sentMs: 98765.4321, bridgeRttUs: 900 },
  ];
  for (const f of frames) {
    const back = decode(encode(f));
    assert.deepEqual(
      back && "bytes" in back ? { ...back, bytes: [...back.bytes] } : back,
      "bytes" in f ? { ...f, bytes: [...f.bytes] } : f,
    );
  }
});

test("the bytes are the contract the server reads", () => {
  assert.deepEqual(encode({ tag: TAG.CLOSE, code: 0x51, reason: "bye" }), bytes(3, 0, 0, 0, 0x51, 0x62, 0x79, 0x65));
  assert.deepEqual(encode({ tag: TAG.DATAGRAM, bytes: bytes(0x78) }), bytes(0, 0x78));
  // The server echoes the f64 untouched; its u32 is big-endian.
  const pong = decode(bytes(4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 4));
  assert.equal(pong?.tag, TAG.PING);
  assert.equal(pong && "bridgeRttUs" in pong ? pong.bridgeRttUs : 0, 0x0102_0304);
  assert.deepEqual(encode({ tag: TAG.PING, sentMs: 1 }).subarray(1), new Uint8Array(new Float64Array([1]).buffer).reverse());
});

test("unknown tags and truncated closes and pings are refused", () => {
  for (const msg of [
    bytes(),
    bytes(5, 1, 2, 3),
    bytes(3, 0, 0, 0x51),
    bytes(4, 0, 0, 0),
    bytes(4, ...new Array(9).fill(0)),
    bytes(4, ...new Array(13).fill(0)),
  ]) {
    assert.equal(decode(msg), null, `[${[...msg]}]`);
  }
  assert.deepEqual(decode(bytes(3, 0, 0, 0, 7)), { tag: TAG.CLOSE, code: 7, reason: "" }, "a close may carry no reason");
});

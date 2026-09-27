// The `OpusHead` a surround decoder is built from (RFC 7845 §5.1, mapping family 255).

import { test } from "node:test";
import assert from "node:assert/strict";
import { opusHead } from "./audio.ts";

test("a family-255 OpusHead carries the host's streams and mapping", () => {
  const head = opusHead(6, 4, 2, [0, 1, 4, 5, 2, 3]);
  assert.equal(new TextDecoder().decode(head.subarray(0, 8)), "OpusHead");
  assert.deepEqual([...head.subarray(8, 10)], [1, 6], "version 1, six channels");
  assert.deepEqual([...head.subarray(10, 18)], [0, 0, 0x80, 0xbb, 0, 0, 0, 0], "no pre-skip, 48 kHz, no gain");
  assert.deepEqual([...head.subarray(18)], [255, 4, 2, 0, 1, 4, 5, 2, 3]);
});

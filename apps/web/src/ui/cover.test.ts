import assert from "node:assert/strict";
import { test } from "node:test";
import { bmp, fit } from "./cover.ts";

test("a cover is fitted by its longer side and never enlarged", () => {
  assert.deepEqual(fit(600, 900), [480, 720]);
  assert.deepEqual(fit(1000, 1500), [480, 720]);
  assert.deepEqual(fit(460, 215), [460, 215]);
  assert.deepEqual(fit(300, 450), [300, 450]);
});

test("the bitmap is a 32-bit bottom-up BMP with the pixels swapped to BGR", () => {
  // Two rows of one pixel: red on top, blue below.
  const out = bmp(1, 2, new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 128]));
  const v = new DataView(out.buffer);
  assert.equal(String.fromCharCode(out[0]!, out[1]!), "BM");
  assert.equal(v.getUint32(2, true), out.length);
  assert.equal(out.length, 54 + 8);
  assert.equal(v.getUint32(10, true), 54);
  assert.equal(v.getInt32(18, true), 1);
  assert.equal(v.getInt32(22, true), 2);
  assert.equal(v.getUint16(28, true), 32);
  // Bottom-up: the first stored row is the bottom one, blue, as B G R x.
  assert.deepEqual([...out.subarray(54, 58)], [255, 0, 0, 255]);
  assert.deepEqual([...out.subarray(58, 62)], [0, 0, 255, 255]);
});

// The shared size rule. Cases are punktfunk's `clients/shared/custom-resolution-vectors.json`,
// which the Rust, Swift and Kotlin twins run too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ASPECTS, aspectOf, customSize, nearest } from "./resolutions.ts";

const VECTORS: Array<[name: string, typed: [number, number], codec: string, want: [number, number]]> = [
  ["a listed size passes", [1920, 1080], "hevc", [1920, 1080]],
  ["odd sides floor even", [1921, 1081], "hevc", [1920, 1080]],
  ["a handheld", [1280, 800], "auto", [1280, 800]],
  ["portrait", [1080, 2400], "av1", [1080, 2400]],
  ["an unlisted shape", [1500, 1000], "hevc", [1500, 1000]],
  ["below the floor", [100, 100], "hevc", [320, 200]],
  ["zero", [0, 0], "auto", [320, 200]],
  ["odd at the floor", [321, 201], "hevc", [320, 200]],
  ["H.264 ceiling", [5120, 2880], "h264", [4096, 2880]],
  ["H.264 ceiling, both sides", [8191, 4097], "h264", [4096, 4096]],
  ["HEVC ceiling", [9999, 9999], "hevc", [8192, 8192]],
  ["Automatic takes the wider ceiling", [7680, 4320], "auto", [7680, 4320]],
  ["PyroWave ceiling", [10000, 1440], "pyrowave", [8192, 1440]],
];

test("a typed size goes through the shared rule", () => {
  for (const [name, [w, h], codec, want] of VECTORS) assert.deepEqual(customSize(w, h, codec), want, name);
});

test("a size belongs to its family by shape", () => {
  assert.equal(ASPECTS[aspectOf(1920, 1080)]?.label, "16:9");
  assert.equal(ASPECTS[aspectOf(3440, 1440)]?.label, "21:9");
  assert.equal(ASPECTS[aspectOf(1500, 1000)]?.label, "3:2", "a custom size too");
  assert.equal(aspectOf(0, 0), -1, "Native has no shape");
  assert.deepEqual(nearest(1, 1080), [1920, 1200]);
  assert.deepEqual(nearest(0, 0), [1920, 1080], "Native looks for 1080");
});

// What the page offers a host: H.264 always, HEVC and AV1 where the browser decodes them, and
// HDR only when every one of those also decodes at 10 bits.
//
// `video.ts` pulls in the planes, which use constructor parameter properties, so `npm test`
// runs node with `--experimental-transform-types`.

import { test } from "node:test";
import assert from "node:assert/strict";

let decodes = new Set<string>();
globalThis.VideoDecoder = {
  isConfigSupported: async ({ codec }: { codec: string }) => ({ supported: decodes.has(codec) }),
} as unknown as typeof VideoDecoder;
const { decodableCodecs } = await import("./video.ts");

test("the offer follows what the browser decodes", async () => {
  decodes = new Set();
  assert.deepEqual(await decodableCodecs(), { mask: 1, tenBit: false }, "H.264 alone offers no HDR");

  decodes = new Set(["hev1.1.6.L153.B0", "hev1.2.4.L153.B0"]);
  assert.deepEqual(await decodableCodecs(), { mask: 1 | 2, tenBit: true });

  // AV1 at 8 bits only: offered, but an HDR stream in AV1 could not be decoded, so no HDR.
  decodes = new Set(["hev1.1.6.L153.B0", "hev1.2.4.L153.B0", "av01.0.13M.08"]);
  assert.deepEqual(await decodableCodecs(), { mask: 1 | 2 | 4, tenBit: false });
});

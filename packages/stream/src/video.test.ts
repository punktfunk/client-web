// The decoder's recovery, against a stand-in WebCodecs that acts like a browser with no hardware
// decoder: it refuses `prefer-hardware` after `configure`, and `close()` on a closed codec throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PunktfunkModule } from "./emscripten.ts";

let decodes: (accel: HardwareAcceleration) => boolean = () => true;
let decoders: FakeDecoder[] = [];

class FakeDecoder {
  state: CodecState = "unconfigured";
  config: VideoDecoderConfig | null = null;
  private readonly init: VideoDecoderInit;
  constructor(init: VideoDecoderInit) {
    this.init = init;
    decoders.push(this);
  }
  static async isConfigSupported(config: VideoDecoderConfig) {
    return { supported: decodes(config.hardwareAcceleration ?? "no-preference"), config };
  }
  configure(config: VideoDecoderConfig) {
    this.config = config;
    this.state = "configured";
    if (decodes(config.hardwareAcceleration ?? "no-preference")) return;
    this.state = "closed";
    setTimeout(() => this.init.error(new DOMException("Unsupported configuration.", "OperationError")), 0);
  }
  close() {
    if (this.state === "closed") throw new DOMException("Cannot call 'close' on a closed codec.", "InvalidStateError");
    this.state = "closed";
  }
}
globalThis.VideoDecoder = FakeDecoder as unknown as typeof VideoDecoder;
const { VideoPipe } = await import("./video.ts");

/** A pipe with a stand-in plane, told the stream is H.264 at 1080p. */
function stream() {
  decoders = [];
  const asked: string[] = [];
  let undecodable = 0;
  const mod = { _pf_request_keyframe: () => asked.push("keyframe") } as unknown as PunktfunkModule;
  const pipe = new VideoPipe(mod, {} as HTMLCanvasElement, "auto", undefined, () => undecodable++);
  // A real plane needs a GPU; the pipe only configures and destroys this one.
  Object.assign(pipe, { plane: { configure() {}, setDynamicRange() {}, destroy() {} } });
  pipe.attach();
  mod.__pfOnVideoConfig!(1, 1920, 1080, 8, false, false);
  return { pipe, asked, undecodable: () => undecodable };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("a browser without a hardware decoder streams on the one it has", async () => {
  decodes = (accel) => accel !== "prefer-hardware";
  const { pipe, asked, undecodable } = stream();
  await settle();
  assert.equal(decoders.length, 2);
  assert.equal(decoders[1]!.config!.hardwareAcceleration, "no-preference");
  assert.equal(decoders[1]!.state, "configured");
  assert.deepEqual(asked, ["keyframe"], "the fresh decoder resumes on an IDR");
  assert.equal(undecodable(), 0);
  pipe.close();
  assert.equal(decoders[1]!.state, "closed");
});

test("a stream the browser cannot decode ends, and the pipe still closes", async () => {
  decodes = () => false;
  const { pipe, asked, undecodable } = stream();
  await settle();
  assert.equal(decoders.length, 1, "no decoder is built for a configuration the browser refuses");
  assert.equal(undecodable(), 1);
  assert.deepEqual(asked, []);
  assert.doesNotThrow(() => pipe.close());
});

// The decoder's recovery, against a stand-in WebCodecs that acts like a browser told what it
// decodes: `configure` refuses the rest after the fact, `isConfigSupported` may claim more than
// `configure` takes, and `close()` on a closed codec throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PunktfunkModule } from "./emscripten.ts";

interface Browser {
  /** What `configure` takes. */
  decodes: (accel: HardwareAcceleration) => boolean;
  /** What `isConfigSupported` says yes to: `decodes`, unless it lies. */
  claims?: (accel: HardwareAcceleration) => boolean;
  /** What `configure` throws on rather than calling `error`. */
  throws?: (accel: HardwareAcceleration) => boolean;
}
let browser: Browser = { decodes: () => true };
let decoders: FakeDecoder[] = [];
/** Every acceleration `isConfigSupported` was asked about, in order. */
let probed: HardwareAcceleration[] = [];

class FakeDecoder {
  state: CodecState = "unconfigured";
  config: VideoDecoderConfig | null = null;
  private readonly init: VideoDecoderInit;
  constructor(init: VideoDecoderInit) {
    this.init = init;
    decoders.push(this);
  }
  static async isConfigSupported(config: VideoDecoderConfig) {
    const accel = config.hardwareAcceleration ?? "no-preference";
    probed.push(accel);
    return { supported: (browser.claims ?? browser.decodes)(accel), config };
  }
  configure(config: VideoDecoderConfig) {
    const accel = config.hardwareAcceleration ?? "no-preference";
    if (browser.throws?.(accel)) throw new TypeError("Unsupported codec.");
    this.config = config;
    this.state = "configured";
    if (browser.decodes(accel)) return;
    this.state = "closed";
    setTimeout(() => this.init.error(new DOMException("Unsupported configuration.", "OperationError")), 0);
  }
  close() {
    if (this.state === "closed") throw new DOMException("Cannot call 'close' on a closed codec.", "InvalidStateError");
    this.state = "closed";
  }
  /** A decoded frame out. */
  emit() {
    this.init.output({ timestamp: 0, close() {} } as unknown as VideoFrame);
  }
  /** A working decoder fails, as one does when the GPU goes away. */
  fail() {
    this.state = "closed";
    this.init.error(new DOMException("Decoding error.", "EncodingError"));
  }
}
globalThis.VideoDecoder = FakeDecoder as unknown as typeof VideoDecoder;
const { VideoPipe } = await import("./video.ts");

/** A pipe with a stand-in plane, told the stream is H.264 at 1080p. */
function stream() {
  decoders = [];
  probed = [];
  const asked: string[] = [];
  const refused: number[] = [];
  const kinds: number[] = [];
  const mod = {
    _pf_request_keyframe: () => asked.push("keyframe"),
    _pf_hud_decoded: () => {},
    _pf_gate_decoded: () => 1,
    _pf_video_decoder: (accel: number) => kinds.push(accel),
  } as unknown as PunktfunkModule;
  const pipe = new VideoPipe(mod, {} as HTMLCanvasElement, "auto", undefined, (codec) => refused.push(codec));
  // A real plane needs a GPU; the pipe only configures and destroys this one.
  const plane = { configure() {}, setDynamicRange() {}, destroy() {}, takeUploadStats: () => ({ frames: 0 }) };
  Object.assign(pipe, { plane });
  pipe.attach();
  mod.__pfOnVideoConfig!(1, 1920, 1080, 8, false, false);
  return { pipe, asked, refused, kinds };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
/** Wait for `done`: each rebuild after the first waits out the half-second throttle. */
const until = async (done: () => boolean) => {
  for (let i = 0; i < 150 && !done(); i++) await settle();
};

test("a browser without a hardware decoder streams on the one it has", async () => {
  browser = { decodes: (accel) => accel !== "prefer-hardware" };
  const { pipe, asked, refused } = stream();
  await settle();
  assert.equal(decoders.length, 2);
  assert.equal(decoders[1]!.config!.hardwareAcceleration, "no-preference");
  assert.equal(decoders[1]!.state, "configured");
  assert.deepEqual(asked, ["keyframe"], "the fresh decoder resumes on an IDR");
  assert.deepEqual(refused, []);
  pipe.close();
  assert.equal(decoders[1]!.state, "closed");
});

test("a stream the browser cannot decode ends, and the pipe still closes", async () => {
  browser = { decodes: () => false };
  const { pipe, asked, refused } = stream();
  await settle();
  assert.equal(decoders.length, 1, "no decoder is built for a configuration the browser refuses");
  assert.deepEqual(refused, [1], "the pipe names the codec it could not decode");
  assert.deepEqual(asked, []);
  assert.doesNotThrow(() => pipe.close());
});

test("a browser that claims what it then refuses moves down to software, then gives up", async () => {
  browser = { decodes: () => false, claims: () => true };
  const { pipe, refused } = stream();
  await until(() => refused.length > 0);
  assert.deepEqual(
    decoders.map((d) => d.config!.hardwareAcceleration),
    ["prefer-hardware", "no-preference", "prefer-software"],
  );
  assert.deepEqual(probed, ["no-preference", "prefer-software"], "hardware is never asked about again");
  assert.deepEqual(refused, [1]);
  pipe.close();
});

test("a configure that throws reaches the rebuild like one that errors", async () => {
  browser = { decodes: () => true, throws: (accel) => accel === "prefer-hardware" };
  const { pipe, asked, refused } = stream();
  await until(() => decoders.length === 2);
  assert.equal(decoders[1]!.config!.hardwareAcceleration, "no-preference");
  assert.equal(decoders[1]!.state, "configured");
  assert.equal(pipe.snapshot().errors, 1);
  assert.deepEqual(asked, ["keyframe"]);
  assert.deepEqual(refused, []);
  pipe.close();
});

test("the first frame tells the overlay how it decodes, and a later error keeps that", async () => {
  browser = { decodes: () => true };
  const { pipe, kinds } = stream();
  decoders[0]!.emit();
  decoders[0]!.emit();
  assert.deepEqual(kinds, [1], "hardware, said once");
  decoders[0]!.fail();
  await until(() => decoders.length === 2);
  assert.equal(decoders[1]!.config!.hardwareAcceleration, "prefer-hardware", "a decoder that worked keeps its acceleration");
  pipe.close();
});

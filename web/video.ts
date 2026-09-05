// Access units in, pixels on the lower canvas out.
//
// The half that was missing: the wasm side has been handing whole access units to
// `__pfOnAccessUnit` since the session pump landed, and nothing was decoding them. This is that,
// and it is deliberately the only file that knows `VideoDecoder` exists.
//
// R3 holds through it. What arrives from Rust is an encoded access unit copied out of the wasm
// heap; what leaves the decoder is a `VideoFrame` that goes straight to the plane and is closed.
// No decoded pixel is ever in wasm memory, which is what keeps the WebGPU swap to one file.

import type { PunktfunkModule } from "./emscripten.ts";
import { VideoSurface, type VideoPlane } from "./video-surface.ts";
import { VideoSurfaceWebGPU } from "./video-surface-webgpu.ts";

/** Wire codec ids, as `Welcome` carries them. */
const CODEC_H264 = 1;
const CODEC_HEVC = 2;

export interface VideoStats {
  /** Access units handed to the decoder. */
  submitted: number;
  /** Frames the decoder produced. A gap against `submitted` is loss or a decoder still filling. */
  decoded: number;
  /** Frames dropped rather than presented because a newer one had already arrived. */
  dropped: number;
  errors: number;
  /** Average milliseconds in the plane's `present`. */
  uploadMs: number;
  width: number;
  height: number;
  backend: "webgpu" | "webgl2" | null;
}

/**
 * Which plane to draw on.
 *
 * WebGPU when the engine has it, because it is the only shipped HDR route; WebGL2 otherwise.
 * Both satisfy the same seam, so this choice is invisible above.
 */
export async function createPlane(
  canvas: HTMLCanvasElement,
  prefer: "auto" | "webgl2" | "webgpu" = "auto",
): Promise<{ plane: VideoPlane; backend: "webgpu" | "webgl2" }> {
  if (prefer !== "webgl2") {
    try {
      return { plane: await VideoSurfaceWebGPU.create(canvas), backend: "webgpu" };
    } catch (e) {
      if (prefer === "webgpu") throw e;
      // Falling back is the normal path on an engine without WebGPU, not a failure worth a
      // dialog — the WebGL2 plane shows the same picture.
    }
  }
  return { plane: new VideoSurface(canvas), backend: "webgl2" };
}

/**
 * The decoder, bound to one module and one plane.
 *
 * Configured from the `Welcome` the host sent rather than from the bitstream, and re-configured
 * if the host changes mode mid-session. `close()` releases both.
 */
export class VideoPipe {
  private decoder: VideoDecoder | null = null;
  private plane: VideoPlane | null = null;
  private backend: "webgpu" | "webgl2" | null = null;
  private pending: VideoFrame | null = null;
  private stats: VideoStats = {
    submitted: 0,
    decoded: 0,
    dropped: 0,
    errors: 0,
    uploadMs: 0,
    width: 0,
    height: 0,
    backend: null,
  };

  constructor(
    private readonly mod: PunktfunkModule,
    private readonly canvas: HTMLCanvasElement,
    private readonly prefer: "auto" | "webgl2" | "webgpu" = "auto",
  ) {}

  /** Install the callbacks the glue calls. Idempotent, so a reconnect can call it again. */
  attach(): void {
    this.mod.__pfOnVideoConfig = (codec, width, height) => {
      void this.configure(codec, width, height);
    };
    this.mod.__pfOnAccessUnit = (data, ptsUs, key) => this.submit(data, ptsUs, key);
  }

  private async configure(codec: number, width: number, height: number): Promise<void> {
    this.stats.width = width;
    this.stats.height = height;
    if (!this.plane) {
      const made = await createPlane(this.canvas, this.prefer);
      this.plane = made.plane;
      this.backend = made.backend;
      this.stats.backend = made.backend;
    }
    this.plane.configure(width, height);

    this.decoder?.close();
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        this.stats.errors++;
        console.error("punktfunk: decoder", e);
      },
    });
    // Annex B, so no `description`: the host sends parameter sets inline with every IDR, which is
    // what lets a browser join a stream already in progress.
    decoder.configure({
      codec: codec === CODEC_HEVC ? "hev1.1.6.L93.B0" : "avc1.42E01F",
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    });
    this.decoder = decoder;
  }

  private submit(data: Uint8Array, ptsUs: number, key: boolean): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return;
    // WebCodecs requires the first chunk to be a key frame, and a delta before one is a hard
    // error rather than a dropped frame. The wire carries no such bit, so `is_keyframe` in
    // `session.rs` reads it out of the bitstream; this is the other half of that.
    if (this.stats.submitted === 0 && !key) return;
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? "key" : "delta",
          timestamp: ptsUs,
          data,
        }),
      );
      this.stats.submitted++;
    } catch (e) {
      this.stats.errors++;
      console.error("punktfunk: decode", e);
    }
  }

  // Keep only the newest frame. The decoder can outrun the display, and holding several open
  // stalls it — WebCodecs bounds how many may be outstanding — so an older frame is closed rather
  // than queued. Presenting happens on the page's own rAF, which is where pacing belongs.
  private onFrame(frame: VideoFrame): void {
    this.stats.decoded++;
    if (this.pending) {
      this.pending.close();
      this.stats.dropped++;
    }
    this.pending = frame;
  }

  /** Draw whatever the decoder has produced. Called once per `requestAnimationFrame`. */
  present(): void {
    const frame = this.pending;
    if (!frame || !this.plane) return;
    this.pending = null;
    try {
      this.plane.present(frame);
    } finally {
      // The plane borrows the frame for the call and no longer: closing here is what keeps the
      // decoder from stalling on outstanding frames.
      frame.close();
    }
  }

  snapshot(): VideoStats {
    const upload = this.plane?.takeUploadStats();
    if (upload?.frames) this.stats.uploadMs = upload.perFrameMs;
    return { ...this.stats };
  }

  setDynamicRange(mode: "standard" | "high"): void {
    this.plane?.setDynamicRange(mode);
  }

  close(): void {
    this.pending?.close();
    this.pending = null;
    this.decoder?.close();
    this.decoder = null;
    this.plane?.destroy();
    this.plane = null;
    delete this.mod.__pfOnVideoConfig;
    delete this.mod.__pfOnAccessUnit;
  }
}

/** Can this engine decode what a punktfunk host sends? Checked before dialling, so an engine
 *  without WebCodecs says so rather than connecting and showing black. */
export function decodeSupported(): boolean {
  return typeof VideoDecoder !== "undefined";
}

export { CODEC_H264, CODEC_HEVC };

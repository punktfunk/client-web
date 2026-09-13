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

/** Unix ms from `Date.now()`, the clock the engine's receipt stamps come from, so the overlay's
 *  decode and display stages subtract like for like. */
const unixMs = (): number => Date.now();

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
  /** Frames withheld after a loss until the stream re-anchored. */
  held: number;
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
  /** Each submitted access unit's wire flags and key bit, by timestamp, until its frame is out. */
  private meta = new Map<number, { flags: number; key: boolean }>();
  /** A fresh decoder takes a key frame first; deltas before one are refused. */
  private needKey = true;
  private codec = 0;
  private lastRebuildMs = 0;
  /** When `pending` left the decoder, for the overlay's display stage. */
  private pendingDecodedMs = 0;
  private stats: VideoStats = {
    submitted: 0,
    decoded: 0,
    dropped: 0,
    errors: 0,
    held: 0,
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
    this.mod.__pfOnAccessUnit = (data, ptsUs, key, flags) => this.submit(data, ptsUs, key, flags);
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

    this.codec = codec;
    this.decoder?.close();
    this.meta.clear();
    this.needKey = true;
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        this.stats.errors++;
        console.error("punktfunk: decoder", e);
        this.rebuild();
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

  private submit(data: Uint8Array, ptsUs: number, key: boolean, flags: number): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return;
    // WebCodecs requires the first chunk after a configure to be a key frame, and a delta before
    // one is a hard error rather than a dropped frame. The wire carries no such bit, so
    // `is_keyframe` in `session.rs` reads it out of the bitstream; this is the other half of that.
    if (this.needKey && !key) return;
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? "key" : "delta",
          timestamp: ptsUs,
          data,
        }),
      );
      this.needKey = false;
      this.stats.submitted++;
      this.meta.set(ptsUs, { flags, key });
      // Frames the decoder dropped never come back to claim their entry.
      if (this.meta.size > 256) this.meta.delete(this.meta.keys().next().value as number);
    } catch (e) {
      this.stats.errors++;
      console.error("punktfunk: decode", e);
      this.mod._pf_gate_no_output();
    }
  }

  // A decoder that errored is closed for good. Build a fresh one and resume on the next IDR,
  // asked for now; the gate holds the last picture meanwhile. At most twice a second, so a
  // stream the browser cannot decode at all does not spin.
  private rebuild(): void {
    const now = performance.now();
    if (now - this.lastRebuildMs < 500 || !this.plane) return;
    this.lastRebuildMs = now;
    this.mod._pf_request_keyframe();
    void this.configure(this.codec, this.stats.width, this.stats.height);
  }

  // Keep only the newest frame. The decoder can outrun the display, and holding several open
  // stalls it — WebCodecs bounds how many may be outstanding — so an older frame is closed rather
  // than queued. Presenting happens on the page's own rAF, which is where pacing belongs.
  private onFrame(frame: VideoFrame): void {
    this.stats.decoded++;
    const at = unixMs();
    this.mod._pf_hud_decoded(frame.timestamp, at);
    const meta = this.meta.get(frame.timestamp);
    this.meta.delete(frame.timestamp);
    // After a loss the decoder conceals, and a concealed picture is the gray smear: hold the last
    // good one until the stream re-anchors (`ReanchorGate`, shared with the native clients).
    if (!this.mod._pf_gate_decoded(meta?.flags ?? 0, meta?.key ? 1 : 0)) {
      frame.close();
      this.stats.held++;
      return;
    }
    if (this.pending) {
      this.pending.close();
      this.stats.dropped++;
    }
    this.pending = frame;
    this.pendingDecodedMs = at;
  }

  /** Draw whatever the decoder has produced. Called once per `requestAnimationFrame`. */
  present(): void {
    const frame = this.pending;
    if (!frame || !this.plane) return;
    this.pending = null;
    try {
      this.plane.present(frame);
      this.mod._pf_hud_presented(frame.timestamp, this.pendingDecodedMs, unixMs());
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

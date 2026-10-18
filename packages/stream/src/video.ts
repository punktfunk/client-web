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
import { tizen } from "./platform.ts";
import { VideoSurface, type VideoPlane } from "./video-surface.ts";
import { VideoSurfaceWebGPU } from "./video-surface-webgpu.ts";

/** Unix ms from `Date.now()`, the clock the engine's receipt stamps come from, so the overlay's
 *  decode and display stages subtract like for like. */
const unixMs = (): number => Date.now();

/** Wire codec ids, as `Welcome` carries them. */
const CODEC_H264 = 1;
const CODEC_HEVC = 2;
const CODEC_AV1 = 4;

/** What the decoder is configured with, per codec: Annex B for the two NAL codecs (no
 *  `description`: the host sends parameter sets with every IDR), low-overhead OBUs for AV1. The
 *  levels are 5.1, enough for 4K at 60. */
const CODEC_STRING: Record<number, string> = {
  [CODEC_H264]: "avc1.42E01F",
  [CODEC_HEVC]: "hev1.1.6.L153.B0",
  [CODEC_AV1]: "av01.0.13M.08",
};

/** The same at 10 bits (HEVC Main 10, AV1 Main 10-bit), which an HDR stream is. */
const CODEC_STRING_10: Record<number, string> = {
  [CODEC_HEVC]: "hev1.2.4.L153.B0",
  [CODEC_AV1]: "av01.0.13M.10",
};

const codecString = (codec: number, depth: number): string =>
  (depth > 8 ? CODEC_STRING_10[codec] : undefined) ?? CODEC_STRING[codec] ?? CODEC_STRING[CODEC_H264]!;

/** What this browser decodes: `CODEC_*` bits, and whether every one of them past H.264 also
 *  decodes at 10 bits, which is what an HDR stream needs. */
export interface Decodable {
  mask: number;
  tenBit: boolean;
}

/**
 * The codecs this browser decodes in hardware: H.264 always, HEVC and AV1 when
 * `isConfigSupported` says so. Hardware only, because a software HEVC or AV1 decode of a game
 * stream falls behind where H.264 would not.
 *
 * Not AV1 on a Samsung set. Its runtime answers yes to every codec string, 4K AV1 included,
 * and a yes there is a hint rather than a measurement: a software AV1 decode on a TV SoC is
 * the stream falling behind. HEVC stays on offer until the first measured stream says otherwise.
 */
export async function decodableCodecs(): Promise<Decodable> {
  const ok = async (codec: string): Promise<boolean> => {
    try {
      const { supported } = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: 1920,
        codedHeight: 1080,
        hardwareAcceleration: "prefer-hardware",
      });
      return supported === true;
    } catch {
      // An engine that throws on a codec string it does not know simply does not decode it.
      return false;
    }
  };
  let mask = CODEC_H264;
  let tenBit = true;
  for (const codec of offeredBeyondH264()) {
    if (!(await ok(CODEC_STRING[codec]!))) continue;
    mask |= codec;
    tenBit &&= await ok(CODEC_STRING_10[codec]!);
  }
  return { mask, tenBit: tenBit && mask !== CODEC_H264 };
}

/** The codecs worth asking the engine about, past H.264: a platform gate, not a setting. */
export function offeredBeyondH264(): number[] {
  return tizen() ? [CODEC_HEVC] : [CODEC_HEVC, CODEC_AV1];
}

/** Whether WebGPU gives this page an adapter: the plane HDR needs, not merely the API. A
 *  runtime that has `navigator.gpu` and hands back `null` — a Samsung set — is a no here, and
 *  `createPlane` lands on WebGL2 for the same reason. */
export async function webgpuUsable(): Promise<boolean> {
  try {
    return !!(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

/** This browser build converted a PQ frame itself despite being told not to (`PQ_PASSTHROUGH`).
 *  Kept per user agent, so an update is tried again. */
const HDR_REFUSED_KEY = "pf.hdr-refused";

function hdrRefused(): boolean {
  try {
    return localStorage.getItem(HDR_REFUSED_KEY) === navigator.userAgent;
  } catch {
    return false;
  }
}

function refuseHdr(): void {
  try {
    localStorage.setItem(HDR_REFUSED_KEY, navigator.userAgent);
  } catch {
    // Storage blocked: the next stream tries HDR once more and falls back again.
  }
}

/** Can this page show an HDR stream now: a display in high dynamic range, a WebGPU plane — the
 *  only route to one that ships — and a browser not already seen converting PQ itself. */
export function hdrDisplay(backend: "auto" | "webgl2" | "webgpu", gpu: boolean): boolean {
  return (
    backend !== "webgl2" &&
    gpu &&
    !hdrRefused() &&
    typeof matchMedia === "function" &&
    matchMedia("(dynamic-range: high)").matches
  );
}

/**
 * What an HDR decoder is told the picture is: BT.2020's matrix, but BT.709 primaries and the sRGB
 * transfer. The browser then converts YCbCr to RGB and nothing else, and the plane receives the
 * PQ signal as sent, which `fs_pq` decodes. Left to itself, each engine ran PQ through an SDR
 * conversion, and the picture came out grey.
 */
const PQ_PASSTHROUGH: VideoColorSpaceInit = {
  primaries: "bt709",
  transfer: "iec61966-2-1",
  // In the WebCodecs registry, not yet in TypeScript's DOM types.
  matrix: "bt2020-ncl" as VideoMatrixCoefficients,
  fullRange: false,
};

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
  /** `Welcome`'s bit depth and whether it is HDR, for the decoder string and the plane. */
  private depth = 8;
  private hdr = false;
  /** The first frame of an HDR configure has been checked for `PQ_PASSTHROUGH`. */
  private hdrChecked = false;
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
    /** The browser converted an HDR frame itself: this stream cannot be shown right. */
    private readonly onHdrRefused?: () => void,
  ) {}

  /** Install the callbacks the glue calls. Idempotent, so a reconnect can call it again. */
  attach(): void {
    this.mod.__pfOnVideoConfig = (codec, width, height, depth, hdr) => {
      this.depth = depth;
      this.hdr = hdr;
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
    this.plane.setDynamicRange(this.hdr ? "high" : "standard");

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
    // No `description`: the host sends parameter sets inline with every key frame, which is what
    // lets a browser join a stream already in progress.
    decoder.configure({
      codec: codecString(codec, this.depth),
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
      ...(this.hdr ? { colorSpace: PQ_PASSTHROUGH } : {}),
    });
    this.hdrChecked = false;
    this.decoder = decoder;
  }

  // Called from inside `pf_session_pump`, which holds the session while it hands each access unit
  // over: a call back into the session from here aborts the module, so it goes on a microtask.
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
      queueMicrotask(() => this.mod._pf_gate_no_output());
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
    // An engine that ignores the override hands over light it has already converted, which no
    // shader here can undo. Said once; the engine streams SDR instead.
    if (this.hdr && !this.hdrChecked) {
      this.hdrChecked = true;
      if (frame.colorSpace.transfer !== PQ_PASSTHROUGH.transfer) {
        refuseHdr();
        this.onHdrRefused?.();
      }
    }
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

export { CODEC_AV1, CODEC_H264, CODEC_HEVC };

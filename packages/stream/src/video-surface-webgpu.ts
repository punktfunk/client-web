// The video plane on WebGPU — the same `configure` / `present` / `resize` / `setDynamicRange`
// seam as `video-surface.ts`, so choosing between them is one line in the page and nothing else
// in the client changes. That is what the seam was buying.
//
// Two things this gets that WebGL2 cannot:
//
//   * `importExternalTexture()` takes a `VideoFrame` directly and the resulting
//     `GPUExternalTexture` stays valid until the frame is closed — so the per-frame `texImage2D`
//     copy disappears. Measurement said that copy is already cheap (~0.5 ms at 4K against
//     decoder output), so this is not why we are here.
//   * `toneMapping: { mode: "extended" }` on the canvas configuration, which is the **only**
//     shipped HDR route in either engine. Chromium's WebGL2 path (`drawingBufferStorage` +
//     float16) is still behind a flag, and Safari has no WebGL2 HDR at all. This is the reason.
//     Neither engine decodes PQ for us, so `fs_pq` does.
//
// `create()` is async because adapter and device are; everything after is synchronous, so the
// per-frame path matches the WebGL2 one call for call.

import type { UploadStats, VideoPlane } from "./video-surface.ts";

const SHADER = `
struct VertexOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOut {
  // One oversized triangle; cheaper than a quad and no seam down the middle.
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VertexOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  // A VideoFrame's origin is top-left, the surface's is bottom-left.
  out.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return out;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var frame: texture_external;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(frame, samp, in.uv);
}

// HDR10. Neither engine decodes PQ when it samples a frame, so the decoder is told the picture is
// sRGB-transfer (\`video.ts\`) and the samples arrive as the PQ signal the host sent, BT.2020 R'G'B'.
// Decoded here to light with 203 nits as 1.0 — SDR white, as the host puts SDR into PQ and the
// Apple client anchors EDR — then into Display P3, encoded for an extended-range canvas. Values
// past 1.0 are highlights; an SDR canvas clips them and keeps the rest right.
fn pq_eotf(e: vec3f) -> vec3f {
  let m1 = 0.1593017578125;
  let m2 = 78.84375;
  let c1 = 0.8359375;
  let c2 = 18.8515625;
  let c3 = 18.6875;
  let p = pow(clamp(e, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / m2));
  return pow(max(p - c1, vec3f(0.0)) / (c2 - c3 * p), vec3f(1.0 / m1));
}

// BT.2020 to Display P3, both linear, D65. Column-major: these are the columns.
const BT2020_TO_P3 = mat3x3f(
  vec3f(1.343578, -0.065297, 0.002822),
  vec3f(-0.282180, 1.075788, -0.019598),
  vec3f(-0.061399, -0.010490, 1.016777));

// The sRGB curve, mirrored for the negative values a wide gamut can leave, and unclamped.
fn srgb_encode_ext(c: vec3f) -> vec3f {
  let a = abs(c);
  return sign(c) * select(1.055 * pow(a, vec3f(1.0 / 2.4)) - 0.055, a * 12.92, a <= vec3f(0.0031308));
}

@fragment
fn fs_pq(in: VertexOut) -> @location(0) vec4f {
  let pq = textureSampleBaseClampToEdge(frame, samp, in.uv).rgb;
  let light = BT2020_TO_P3 * (pq_eotf(pq) * (10000.0 / 203.0));
  return vec4f(srgb_encode_ext(light), 1.0);
}`;

export class VideoSurfaceWebGPU implements VideoPlane {
  private readonly context: GPUCanvasContext;
  /** The display's own format for SDR; float16 for HDR, whose values run past 1.0. */
  private readonly sdrFormat: GPUTextureFormat;
  private format: GPUTextureFormat;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly module: GPUShaderModule;
  private readonly sampler: GPUSampler;
  private colorSpace: VideoColorSpace | null = null;
  private width = 0;
  private height = 0;
  private frames = 0;
  private uploadMs = 0;
  private dynamicRange: "standard" | "high" = "standard";
  /** True once the engine has refused `toneMapping`, so HDR is asked for exactly once. */
  private toneMappingUnavailable = false;

  /** Adapter, device and canvas context. Rejects when the engine has no WebGPU, so a caller can
   *  fall back to the WebGL2 surface rather than showing nothing. */
  static async create(canvas: HTMLCanvasElement): Promise<VideoSurfaceWebGPU> {
    if (!navigator.gpu) throw new Error("no WebGPU in this engine");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("no WebGPU adapter");
    return new VideoSurfaceWebGPU(canvas, await adapter.requestDevice());
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
  ) {
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("no WebGPU canvas context");
    this.context = context;
    this.sdrFormat = navigator.gpu.getPreferredCanvasFormat();
    this.format = this.sdrFormat;
    this.module = device.createShaderModule({ code: SHADER });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.configureContext();
  }

  /** One pipeline per target format and signal: SDR as sampled, or PQ decoded here. */
  private pipeline(): GPURenderPipeline {
    const pq = this.dynamicRange === "high";
    const key = `${this.format}${pq ? "|pq" : ""}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module: this.module, entryPoint: "vs" },
        fragment: { module: this.module, entryPoint: pq ? "fs_pq" : "fs", targets: [{ format: this.format }] },
        primitive: { topology: "triangle-list" },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private configureContext(): void {
    this.format = this.dynamicRange === "high" && !this.toneMappingUnavailable ? "rgba16float" : this.sdrFormat;
    const config: GPUCanvasConfiguration = {
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
      // `fs_pq` writes Display P3: BT.2020 greens and reds that sRGB would clip.
      colorSpace: this.dynamicRange === "high" ? "display-p3" : "srgb",
    };
    // The HDR switch. `extended` lets values above 1.0 through to the panel; without it the
    // compositor clamps and BT.2020/PQ content is indistinguishable from SDR. Guarded because an
    // engine with WebGPU but without tone mapping must still show a picture.
    if (this.dynamicRange === "high" && !this.toneMappingUnavailable) {
      (config as { toneMapping?: { mode: string } }).toneMapping = { mode: "extended" };
    }
    try {
      this.context.configure(config);
    } catch {
      delete (config as { toneMapping?: { mode: string } }).toneMapping;
      this.format = this.sdrFormat;
      config.format = this.format;
      this.context.configure(config);
      this.toneMappingUnavailable = true;
    }
  }

  configure(width: number, height: number, colorSpace?: VideoColorSpace | null): void {
    this.colorSpace = colorSpace ?? null;
    this.resize(width, height);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** Upload-free present: the frame is bound as an external texture for this submission only.
   *  The caller still owns the frame and must `close()` it. */
  present(frame: VideoFrame): void {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (w && h) this.resize(w, h);

    const t0 = performance.now();
    const device = this.device;
    // No copy: this is the line the WebGPU plane exists for. The external texture is valid for
    // this submission, which is why the bind group is rebuilt per frame rather than cached.
    const external = device.importExternalTexture({ source: frame });
    const pipeline = this.pipeline();
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: external },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.uploadMs += performance.now() - t0;
    this.frames++;
  }

  /** SDR or HDR for this plane. Reconfigures the canvas, because tone mapping is a property of
   *  the configuration rather than of a draw. */
  setDynamicRange(mode: "standard" | "high"): void {
    if (mode === this.dynamicRange) return;
    this.dynamicRange = mode;
    this.configureContext();
    this.canvas.style.setProperty("dynamic-range-limit", mode === "high" ? "no-limit" : "standard");
  }

  takeUploadStats(): UploadStats {
    const stats = {
      frames: this.frames,
      totalMs: this.uploadMs,
      perFrameMs: this.frames ? this.uploadMs / this.frames : 0,
    };
    this.frames = 0;
    this.uploadMs = 0;
    return stats;
  }

  get colour(): VideoColorSpace | null {
    return this.colorSpace;
  }

  destroy(): void {
    this.context.unconfigure();
    this.device.destroy();
  }
}

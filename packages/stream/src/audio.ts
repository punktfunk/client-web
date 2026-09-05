// Opus frames in, sound out.
//
// The only file that knows `AudioDecoder` and `AudioWorklet` exist. Rust hands over one Opus
// frame at a time, already rebuilt and in order (`rust/audio.rs`); this decodes each with the
// browser's own decoder and feeds the PCM to a worklet that plays from a short ring on the
// audio thread. Nothing decoded ever enters wasm memory.
//
// A browser will not play sound a person did not ask for: the context starts suspended until a
// gesture, and the first pointer or key on the page resumes it. `state` says which it is, so a
// shell can show a muted badge rather than leave the user wondering.

import type { PunktfunkModule } from "./emscripten.ts";

/** Opus is 48 kHz on this wire, whatever the host captures at. */
const SAMPLE_RATE = 48_000;

export type AudioState = "playing" | "suspended" | "unsupported" | "off";

export interface AudioSnapshot {
  state: AudioState;
  /** Frames Rust handed over. */
  frames: number;
  /** Frames the wire lost and the redundant copy could not rebuild. */
  lost: number;
  /** Frames the decoder refused. */
  errors: number;
  /** Times the ring ran dry at the audio thread (silence went out). */
  underruns: number;
}

/**
 * The playback thread's side: an interleaved f32 ring the main thread appends to. `process`
 * pulls one render quantum per call; a dry ring plays silence and counts it. A ring that has
 * grown past `cap` — jitter that never drained — is cut back to `keep`, so latency cannot creep.
 *
 * A string, because the worklet is loaded by URL and the bundler must not see a second entry.
 */
const WORKLET = `
class PunktfunkSink extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.cap = options.processorOptions.cap;
    this.keep = options.processorOptions.keep;
    this.chunks = [];
    this.offset = 0;
    this.queued = 0;
    this.underruns = 0;
    this.port.onmessage = (e) => {
      const pcm = e.data;
      this.chunks.push(pcm);
      this.queued += pcm.length / this.channels;
      if (this.queued > this.cap) {
        while (this.queued > this.keep && this.chunks.length > 1) {
          const gone = this.chunks.shift();
          this.queued -= (gone.length - this.offset) / this.channels;
          this.offset = 0;
        }
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    let wrote = 0;
    while (wrote < frames && this.chunks.length) {
      const chunk = this.chunks[0];
      const avail = (chunk.length - this.offset) / this.channels;
      const n = Math.min(avail, frames - wrote);
      for (let ch = 0; ch < out.length; ch++) {
        const src = ch < this.channels ? ch : this.channels - 1;
        const o = out[ch];
        for (let i = 0; i < n; i++) o[wrote + i] = chunk[this.offset + (i * this.channels) + src];
      }
      this.offset += n * this.channels;
      this.queued -= n;
      wrote += n;
      if (this.offset >= chunk.length) { this.chunks.shift(); this.offset = 0; }
    }
    if (wrote < frames) {
      this.underruns++;
      if (this.underruns % 100 === 1) this.port.postMessage({ underruns: this.underruns });
    }
    return true;
  }
}
registerProcessor("punktfunk-sink", PunktfunkSink);
`;

export class AudioPipe {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private decoder: AudioDecoder | null = null;
  private state: AudioState = "off";
  private errors = 0;
  private underruns = 0;
  private readonly off: Array<() => void> = [];
  /** Frames that arrived before the worklet was ready. Bounded: it is a start-up gap, not a queue. */
  private early: Array<{ data: Uint8Array; ptsNs: number }> = [];

  constructor(
    private readonly mod: PunktfunkModule,
    private readonly channels: number,
  ) {}

  static supported(): boolean {
    return typeof AudioDecoder === "function" && typeof AudioWorkletNode === "function";
  }

  /** Install the callback and bring the graph up. Frames before it is ready are held briefly. */
  attach(): void {
    if (!AudioPipe.supported()) {
      this.state = "unsupported";
      return;
    }
    this.mod.__pfOnAudioFrame = (data, seq, ptsNs) => this.frame(data, seq, ptsNs);
    void this.open();
  }

  private async open(): Promise<void> {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (this.ctx !== ctx) return; // closed while loading
    const node = new AudioWorkletNode(ctx, "punktfunk-sink", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.channels],
      // 60 ms of backlog is jitter that will not drain; cut back to 20 ms.
      processorOptions: { channels: this.channels, cap: SAMPLE_RATE * 0.06, keep: SAMPLE_RATE * 0.02 },
    });
    node.port.onmessage = (e: MessageEvent<{ underruns: number }>) => {
      this.underruns = e.data.underruns;
    };
    node.connect(ctx.destination);
    this.node = node;

    const decoder = new AudioDecoder({
      output: (frame) => this.play(frame),
      error: () => {
        this.errors++;
      },
    });
    decoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: this.channels });
    this.decoder = decoder;

    this.state = ctx.state === "running" ? "playing" : "suspended";
    // Autoplay: a gesture anywhere on the page is enough, and the stream's own input is one.
    const resume = () => {
      void ctx.resume().then(() => {
        if (this.ctx === ctx) this.state = "playing";
      });
    };
    for (const type of ["pointerdown", "keydown", "touchstart"] as const) {
      window.addEventListener(type, resume, { passive: true });
      this.off.push(() => window.removeEventListener(type, resume));
    }
    resume();
    for (const f of this.early.splice(0)) this.decode(f.data, f.ptsNs);
  }

  private frame(data: Uint8Array, _seq: number, ptsNs: number): void {
    if (!this.decoder) {
      if (this.early.length < 64) this.early.push({ data, ptsNs });
      return;
    }
    this.decode(data, ptsNs);
  }

  private decode(data: Uint8Array, ptsNs: number): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return;
    try {
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: ptsNs / 1000, data }));
    } catch {
      this.errors++;
    }
  }

  /** Decoded PCM to the ring, interleaved f32 whatever the decoder's own layout was. */
  private play(frame: AudioData): void {
    try {
      const n = frame.numberOfFrames;
      const ch = frame.numberOfChannels;
      const out = new Float32Array(n * ch);
      if (frame.format === "f32") {
        frame.copyTo(out, { planeIndex: 0, format: "f32" });
      } else {
        const plane = new Float32Array(n);
        for (let c = 0; c < ch; c++) {
          frame.copyTo(plane, { planeIndex: c, format: "f32-planar" });
          for (let i = 0; i < n; i++) out[i * ch + c] = plane[i]!;
        }
      }
      this.node?.port.postMessage(out, [out.buffer]);
    } finally {
      frame.close();
    }
  }

  snapshot(): AudioSnapshot {
    if (this.ctx && this.state !== "unsupported") {
      this.state = this.ctx.state === "running" ? "playing" : "suspended";
    }
    return {
      state: this.state,
      frames: this.mod._pf_audio_frames(),
      lost: this.mod._pf_audio_lost(),
      errors: this.errors,
      underruns: this.underruns,
    };
  }

  close(): void {
    delete this.mod.__pfOnAudioFrame;
    for (const f of this.off.splice(0)) f();
    this.early.length = 0;
    try {
      this.decoder?.close();
    } catch {
      // Already closed, or never configured.
    }
    this.decoder = null;
    this.node?.disconnect();
    this.node = null;
    const ctx = this.ctx;
    this.ctx = null;
    void ctx?.close();
    this.state = "off";
  }
}

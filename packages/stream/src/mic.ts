// The microphone, up to the host: capture, Opus, `0xCB` datagrams.
//
// Off until the player turns it on, from the menu or Ctrl+Alt+Shift+V: asking for a microphone
// on the first stream would be a permission prompt nobody asked for. The browser's own echo
// cancellation keeps the host's audio, playing from the speakers, out of what goes back.
//
// Capture is an `AudioWorklet` rather than `MediaStreamTrackProcessor`, which only Chromium has;
// the worklet brings the device's rate to 48 kHz and cuts 20 ms frames, WebCodecs'
// `AudioEncoder` makes them Opus, and Rust wraps each as the uplink datagram. The host decodes
// into its virtual microphone.

import type { PunktfunkModule } from "./emscripten.ts";

const SAMPLE_RATE = 48_000;
/** 20 ms, the Opus frame the encoder makes by default and the host's pump expects. */
const FRAME = 960;

export type MicState = "off" | "starting" | "on" | "denied" | "unsupported";

/**
 * Linear resampling to 48 kHz, as source the worklet runs and a test can. `push` takes one block
 * at the context's rate and hands each 48 kHz sample to `emit`; the last sample and the
 * fractional position carry into the next block.
 */
// ponytail: linear interpolation with no low-pass, fine for voice. A windowed-sinc filter if
// music, or rates far above 48 kHz, ever go up this path.
export const RESAMPLER = `
class Resampler {
  constructor(from) {
    this.step = from / ${SAMPLE_RATE};
    this.pos = 0;
    this.prev = 0;
  }
  push(x, emit) {
    const n = x.length;
    if (!n) return;
    let p = this.pos;
    for (; p < n - 1; p += this.step) {
      const i = Math.floor(p);
      const a = i < 0 ? this.prev : x[i];
      emit(a + (x[i + 1] - a) * (p - i));
    }
    this.pos = p - n;
    this.prev = x[n - 1];
  }
}`;

const WORKLET = `${RESAMPLER}
class PunktfunkMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${FRAME});
    this.at = 0;
    this.resampler = sampleRate === ${SAMPLE_RATE} ? null : new Resampler(sampleRate);
    this.add = (v) => {
      this.buf[this.at++] = v;
      if (this.at === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(${FRAME});
        this.at = 0;
      }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.resampler) this.resampler.push(ch, this.add);
    else for (let i = 0; i < ch.length; i++) this.add(ch[i]);
    return true;
  }
}
registerProcessor("punktfunk-mic", PunktfunkMic);
`;

/** Safari's audio session, where the browser has one. */
const audioSession = (): { type: string } | undefined => (navigator as { audioSession?: { type: string } }).audioSession;

export class MicPipe {
  private _state: MicState = MicPipe.supported() ? "off" : "unsupported";
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private encoder: AudioEncoder | null = null;
  private seq = 0;
  private ts = 0;
  /** Moved by every `start` and `stop`: a `start` that finds it moved after an await was
   *  overtaken, and drops what it opened. */
  private gen = 0;

  constructor(private readonly mod: PunktfunkModule) {}

  static supported(): boolean {
    return (
      typeof AudioEncoder === "function" &&
      typeof AudioWorkletNode === "function" &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia
    );
  }

  get state(): MicState {
    return this._state;
  }

  /** Start capturing. Must follow a gesture: the permission prompt is the browser's. */
  async start(): Promise<void> {
    if (this._state === "on" || this._state === "starting" || this._state === "unsupported") return;
    const gen = ++this.gen;
    this._state = "starting";
    // Safari captures only in a session that records; `stop` gives playback back.
    const session = audioSession();
    if (session) session.type = "play-and-record";
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (gen !== this.gen) return;
      this._state = "denied";
      if (session?.type === "play-and-record") session.type = "playback";
      return;
    }
    if (gen !== this.gen) {
      // Turned off, or off and on again, while the prompt was up.
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    // The device's own rate: Firefox refuses a source whose rate differs from its context's.
    const ctx = new AudioContext();
    this.ctx = ctx;
    const drop = () => {
      for (const t of stream.getTracks()) t.stop();
      void ctx.close().catch(() => {});
    };
    // Any step below can fail on a browser short of one piece; the microphone must not stay open.
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (gen !== this.gen) return drop();
      const encoder = new AudioEncoder({
        output: (chunk) => this.send(chunk),
        error: () => this.stop(),
      });
      encoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 64_000 });
      this.encoder = encoder;
      const node = new AudioWorkletNode(ctx, "punktfunk-mic", { numberOfInputs: 1, numberOfOutputs: 1 });
      node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => this.encode(e.data);
      ctx.createMediaStreamSource(stream).connect(node);
      // A node nothing pulls from may not run; a muted gain to the output keeps it in the graph.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      await ctx.resume();
      if (gen !== this.gen) return drop();
    } catch (e) {
      console.error("punktfunk: microphone", e);
      if (gen === this.gen) this.stop();
      else drop();
      return;
    }
    this._state = "on";
  }

  stop(): void {
    this.gen++;
    const session = audioSession();
    if (session?.type === "play-and-record") session.type = "playback";
    this._state = MicPipe.supported() ? "off" : "unsupported";
    try {
      this.encoder?.close();
    } catch {
      // Already closed.
    }
    this.encoder = null;
    void this.ctx?.close();
    this.ctx = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }

  private encode(pcm: Float32Array<ArrayBuffer>): void {
    const encoder = this.encoder;
    if (!encoder || encoder.state !== "configured") return;
    const data = new AudioData({
      format: "f32",
      sampleRate: SAMPLE_RATE,
      numberOfFrames: pcm.length,
      numberOfChannels: 1,
      timestamp: this.ts,
      data: pcm,
    });
    this.ts += (pcm.length * 1_000_000) / SAMPLE_RATE;
    encoder.encode(data);
    data.close();
  }

  private send(chunk: EncodedAudioChunk): void {
    const len = chunk.byteLength;
    const p = this.mod._malloc(len);
    try {
      chunk.copyTo(this.mod.HEAPU8.subarray(p, p + len));
      this.mod._pf_mic_send?.(p, len, this.seq++, chunk.timestamp * 1000);
    } finally {
      this.mod._free(p);
    }
  }
}

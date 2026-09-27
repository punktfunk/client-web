// The microphone, up to the host: capture, Opus, `0xCB` datagrams.
//
// Off until the player turns it on, from the menu or Ctrl+Alt+Shift+V: asking for a microphone
// on the first stream would be a permission prompt nobody asked for. The browser's own echo
// cancellation keeps the host's audio, playing from the speakers, out of what goes back.
//
// Capture is an `AudioWorklet` rather than `MediaStreamTrackProcessor`, which only Chromium has;
// the worklet cuts 20 ms frames at 48 kHz, WebCodecs' `AudioEncoder` makes them Opus, and Rust
// wraps each as the uplink datagram. The host decodes into its virtual microphone.

import type { PunktfunkModule } from "./emscripten.ts";

const SAMPLE_RATE = 48_000;
/** 20 ms, the Opus frame the encoder makes by default and the host's pump expects. */
const FRAME = 960;

export type MicState = "off" | "starting" | "on" | "denied" | "unsupported";

const WORKLET = `
class PunktfunkMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${FRAME});
    this.at = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.at++] = ch[i];
      if (this.at === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(${FRAME});
        this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor("punktfunk-mic", PunktfunkMic);
`;

export class MicPipe {
  private _state: MicState = MicPipe.supported() ? "off" : "unsupported";
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private encoder: AudioEncoder | null = null;
  private seq = 0;
  private ts = 0;

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
    this._state = "starting";
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this._state = "denied";
      return;
    }
    if (this._state !== "starting") {
      // Turned off while the prompt was up.
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (this.ctx !== ctx) return;
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
    this._state = "on";
  }

  stop(): void {
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

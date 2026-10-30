// The plane over WebTransport, pinned to the plane certificate's hash. Each browser engine's
// quirk in the session is handled, and written down, here.

import type { Carrier } from "../emscripten.ts";
import { hexBytes } from "../tunnel.ts";
import type { Feed } from "./feed.ts";

export class WtCarrier implements Carrier {
  private wt: WebTransport | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private ctl: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** The connection's smoothed round trip in µs, from the last `getStats()`; 0 = unknown. */
  private rtt = 0;

  /** `url` is the plane's `https://<host>:<port>/pf2`; `certHash` its certificate's SHA-256 in hex. */
  constructor(
    private readonly feed: Feed,
    private readonly url: string,
    private readonly certHash: string,
  ) {}

  open(): Promise<void> {
    const opts: WebTransportOptions = { allowPooling: false };
    if (this.certHash.length === 64) {
      // allowPooling must stay false alongside this: the pair is a TypeError otherwise.
      opts.serverCertificateHashes = [{ algorithm: "sha-256", value: hexBytes(this.certHash) }];
    }
    let wt: WebTransport;
    try {
      wt = new WebTransport(this.url, opts);
    } catch (e) {
      console.error("punktfunk: WebTransport constructor refused", e);
      throw e;
    }
    this.wt = wt;
    // The host's close code and reason are how it says why — a setup failure, a refused
    // credential — so they go to the engine. Only while this is the open connection: a close
    // after `close()` is old news.
    wt.closed.then(
      (info) => {
        if (this.wt === wt) this.feed.closed(info.closeCode ?? 0, info.reason ?? "");
      },
      (e) => {
        // WebKit rejects here on any close by the host, with nothing attached — not even the
        // close code. `Refused` on a stream is what carries the reason in that engine.
        if (this.wt === wt) this.feed.closed(-1, (e as { message?: string }).message ?? "");
      },
    );
    return new Promise((resolve, reject) => {
      wt.ready.then(
        () => {
          if (this.wt !== wt) return;
          // WebKit follows the current spec with `createWritable()`; Chromium still exposes the
          // older `writable` attribute. A client that knows only one fails on the other engine.
          const datagrams = wt.datagrams as unknown as {
            createWritable?: () => WritableStream<Uint8Array>;
            writable: WritableStream<Uint8Array>;
            readable: ReadableStream<Uint8Array>;
          };
          const w = datagrams.createWritable ? datagrams.createWritable() : datagrams.writable;
          this.writer = w.getWriter();
          this.openControl();
          readUnis(wt.incomingUnidirectionalStreams, (bytes) => this.feed.uni(bytes));
          void each(datagrams.readable, (d) => this.feed.datagram(d));
          resolve();
        },
        (e) => {
          console.error("punktfunk: WebTransport session failed:", (e as { message?: string })?.message, e);
          // A session that never opened leaves `closed` pending in WebKit, so this is the
          // engine's only word.
          if (this.wt === wt) reject(e);
        },
      );
    });
  }

  sendDatagram(bytes: Uint8Array): boolean {
    if (!this.writer) return false;
    this.writer.write(bytes).catch(() => {});
    return true;
  }

  // The same punktfunk/2 frames the native client puts on a quinn stream. Rust owns the codec;
  // this owns the stream.
  openControl(): void {
    const wt = this.wt;
    if (!wt || this.ctl) return;
    wt.createBidirectionalStream().then(
      (stream) => {
        if (this.wt !== wt) return;
        const ctl = stream.writable.getWriter();
        this.ctl = ctl;
        // Every punktfunk/2 stream opens with its type; the control stream's is 0.
        ctl.write(new Uint8Array([0])).catch(() => {});
        void each(stream.readable, (bytes) => this.feed.control(bytes));
        // Rust sends its hello once the stream exists, not before: the host has nothing to reply on.
        this.feed.controlReady();
      },
      (e) => console.error("punktfunk: control stream refused", e),
    );
  }

  sendControl(bytes: Uint8Array): void {
    this.ctl?.write(bytes).catch(() => {});
  }

  close(code?: number): void {
    const wt = this.wt;
    this.wt = null;
    this.writer = null;
    this.ctl = null;
    this.rtt = 0;
    try {
      // A close code is how a player's choice reaches the host: `QUIT_CLOSE_CODE` ends the
      // title, a plain close leaves it running.
      wt?.close(code ? { closeCode: code, reason: "" } : undefined);
    } catch {
      // Already closed, or never opened. Either way there is nothing to do.
    }
  }

  // Each call asks for a fresh reading, which the next call returns; a browser without
  // `getStats` stays at 0.
  rttUs(): number {
    const wt = this.wt;
    const getStats = wt && (wt as unknown as { getStats?: () => Promise<{ smoothedRtt?: number }> }).getStats;
    if (wt && typeof getStats === "function") {
      getStats.call(wt).then(
        (s) => {
          if (this.wt === wt) this.rtt = Math.round((s.smoothedRtt ?? 0) * 1000);
        },
        () => {},
      );
    }
    return this.rtt;
  }
}

/** Each chunk of `stream` to `f`, as it arrives. `true` once the stream ended, `false` when the
 *  session went under the read. */
async function each<T>(stream: ReadableStream<T>, f: (chunk: T) => void): Promise<boolean> {
  const reader = stream.getReader();
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) f(r.value);
    return true;
  } catch {
    return false;
  }
}

/** Each stream the host opens, read to its end and handed to `f` whole. */
function readUnis(streams: ReadableStream<ReadableStream<Uint8Array>>, f: (bytes: Uint8Array) => void): void {
  void each(streams, (s) => {
    const got: Uint8Array[] = [];
    void each(s, (c) => got.push(c)).then((ended) => {
      if (!ended) return;
      const whole = new Uint8Array(got.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of got) {
        whole.set(c, at);
        at += c.length;
      }
      f(whole);
    });
  });
}

// The plane through the page server, over a WebSocket: the carrier where UDP does not reach the
// host. The server dials the plane over WebTransport, pinned to the hash this page verified, and
// moves bytes both ways; `frame.ts` is the whole contract between the two.

import type { Carrier } from "../emscripten.ts";
import type { Feed } from "./feed.ts";
import { decode, encode, type Frame, TAG } from "./frame.ts";

/** How often the bridge is pinged. The round trip it measures is what `rttUs` reports. */
const PING_MS = 1000;
/** `WebSocket.OPEN`. */
const OPEN = 1;

/** The page server's bridge (`w/<id>`, `wa/<ip:port>`, relative to the page, like the API routes)
 *  as a socket URL that dials the plane at `port`, pinned to `certHash`. */
export function bridgeUrl(bridge: string, port: number, certHash: string, page = location.href): string {
  const url = new URL(bridge, page);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.search = `port=${port}&hash=${certHash}`;
  return url.href;
}

export class WsCarrier implements Carrier {
  private ws: WebSocket | null = null;
  private live = false;
  private ctl = false;
  private ping: ReturnType<typeof setInterval> | undefined;
  /** The smoothed pong round trip, and the bridge's own round trip to the host, in µs. */
  private rtt = 0;
  private bridgeRtt = 0;

  constructor(
    private readonly feed: Feed,
    private readonly url: string,
  ) {}

  open(): Promise<void> {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.live = true;
        this.ping = setInterval(() => this.send({ tag: TAG.PING, sentMs: performance.now() }), PING_MS);
        this.openControl();
        resolve();
      };
      ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (this.ws === ws) this.receive(new Uint8Array(e.data));
      };
      // `error` always comes before `close` and says less, so `close` speaks for both.
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        const live = this.live;
        this.stop();
        // No tag 3 first: the host never said why, which to the engine is a lost connection.
        if (live) return this.feed.closed(-1, e.reason);
        console.error("punktfunk: bridge closed before it opened", e.code, e.reason);
        reject(new Error(`bridge closed with ${e.code} before it opened`));
      };
    });
  }

  sendDatagram(bytes: Uint8Array): boolean {
    if (!this.live) return false;
    this.send({ tag: TAG.DATAGRAM, bytes });
    return true;
  }

  // The bridge opens the host's control stream on the first tag 1, so it carries the stream-type
  // byte every punktfunk/2 stream opens with; the control stream's is 0.
  openControl(): void {
    if (!this.live || this.ctl) return;
    this.ctl = true;
    this.send({ tag: TAG.CONTROL, bytes: new Uint8Array([0]) });
    this.feed.controlReady();
  }

  sendControl(bytes: Uint8Array): void {
    if (this.ctl) this.send({ tag: TAG.CONTROL, bytes });
  }

  // Tag 3 carries the close code to the host: `QUIT_CLOSE_CODE` ends the title, 0 leaves it running.
  close(code?: number): void {
    const ws = this.ws;
    const live = this.live;
    this.stop();
    if (live) ws?.send(encode({ tag: TAG.CLOSE, code: code ?? 0, reason: "" }));
    ws?.close(1000);
  }

  rttUs(): number {
    return this.rtt ? this.rtt + this.bridgeRtt : 0;
  }

  private receive(msg: Uint8Array): void {
    const f = decode(msg);
    if (!f) return this.end(-1, "", 1002);
    switch (f.tag) {
      case TAG.DATAGRAM:
        return this.feed.datagram(f.bytes);
      case TAG.CONTROL:
        return this.feed.control(f.bytes);
      case TAG.UNI:
        return this.feed.uni(f.bytes);
      case TAG.CLOSE:
        return this.end(f.code, f.reason, 1000);
      case TAG.PING: {
        // A bare ping asks nothing of the page: the server's own WebSocket pings keep the line up.
        if (f.bridgeRttUs === undefined) return;
        const sample = Math.round((performance.now() - f.sentMs) * 1000);
        this.rtt = this.rtt ? Math.round(this.rtt + (sample - this.rtt) / 8) : sample;
        this.bridgeRtt = f.bridgeRttUs;
        return;
      }
    }
  }

  /** The session is over: say so once, and let the socket go. */
  private end(code: number, reason: string, wsCode: number): void {
    const ws = this.ws;
    this.stop();
    ws?.close(wsCode);
    this.feed.closed(code, reason);
  }

  private send(f: Frame): void {
    if (this.ws?.readyState === OPEN) this.ws.send(encode(f));
  }

  private stop(): void {
    clearInterval(this.ping);
    this.ws = null;
    this.live = false;
    this.ctl = false;
    this.rtt = 0;
    this.bridgeRtt = 0;
  }
}

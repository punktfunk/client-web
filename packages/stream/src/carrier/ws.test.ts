// The WebSocket carrier against a socket written in a few lines: what goes out framed, what
// comes in reaches the feed, and how each way a bridge can end reaches the engine.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Feed } from "./feed.ts";
import { decode, encode, type Frame, TAG } from "./frame.ts";

class FakeSocket {
  static last: FakeSocket;
  readyState = 0;
  binaryType = "blob";
  sent: Frame[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(b: Uint8Array) {
    this.sent.push(decode(b)!);
  }
  close(code: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // The other end.
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(f: Frame | Uint8Array) {
    const b = f instanceof Uint8Array ? f : encode(f);
    this.onmessage?.({ data: b.slice().buffer });
  }
  drop(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}
Object.assign(globalThis, { WebSocket: FakeSocket });
const { WsCarrier, bridgeUrl } = await import("./ws.ts");

function fakeFeed() {
  const got: string[] = [];
  const feed: Feed = {
    datagram: (b) => got.push(`datagram ${[...b]}`),
    control: (b) => got.push(`control ${[...b]}`),
    uni: (b) => got.push(`uni ${[...b]}`),
    controlReady: () => got.push("ready"),
    closed: (code, reason) => got.push(`closed ${code} ${reason}`),
  };
  return { feed, got };
}

/** A carrier whose socket has opened, the socket, and what reached the feed. */
async function opened(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { feed, got } = fakeFeed();
  const carrier = new WsCarrier(feed, "wss://page.example/w/abc?port=9778&hash=00");
  const opening = carrier.open();
  const ws = FakeSocket.last;
  ws.open();
  await opening;
  return { carrier, ws, got };
}

test("the bridge URL is the page server's own, with the plane's port and hash", () => {
  const hash = "ab".repeat(32);
  assert.equal(bridgeUrl("w/abc", 9778, hash, "https://page.example/app/"), `wss://page.example/app/w/abc?port=9778&hash=${hash}`);
  assert.equal(bridgeUrl("wa/192.168.1.21:47990", 9784, hash, "http://localhost:5173/"), `ws://localhost:5173/wa/192.168.1.21:47990?port=9784&hash=${hash}`);
});

test("an open bridge opens the control stream with its type byte first", async (t) => {
  const { carrier, ws, got } = await opened(t);
  assert.equal(ws.binaryType, "arraybuffer");
  assert.deepEqual(got, ["ready"]);
  assert.deepEqual(ws.sent[0], { tag: TAG.CONTROL, bytes: new Uint8Array([0]) });
  carrier.sendControl(new Uint8Array([7, 8]));
  assert.equal(carrier.sendDatagram(new Uint8Array([1])), true);
  assert.deepEqual(ws.sent.slice(1), [
    { tag: TAG.CONTROL, bytes: new Uint8Array([7, 8]) },
    { tag: TAG.DATAGRAM, bytes: new Uint8Array([1]) },
  ]);
});

test("what arrives reaches the feed by its tag", async (t) => {
  const { ws, got } = await opened(t);
  ws.deliver({ tag: TAG.DATAGRAM, bytes: new Uint8Array([5, 6]) });
  ws.deliver({ tag: TAG.CONTROL, bytes: new Uint8Array([1]) });
  ws.deliver({ tag: TAG.UNI, bytes: new Uint8Array([9, 9]) });
  assert.deepEqual(got.slice(1), ["datagram 5,6", "control 1", "uni 9,9"]);
});

test("the host's close code reaches the engine once, then the socket goes", async (t) => {
  const { ws, got } = await opened(t);
  ws.deliver({ tag: TAG.CLOSE, code: 0x64, reason: "unpaired" });
  ws.drop(1000, "");
  assert.deepEqual(got.slice(1), ["closed 100 unpaired"]);
  assert.equal(ws.closedWith, 1000);
});

test("a socket that drops without a close code is a lost connection", async (t) => {
  const { ws, got } = await opened(t);
  ws.drop(1011, "host connection lost");
  assert.deepEqual(got.slice(1), ["closed -1 host connection lost"]);
});

test("a message the codec refuses closes the bridge", async (t) => {
  const { ws, got } = await opened(t);
  ws.deliver(new Uint8Array([9, 1]));
  assert.equal(ws.closedWith, 1002);
  assert.deepEqual(got.slice(1), ["closed -1 "]);
});

test("the round trip is the pong's plus the bridge's own", async (t) => {
  t.mock.method(performance, "now", () => 1000);
  const { carrier, ws } = await opened(t);
  assert.equal(carrier.rttUs(), 0, "unknown before a pong");
  t.mock.timers.tick(1000);
  assert.deepEqual(ws.sent.at(-1), { tag: TAG.PING, sentMs: 1000 });
  ws.deliver({ tag: TAG.PING, sentMs: 980, bridgeRttUs: 1500 });
  assert.equal(carrier.rttUs(), 20_000 + 1500);
});

test("closing sends the code to the host before the socket closes", async (t) => {
  const { carrier, ws, got } = await opened(t);
  carrier.close(0x51);
  assert.deepEqual(ws.sent.at(-1), { tag: TAG.CLOSE, code: 0x51, reason: "" });
  assert.equal(ws.closedWith, 1000);
  ws.drop(1000, "");
  assert.deepEqual(got, ["ready"], "a closed carrier says nothing more");
  assert.equal(carrier.sendDatagram(new Uint8Array([1])), false);
});

test("a bridge that refuses the upgrade rejects the open", async () => {
  const { feed, got } = fakeFeed();
  const opening = new WsCarrier(feed, "wss://page.example/w/abc?port=9778&hash=00").open();
  FakeSocket.last.drop(1006, "");
  await assert.rejects(opening);
  assert.deepEqual(got, []);
});

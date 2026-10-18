// The tunnel against a host written in a few lines: it reads the frame the page sent and answers
// with one of its own, so what is pinned here is the framing both sides agree on and the
// `fetch` contract the SDK relies on, not WebTransport itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeRequest, readReply, tunnelOver, type TunnelSession } from "./tunnel.ts";

/** A host's reply, from what it saw of the request. */
type Answer = (req: { m: string; p: string; h: Array<[string, string]>; body: string }) =>
  | { s: number; h?: Array<[string, string]>; body?: string }
  | "close";

/** One fake session: every stream is answered by `answer`. Counts what it saw. */
function fakeSession(answer: Answer): TunnelSession & { streams: number; peak: number; closeNow(): void } {
  let open = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const session = {
    streams: 0,
    peak: 0,
    closed,
    close() {
      resolveClosed();
    },
    closeNow() {
      resolveClosed();
    },
    async createBidirectionalStream() {
      session.streams++;
      open++;
      session.peak = Math.max(session.peak, open);
      const toHost = new TransformStream<Uint8Array, Uint8Array>();
      const toPage = new TransformStream<Uint8Array, Uint8Array>();
      void (async () => {
        const chunks: Uint8Array[] = [];
        const reader = toHost.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        const len = new DataView(all.buffer).getUint32(0, false);
        const head = JSON.parse(new TextDecoder().decode(all.subarray(4, 4 + len)));
        const body = new TextDecoder().decode(all.subarray(4 + len));
        const writer = toPage.writable.getWriter();
        const reply = answer({ ...head, body });
        open--;
        if (reply === "close") {
          await writer.close();
          return;
        }
        const h = new TextEncoder().encode(JSON.stringify({ s: reply.s, h: reply.h ?? [] }));
        const out = new Uint8Array(4 + h.length);
        new DataView(out.buffer).setUint32(0, h.length, false);
        out.set(h, 4);
        await writer.write(out);
        if (reply.body) await writer.write(new TextEncoder().encode(reply.body));
        await writer.close();
      })();
      return { readable: toPage.readable, writable: toHost.writable };
    },
  };
  return session;
}

test("a GET carries its path, query and headers, and a JSON reply reads as a Response", async () => {
  const seen: Array<{ m: string; p: string; h: Array<[string, string]> }> = [];
  const session = fakeSession((req) => {
    seen.push(req);
    return { s: 200, h: [["content-type", "application/json"], ["etag", "\"x\""]], body: "{\"ok\":true}" };
  });
  const fetch = tunnelOver(async () => session);
  const res = await fetch("https://192.168.1.21:47990/api/v1/library/page?limit=50", {
    headers: { authorization: "Bearer t" },
    cache: "no-store",
  });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("etag"), "\"x\"");
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(seen[0]?.m, "GET");
  assert.equal(seen[0]?.p, "/api/v1/library/page?limit=50");
  assert.deepEqual(seen[0]?.h, [["authorization", "Bearer t"]]);
});

test("a POST carries its body and content-type, and a refusal is a Response, not a throw", async () => {
  let got = "";
  const session = fakeSession((req) => {
    got = `${req.m} ${req.p} ${req.h.find(([n]) => n === "content-type")?.[1]} ${req.body}`;
    return { s: 403, h: [["content-type", "application/json"]], body: "{\"error\":\"no\"}" };
  });
  const fetch = tunnelOver(async () => session);
  const res = await fetch("https://h:47990/api/v1/game/end", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: "{\"app_id\":\"x\"}",
  });
  assert.equal(res.status, 403);
  assert.equal(res.ok, false);
  assert.deepEqual(await res.json(), { error: "no" });
  assert.equal(got, "POST /api/v1/game/end application/json {\"app_id\":\"x\"}");
});

test("a bodyless status is a Response with no body, and a large body streams whole", async () => {
  const big = "x".repeat(300_000);
  const session = fakeSession((req) => (req.p === "/api/v1/a" ? { s: 204 } : { s: 200, body: big }));
  const fetch = tunnelOver(async () => session);
  const none = await fetch("https://h:47990/api/v1/a", { method: "POST" });
  assert.equal(none.status, 204);
  assert.equal(none.body, null);
  const art = await fetch("https://h:47990/api/v1/library/art/x");
  assert.equal((await art.text()).length, big.length);
});

test("a stream closed without a reply rejects the way fetch does", async () => {
  const session = fakeSession(() => "close");
  const fetch = tunnelOver(async () => session);
  await assert.rejects(fetch("https://h:47990/api/v1/health"), (e: unknown) => e instanceof TypeError);
});

test("a session that closes is replaced by the next call", async () => {
  let opened = 0;
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const fetch = tunnelOver(async () => {
    opened++;
    const s = fakeSession(() => ({ s: 200, body: "ok" }));
    sessions.push(s);
    return s;
  });
  await fetch("https://h:47990/api/v1/health");
  await fetch("https://h:47990/api/v1/health");
  assert.equal(opened, 1, "one session serves both");
  sessions[0]!.closeNow();
  await new Promise((r) => setTimeout(r, 0));
  await fetch("https://h:47990/api/v1/health");
  assert.equal(opened, 2, "the host closed it idle; the next call dialled again");
  assert.equal(sessions[1]!.streams, 1);
});

test("a session that cannot open rejects, and the next call tries again", async () => {
  let attempt = 0;
  const fetch = tunnelOver(async () => {
    attempt++;
    if (attempt === 1) throw new Error("WebTransportError: dial failed");
    return fakeSession(() => ({ s: 200, body: "ok" }));
  });
  await assert.rejects(fetch("https://h:47990/api/v1/health"), (e: unknown) => e instanceof TypeError);
  const res = await fetch("https://h:47990/api/v1/health");
  assert.equal(res.status, 200);
  assert.equal(attempt, 2);
});

test("at most sixteen requests are in flight at once; the rest queue", async () => {
  const session = fakeSession(() => ({ s: 200, body: "ok" }));
  const fetch = tunnelOver(async () => session);
  const all = Array.from({ length: 40 }, (_, i) => fetch(`https://h:47990/api/v1/library/art/${i}`));
  const statuses = await Promise.all(all.map((p) => p.then((r) => r.status)));
  assert.ok(statuses.every((s) => s === 200));
  assert.equal(session.streams, 40);
  assert.ok(session.peak <= 16, `peak ${session.peak}`);
});

test("the frame is length, JSON head, body", () => {
  const frame = encodeRequest({ method: "POST", path: "/api/v1/x", headers: [["a", "b"]], body: new TextEncoder().encode("hi") });
  const len = new DataView(frame.buffer).getUint32(0, false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + len))), { m: "POST", p: "/api/v1/x", h: [["a", "b"]] });
  assert.equal(new TextDecoder().decode(frame.subarray(4 + len)), "hi");
});

test("a reply split across chunks is read whole", async () => {
  const head = new TextEncoder().encode(JSON.stringify({ s: 200, h: [["content-type", "text/plain"]] }));
  const frame = new Uint8Array(4 + head.length + 5);
  new DataView(frame.buffer).setUint32(0, head.length, false);
  frame.set(head, 4);
  frame.set(new TextEncoder().encode("hello"), 4 + head.length);
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < frame.length; i += 3) c.enqueue(frame.subarray(i, i + 3));
      c.close();
    },
  });
  const res = await readReply(readable);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello");
});

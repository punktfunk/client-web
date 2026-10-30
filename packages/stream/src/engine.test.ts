// The request-for-access half of the engine's state machine, against a stand-in wasm module:
// what the page shows while the host holds the request, and what each way it ends leaves.
//
// The engine uses constructor parameter properties, so `npm test` runs node with
// `--experimental-transform-types` rather than plain type stripping.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

// The engine schedules its frame loop on construction; nothing here runs it.
globalThis.requestAnimationFrame = () => 0;

/** Every carrier dialled, in order: a WebTransport URL, or `ws <url>` for the bridge. */
const dialled: string[] = [];
/** What the next WebTransport does: never answer, refuse to be made, or fail before it opens. */
let transport: "silent" | "refuse" | "fail" = "silent";
class FakeTransport {
  ready = transport === "fail" ? Promise.reject(new Error("handshake failed")) : new Promise<never>(() => {});
  closed = new Promise<never>(() => {});
  constructor(url: string) {
    if (transport === "refuse") throw new TypeError("refused");
    dialled.push(url);
  }
  close() {}
}
/** The page server's bridge, opened or dropped by hand. */
const sockets: FakeSocket[] = [];
class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(url: string) {
    dialled.push(`ws ${url}`);
    sockets.push(this);
  }
  send() {}
  close() {}
}
Object.assign(globalThis, { WebTransport: FakeTransport, WebSocket: FakeSocket, location: { href: "https://page.example/" } });
const flush = () => new Promise((r) => setImmediate(r));
const { Engine } = await import("./engine.ts");

const ORIGIN = "https://192.168.1.21:47990";
const DENIED = 0x64;

/** An engine sitting in `kind` for `origin`, and the wasm exports it has called since. With
 *  `bridge`, the target offers the page server's WebSocket route. */
function engineIn(kind: "needs-pairing" | "ready", bridge?: string, origin = ORIGIN) {
  const calls: string[] = [];
  const base: Record<string, unknown> = {
    HEAPU8: new Uint8Array(0),
    stringToNewUTF8: () => 0,
    _free: () => {},
  };
  const mod = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (typeof key === "string" && key.startsWith("_pf_")) {
        return () => {
          calls.push(key);
          return 1;
        };
      }
      return undefined;
    },
  });
  // The constructor is private: `create()` loads the real module, which this test replaces.
  const Ctor = Engine as unknown as new (mod: unknown, opts: unknown) => import("./engine.ts").Engine;
  const engine = new Ctor(mod, { videoCanvas: {}, deviceName: "Safari on Mac" });
  Object.assign(engine, {
    origin,
    ...(bridge ? { target: { api: origin, plane: "192.168.1.21", bridge } } : {}),
    planeHost: "192.168.1.21",
    plane: { port: 9778, cert_hash_sha256: "00".repeat(32) },
    // What `connect` binds the credential to.
    boundHash: "00".repeat(32),
  });
  (engine as unknown as { set(s: unknown): void }).set({ kind, origin });
  return { engine, mod: base, calls };
}

const refuse = (mod: Record<string, unknown>, code: number, reason: string) =>
  (mod.__pfOnRefused as (code: number, reason: string) => void)(code, reason);
const close = (mod: Record<string, unknown>, code: number) =>
  (mod.__pfOnClosed as (code: number, reason: string) => void)(code, "");

test("a denied request says why, and does not read as a forgotten pairing", () => {
  const { engine, mod, calls } = engineIn("needs-pairing");
  engine.requestAccess({ width: 1280, height: 720 });
  assert.deepEqual(engine.current, { kind: "awaiting-approval", origin: ORIGIN, name: "Safari on Mac" });
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/pf2", "asking dials the plane");

  refuse(mod, DENIED, "the request was denied on the host");
  assert.deepEqual(engine.current, {
    kind: "pair-refused",
    origin: ORIGIN,
    reason: "the request was denied on the host",
  });
  // The session stays `Offered` after a refusal unless reset, and five seconds of that reads as
  // "this host forgot you" — the wrong sentence for a request someone said no to.
  assert.ok(calls.includes("_pf_session_reset"));
  close(mod, DENIED);
  assert.equal(engine.current.kind, "pair-refused", "the transport's own close changes nothing");
});

test("a cancelled request goes back to pairing, and its close is not an error", () => {
  const { engine, mod, calls } = engineIn("needs-pairing");
  engine.requestAccess({ width: 1280, height: 720 });
  engine.cancelRequest();
  assert.deepEqual(engine.current, { kind: "needs-pairing", origin: ORIGIN });
  assert.ok(calls.includes("_pf_wt_close"));
  close(mod, -1);
  assert.deepEqual(engine.current, { kind: "needs-pairing", origin: ORIGIN });
});

test("a door's redirect dials the seat's plane once, with the credential bound to it", () => {
  const { engine, mod, calls } = engineIn("ready");
  const bound: string[] = [];
  mod.stringToNewUTF8 = (s: string) => {
    bound.push(s);
    return 0;
  };
  engine.startStream({ width: 1280, height: 720 });
  assert.ok(dialled.includes("https://192.168.1.21:9778/pf2"), "the door first");

  const seat = "ab".repeat(32);
  const redirect = mod.__pfOnRedirect as (port: number, certHash: string) => void;
  const before = calls.length;
  redirect(9784, seat);
  assert.ok(calls.slice(before).includes("_pf_wt_close"), "the door's connection is closed first");
  assert.ok(calls.includes("_pf_device_init"), "the credential binds to the seat's plane");
  assert.ok(bound.includes(seat));
  (mod.__pfOnDeviceReady as () => void)();
  assert.ok(dialled.includes("https://192.168.1.21:9784/pf2"), "then the seat's own port");

  redirect(9785, seat);
  assert.equal(engine.current.kind, "error", "a second redirect ends the connect");
});

test("a connect left before its host answers says nothing afterwards", async () => {
  const { engine } = engineIn("ready");
  let answer = (_: Response) => {};
  const fetched = globalThis.fetch;
  globalThis.fetch = () => new Promise<Response>((resolve) => (answer = resolve));
  try {
    const connecting = engine.connect("https://192.168.1.30:47990");
    assert.equal(engine.current.kind, "reaching");
    engine.disconnect();
    answer(new Response(null, { status: 504 }));
    await connecting;
    assert.deepEqual(engine.current, { kind: "idle" }, "Cancel stays cancelled");
  } finally {
    globalThis.fetch = fetched;
  }
});

test("a session the page can't read ends as a version mismatch, not a hang", () => {
  const { engine, mod, calls } = engineIn("ready");
  engine.startStream({ width: 1280, height: 720 });
  mod._pf_session_phase = () => 3;
  (engine as unknown as { updateSession(): void }).updateSession();
  assert.equal(engine.current.kind, "error");
  assert.equal((engine.current as { skew?: boolean }).skew, true);
  assert.ok(calls.includes("_pf_session_reset") && calls.includes("_pf_wt_close"));
});

test("an approval whose seat isn't up ends paired, not refused", async () => {
  const { engine, mod } = engineIn("needs-pairing");
  engine.requestAccess({ width: 1280, height: 720 });
  refuse(mod, 0x6f, "that profile's seat isn't available on this host");
  close(mod, 0x6f);
  assert.deepEqual(engine.current, { kind: "paired", origin: ORIGIN }, "the transport's close changes nothing");
});

const HASH = "00".repeat(32);
const BRIDGED = `ws wss://page.example/w/abc?port=9778&hash=${HASH}`;
const dial = (engine: object) => (engine as { dial(): void }).dial();

test("a WebTransport the browser refuses gives way to the bridge", (t: TestContext) => {
  t.after(() => (transport = "silent"));
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/refuse");
  transport = "refuse";
  engine.startStream({ width: 1280, height: 720 });
  assert.equal(dialled.at(-1), BRIDGED);
  assert.equal(engine.current.kind, "starting");
});

test("a WebTransport that fails before it opens gives way to the bridge", async (t: TestContext) => {
  t.after(() => (transport = "silent"));
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/fail");
  transport = "fail";
  engine.startStream({ width: 1280, height: 720 });
  await flush();
  assert.equal(dialled.at(-1), BRIDGED);
  assert.equal(engine.current.kind, "starting", "no error on the way");
});

test("a silent WebTransport gives way after three seconds, and only with a bridge", (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/silent");
  engine.startStream({ width: 1280, height: 720 });
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/pf2");
  t.mock.timers.tick(2999);
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/pf2");
  t.mock.timers.tick(1);
  assert.equal(dialled.at(-1), BRIDGED);

  const direct = engineIn("ready", undefined, "https://192.168.1.40:47990");
  direct.engine.startStream({ width: 1280, height: 720 });
  t.mock.timers.tick(10_000);
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/pf2", "no bridge, no fallback");
});

test("the bridge is remembered for the origin, and forgotten when it fails", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { engine } = engineIn("needs-pairing", "w/abc", "https://page.example/h/hint");
  engine.pair("1234");
  t.mock.timers.tick(3000);
  sockets.at(-1)!.readyState = 1;
  sockets.at(-1)!.onopen!();
  await flush();
  assert.equal(engine.current.kind, "pairing", "the PIN went over the bridge");

  const before = dialled.length;
  dial(engine);
  assert.deepEqual(dialled.slice(before), [BRIDGED], "the reconnect skips WebTransport");

  sockets.at(-1)!.onclose!({ code: 1006, reason: "" });
  await flush();
  dial(engine);
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/pf2", "WebTransport first again");
});

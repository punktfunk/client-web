// The request-for-access half of the engine's state machine, against a stand-in wasm module:
// what the page shows while the host holds the request, and what each way it ends leaves.
//
// The engine uses constructor parameter properties, so `npm test` runs node with
// `--experimental-transform-types` rather than plain type stripping.

import { test } from "node:test";
import assert from "node:assert/strict";

// The engine schedules its frame loop on construction; nothing here runs it.
globalThis.requestAnimationFrame = () => 0;
const { Engine } = await import("./engine.ts");

const ORIGIN = "https://192.168.1.21:47990";
const DENIED = 0x64;

/** An engine sitting in `kind` for `ORIGIN`, and the wasm exports it has called since. */
function engineIn(kind: "needs-pairing") {
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
    origin: ORIGIN,
    planeHost: "192.168.1.21",
    plane: { port: 9778, cert_hash_sha256: "00".repeat(32) },
  });
  (engine as unknown as { set(s: unknown): void }).set({ kind, origin: ORIGIN });
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
  assert.ok(calls.includes("_pf_wt_connect"), "asking dials the plane");

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

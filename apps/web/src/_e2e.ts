// End-to-end harness against a real host, on the engine alone (no shell).
//
//   PF_HOST=https://<host>:47990 npx vite      # the dev proxy answers /api on this origin
//   open http://127.0.0.1:5173/_e2e.html?pin=<PIN>&seconds=10
//
// Pairs when a PIN is given (forgetting what the browser knew of the host first), reconnects,
// streams for `seconds`, and prints every state it passed through. Lines also go to `/report`,
// which the dev proxy forwards to a collector on 127.0.0.1:8099 when one is listening.
import { Engine, type EngineState } from "@punktfunk/stream";

declare const __PF_TRANSPORT_HOST__: string | undefined;

const lines: string[] = [];
const out = document.getElementById("o")!;
const log = (m: string) => {
  lines.push(m);
  out.textContent += m + "\n";
};
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { lines.push(k + ": " + a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")); orig(...a); };
}
const report = () => fetch("/report", { method: "POST", body: JSON.stringify({ lines }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let rafTicks = 0;
const tick = () => { rafTicks++; requestAnimationFrame(tick); };
requestAnimationFrame(tick);
const q = new URLSearchParams(location.search);
const PIN = q.get("pin") ?? "";
const SECONDS = Number(q.get("seconds") ?? "8");

try {
  const engine = await Engine.create({
    videoCanvas: document.getElementById("v") as HTMLCanvasElement,
    ...(__PF_TRANSPORT_HOST__ ? { transportHost: __PF_TRANSPORT_HOST__ } : {}),
    deviceName: "e2e",
  });
  let latest: EngineState = engine.current;
  const last = () => latest;
  let streamingSince = 0;
  let final: any = null;
  engine.onState((s) => {
    latest = s;
    if (s.kind === "streaming") {
      if (!streamingSince) streamingSince = performance.now();
      final = s.stats;
      return;
    }
    log("state " + s.kind + ("message" in s ? ": " + s.message : "") + ("reason" in s ? ": " + s.reason : ""));
  });

  // A PIN means a fresh pairing: whatever this browser remembers of the host is stale.
  if (PIN) engine.forget(location.origin);
  await engine.connect(location.origin);
  const until = async (kinds: string[], ms: number) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (kinds.includes(last().kind)) return true;
      await sleep(50);
    }
    return false;
  };

  if (!(await until(["needs-pairing", "ready", "forgotten", "error", "unreachable", "blocked", "untrusted"], 15000))) {
    log("FAIL stuck in " + last().kind);
  }
  const raw = () => { const m = (engine as any).mod; return `cred=${m._pf_cred_phase()} session=${m._pf_session_phase()} raf=${rafTicks} vis=${document.visibilityState}`; };
  if (last().kind === "needs-pairing" || last().kind === "forgotten") {
    if (!PIN) log("FAIL needs pairing and no pin given");
    else {
      engine.pair(PIN);
      for (let i = 0; i < 30 && !["paired", "pair-refused", "error"].includes(last().kind); i++) { await sleep(500); if (i % 4 === 0) log("  " + raw()); }
      log(last().kind === "paired" ? "ok   paired" : "FAIL " + last().kind + " " + raw());
      // The host closes after the ceremony; dial again to stream.
      await sleep(500);
      await engine.connect(location.origin);
      await until(["ready", "error", "forgotten"], 15000);
    }
  }
  if (last().kind === "ready") {
    const l = last();
    if (l.kind !== "ready") throw new Error("unreachable");
    const info = await l.host.info();
    log("ok   ready; host " + info.hostname);
    engine.startStream({ width: 1280, height: 720, fps: 60, bitrateKbps: 8000 });
    const t0 = performance.now();
    let poked = false;
    while (performance.now() - t0 < SECONDS * 1000) {
      await sleep(250);
      if (last().kind === "error" || last().kind === "idle" || last().kind === "forgotten") break;
      // Two seconds in: synthetic input, which the host counts at the end of the session.
      if (!poked && last().kind === "streaming" && performance.now() - t0 > 2000) {
        poked = true;
        const c = document.getElementById("v") as HTMLCanvasElement;
        for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "Space"]) {
          window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
        }
        const r = c.getBoundingClientRect();
        for (let i = 1; i <= 10; i++) {
          c.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + i * 20, clientY: r.top + i * 10, pointerType: "mouse", bubbles: true }));
        }
        c.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 100, clientY: r.top + 50, button: 0, pointerType: "mouse", bubbles: true }));
        c.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left + 100, clientY: r.top + 50, button: 0, pointerType: "mouse", bubbles: true }));
        c.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true }));
        c.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, deltaMode: 0, bubbles: true, cancelable: true }));
        log("ok   sent 10 key, 10 move, 1 click, 2 wheel events (expect host input>=26)");
      }
    }
    if (final) {
      log(`ok   streamed: ${final.width}x${final.height} au=${final.accessUnits} decoded=${final.decoded} dropped=${final.dropped} fps=${final.fps} backend=${final.backend}`);
      log(final.decoded > 30 ? "ok   frames flowed through the real pipeline" : "FAIL too few frames decoded");
    } else {
      log("FAIL never reached streaming; last " + last().kind);
    }
    engine.disconnect();
  } else {
    log("FAIL not ready: " + last().kind);
  }
} catch (e: any) {
  log("THREW " + e?.name + ": " + e?.message + "\n" + e?.stack);
}
await report();

// The shortcuts contract. `shortcut-vectors.json` is punktfunk's `clients/shared/shortcut-vectors.json`
// at c86b0c9e90fc9c11bd3405e37953551aede24067, copied verbatim; the Rust, Swift and Kotlin twins
// replay the same file. A case that fails here is reported there, never edited here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buttonBit, type Client, defaults, Engine, keyVk, type Out, resolve, Shortcuts } from "./shortcuts.ts";

type Case = Record<string, any>;
const VECTORS = JSON.parse(readFileSync(new URL("./shortcut-vectors.json", import.meta.url), "utf8")) as Record<string, { cases: Case[] }>;
const blob = (bindings: unknown) => JSON.stringify({ v: 1, bindings });
/** Every case run, by section: the vectors' own counts. */
const ran: Record<string, number> = {};
const each = (section: string, f: (c: Case) => void) => {
  for (const c of VECTORS[section]!.cases) {
    f(c);
    ran[section] = (ran[section] ?? 0) + 1;
  }
};

test("parse vectors", () => {
  each("parse", (c) => {
    assert.deepEqual(JSON.parse(JSON.stringify(Shortcuts.parse(c.blob))), c.expect, c.name);
    assert.equal(Shortcuts.read(c.blob) === undefined, c.defaults === true, `${c.name}: defaults`);
  });
});

test("defaults vectors", () => {
  each("defaults", (c) => {
    const d = defaults(c.client as Client, c.game_mode, c.guide_gesture);
    assert.deepEqual(d.toJSON().bindings, c.expect, `${c.client} ${c.game_mode} ${c.guide_gesture}`);
    assert.deepEqual(resolve("", c.client as Client, c.game_mode, c.guide_gesture), d);
  });
});

test("validate vectors", () => {
  each("validate", (c) => {
    const have = Shortcuts.parse(blob(c.bindings));
    assert.equal(have.bindings.length, (c.bindings as unknown[]).length, c.name);
    const candidate = Shortcuts.parse(blob([c.candidate])).bindings[0];
    assert.ok(candidate, `${c.name}: the candidate parses`);
    const want = c.expect === "ok" ? null : c.index === undefined ? { kind: c.expect } : { kind: c.expect, index: c.index };
    assert.deepEqual(have.validate(candidate), want, c.name);
  });
});

test("engine vectors", () => {
  each("engine", (c) => {
    const device = c.device as "pad" | "key";
    const id = (n: string) => {
      const v = device === "pad" ? buttonBit(n) : keyVk(n);
      assert.ok(v !== undefined, `${c.name}: a name: ${n}`);
      return v;
    };
    const bindings = Shortcuts.parse(blob(c.bindings)).bindings;
    assert.equal(bindings.length, (c.bindings as unknown[]).length, c.name);
    const engine = new Engine(bindings, device);
    // [t, order, event]: events before the tick at one t, flush last.
    type Step = [t: number, order: number, ev?: { bit: string; down: boolean }];
    const timeline: Step[] = [
      ...(c.events as Array<{ t: number; bit: string; down: boolean }>).map((e): Step => [e.t, 0, e]),
      ...(c.ticks as number[]).map((t): Step => [t, 1]),
      ...(typeof c.flush === "number" ? [[c.flush, 2] as Step] : []),
    ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const got: Array<{ t: number; out: Out }> = [];
    for (const [t, order, ev] of timeline) {
      const outs = order === 0 ? engine.step(id(ev!.bit), ev!.down, t) : order === 1 ? engine.tick(t) : engine.flush();
      got.push(...outs.map((out) => ({ t, out })));
    }
    const want = (c.expect as Array<{ t: number; out: Record<string, unknown[]> }>).map(({ t, out }) => {
      const o: Out = out.forward
        ? { forward: [id(out.forward[0] as string), out.forward[1] as boolean] }
        : out.fire
          ? { fire: out.fire as [string, "once"] }
          : { lift: (out.lift as string[]).map(id) };
      return { t, out: o };
    });
    assert.deepEqual(got, want, c.name);
  });
});

test("every case ran: parse 15, defaults 14, validate 15, engine 32", () => {
  assert.deepEqual(ran, { parse: 15, defaults: 14, validate: 15, engine: 32 });
});

test("the browser lists its own rows, two presses of one action on one row", () => {
  const web = defaults("web", false, "").rows("web");
  assert.deepEqual(web.map((g) => g.kind), ["keyboard", "pad"]);
  const keys = web[0]!.items;
  assert.deepEqual(keys.at(-2)!.press, { keys: "F11", or: "Alt+Enter" });
  assert.deepEqual(keys.at(-1), { press: { keys: "Esc" }, text: "controls_release_mouse_page" });
  assert.deepEqual(
    web[1]!.items.map((r) => r.press),
    [{ keys: "Select + A" }, { keys: "L1 + R1 + Start + Select" }, { keys: "L1 + R1 + Start + Select", hold: true }],
  );
  const tizen = defaults("tizen", false, "").rows("tizen");
  assert.deepEqual(tizen[0], { kind: "remote", items: [{ press: { keys: "Back" }, text: "controls_open_menu" }] });
  assert.ok(!tizen[1]!.items.some((r) => r.text), "Esc reaches the host on a TV");
});

test("a hint names the live trigger", () => {
  const d = defaults("web", false, "");
  assert.deepEqual(d.hint("end_stream", "pad"), { keys: "L1 + R1 + Start + Select", hold: true });
  assert.deepEqual(d.hint("end_stream", "key"), { keys: "Ctrl+Alt+Shift+D", hold: false });
  assert.equal(Shortcuts.parse(blob([])).hint("end_stream", "pad"), undefined);
});

test("every default row can be edited in place, and every blob round-trips", () => {
  for (const client of ["desktop", "android", "apple", "mac", "webos", "web", "tizen", "ps5", "switch"] as const) {
    const d = defaults(client, true, "on");
    d.bindings.forEach((b, i) => {
      assert.equal(new Shortcuts(d.bindings.filter((_, j) => j !== i)).validate(b), null, `${client} row ${i}`);
    });
    assert.deepEqual(Shortcuts.parse(JSON.stringify(d)), d, client);
  }
});

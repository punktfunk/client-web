// What the settings store keeps: Automatic survives the clamp, and only a real choice is stored,
// so a default that changes later still reaches everyone who never picked otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as Storage;
const { DEFAULTS, settings } = await import("./settings.ts");
const stored = () => JSON.parse(store.get("pf.settings") ?? "{}") as Record<string, unknown>;

test("bitrate is Automatic unless someone picks a rate", () => {
  store.clear();
  assert.equal(DEFAULTS.bitrateKbps, 0);
  assert.equal(settings.get().bitrateKbps, 0);
  assert.equal(settings.set({ fps: 120 }).bitrateKbps, 0);
  assert.deepEqual(stored(), { fps: 120 }, "a default is not stored as though it were chosen");

  assert.equal(settings.set({ bitrateKbps: 30_000 }).bitrateKbps, 30_000);
  assert.equal(settings.set({ bitrateKbps: 100 }).bitrateKbps, 500, "a fixed rate is clamped");
  assert.equal(settings.set({ bitrateKbps: -1 }).bitrateKbps, 0, "anything not positive is Automatic");
  assert.deepEqual(stored(), { fps: 120 });
});

test("a rate stored before Automatic existed is kept, not second-guessed", () => {
  store.clear();
  store.set("pf.settings", JSON.stringify({ ...DEFAULTS, bitrateKbps: 20_000 }));
  assert.equal(settings.get().bitrateKbps, 20_000);
});

test("the overlay's corner and size keep to the values every client stores", () => {
  store.clear();
  assert.equal(settings.get().hudPlacement, "topTrailing");
  assert.equal(settings.set({ hudPlacement: "bottomLeading" }).hudPlacement, "bottomLeading");
  assert.equal(settings.set({ hudPlacement: "middle" as never }).hudPlacement, "topTrailing", "an unknown corner reads as the default");
  assert.equal(settings.set({ statsScalePct: 150 }).statsScalePct, 150);
  assert.equal(settings.set({ statsScalePct: 140 }).statsScalePct, 100, "a size off the list reads as 100 %");
  assert.equal(settings.get().exitHint, true);
  assert.equal(settings.get().showAdvanced, false);
});

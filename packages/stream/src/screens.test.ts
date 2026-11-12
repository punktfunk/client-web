// The Screen section. `screen-rows-vectors.json` is punktfunk's `clients/shared/screen-rows-vectors.json`
// at 28c3121022d22a4b1780e7ba00acc1a1ed9c03d4, copied verbatim; the Rust, Swift and Kotlin twins
// replay the same file. This page has no presets, so only `cases` runs here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { screenNote, screenRows, type ScreenTargets } from "./screens.ts";
import { english, useEnglish } from "./words.testing.ts";

useEnglish();

type Text = null | string | { key: string; args?: Record<string, string> };
interface Case {
  name: string;
  targets: ScreenTargets;
  rows: Array<Record<string, unknown> & { label: Text; hint: Text; header: Text; reason: Text; put: unknown }>;
  note: Text;
}
const { cases } = JSON.parse(readFileSync(new URL("./screen-rows-vectors.json", import.meta.url), "utf8")) as { cases: Case[] };

/** A vector's text slot as this page shows it: a host string as sent, a message in English. */
const text = (t: Text): string | undefined => {
  if (t === null) return undefined;
  if (typeof t === "string") return t;
  const said = english(t.key, t.args ?? {});
  assert.ok(said !== undefined, `no English message ${t.key}`);
  return said;
};

test("every shared case", () => {
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const got = screenRows(c.targets).map((r) => ({
      kind: r.kind,
      id: r.id,
      label: r.label,
      hint: r.hint,
      detail: r.detail,
      header: r.header,
      checked: r.checked,
      pickable: r.pickable,
      reason: r.reason,
      put: r.pick ?? null,
    }));
    const want = c.rows.map((r) => ({
      kind: r["kind"],
      id: r["id"],
      label: text(r.label),
      hint: text(r.hint),
      detail: r["detail"],
      header: text(r.header),
      checked: r["checked"],
      pickable: r["pickable"],
      reason: text(r.reason),
      put: r.put,
    }));
    assert.deepEqual(got, want, c.name);
    assert.equal(screenNote(c.targets), text(c.note), c.name);
  }
});

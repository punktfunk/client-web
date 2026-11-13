// `profile-unlock-vectors.json` is punktfunk's `clients/shared/profile-unlock-vectors.json` at
// 7ff5eeeedcd8c3fad7be45ab57ca7023dced9259, copied verbatim. The client's rules replay here:
// `unlock_words`, `gate`, `after_refusal`, `pins`. `messages`, `refused` and
// `challenge_answers` pin what an unlock key signs, and this page holds no key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterRefusal, passwordProblem, pinDigits, unlockForm, unlockGate, unlockNeed, type UnlockNeed } from "./unlock.ts";

interface Vectors {
  unlock_words: { word: string | null; need: UnlockNeed; form: string | null }[];
  gate: { need: UnlockNeed; holds_key: boolean; gate: string; delete_key: boolean }[];
  after_refusal: { need: UnlockNeed; holds_key: boolean; sent: boolean; gate: string }[];
  pins: { typed: string; sent?: string; error?: string }[];
}
const vectors = JSON.parse(readFileSync(new URL("./profile-unlock-vectors.json", import.meta.url), "utf8")) as Vectors;

test("an unlock word reads as its need and the prompt's form", () => {
  assert.ok(vectors.unlock_words.length > 0);
  for (const c of vectors.unlock_words) {
    const need = unlockNeed(c.word ?? undefined);
    assert.equal(need, c.need, `word ${c.word}`);
    assert.equal(unlockForm(need), c.form, `form of ${c.word}`);
  }
  assert.equal(unlockNeed(null), "none");
});

test("the gate before a dial follows the shared vectors", () => {
  assert.ok(vectors.gate.length > 0);
  for (const c of vectors.gate) {
    assert.deepEqual(unlockGate(c.need, c.holds_key), { gate: c.gate, deleteKey: c.delete_key }, JSON.stringify(c));
  }
  // This page holds no key: every need but none prompts.
  for (const need of ["password", "key", "pin", "pin_key"] as const) assert.equal(unlockGate(need).gate, "prompt");
});

test("a refusal reopens the prompt, never a dial", () => {
  assert.ok(vectors.after_refusal.length > 0);
  for (const c of vectors.after_refusal) {
    assert.equal(afterRefusal(c.need, c.holds_key, c.sent), c.gate, JSON.stringify(c));
  }
});

test("a PIN is 4 to 8 digits, full-width ones included", () => {
  assert.ok(vectors.pins.length > 0);
  for (const c of vectors.pins) {
    const want = c.sent !== undefined ? { sent: c.sent } : { error: c.error };
    assert.deepEqual(pinDigits(c.typed), want, JSON.stringify(c.typed));
  }
});

test("a password the wire refuses says why", () => {
  assert.equal(passwordProblem(""), "empty");
  assert.equal(passwordProblem(" hunter2 "), null, "never trimmed");
  assert.equal(passwordProblem("a".repeat(512)), null);
  assert.equal(passwordProblem("a".repeat(513)), "too_long");
  assert.equal(passwordProblem("é".repeat(257)), "too_long", "counted in UTF-8 bytes");
  assert.equal(passwordProblem("a\0b"), "bad_char");
  assert.equal(passwordProblem("a\ud800b"), "bad_char");
});

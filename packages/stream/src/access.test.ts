// The access words, pinned to what `pf-client-core`'s own tests pin for the native clients.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chipText, formatRemaining, presetLabel, updateNotice } from "./access.ts";

test("labels derive from the mask", () => {
  assert.equal(presetLabel(0x7f), "Full control");
  assert.equal(presetLabel(0x3f), "Full control", "full as stored before the power grant");
  assert.equal(presetLabel(0x7f | (1 << 20)), "Full control", "a newer host's extra bits");
  assert.equal(presetLabel(0x01), "Controller only");
  assert.equal(presetLabel(0), "View only");
  assert.equal(presetLabel(0x01 | 0x08), "Custom");
});

test("a full permanent session wears no chip", () => {
  assert.equal(chipText(0x7f, null), undefined);
  assert.equal(chipText(0x01, null), "Controller only");
  assert.equal(chipText(0x7f, 2 * 3600 - 120), "Full control · ends in 1 h 58 m");
});

test("remaining time is whole minutes", () => {
  assert.equal(formatRemaining(59), "under 1 m");
  assert.equal(formatRemaining(5 * 60), "5 m");
  assert.equal(formatRemaining(3600), "1 h");
  assert.equal(formatRemaining(3600 + 120), "1 h 2 m");
});

test("a change names the new level, a warning the time left", () => {
  assert.equal(updateNotice(0x7f, 0x01, null), "Access is now Controller only");
  assert.equal(updateNotice(0x7f, 0x7f, 5 * 60), "Access ends in 5 m");
  assert.equal(updateNotice(0x7f, 0x7f, null), undefined);
});

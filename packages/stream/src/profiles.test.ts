// The twin of `pf_client_core::profiles`: the same cases its own tests pin, so a browser picks,
// wakes and waits the way every native client does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { initials, pickOf, pickerDecision, profileNote, seatGate, type ProfileRow } from "./profiles.ts";

const row = (id: string, display_name: string, more: Partial<ProfileRow> = {}): ProfileRow => ({ id, display_name, ...more });
const MIA = row("a1", "Mia");
const KID = row("b2", "Kid", { seat: { state: "stopped" } });

test("a box without profiles sends none, or the link's", () => {
  assert.deepEqual(pickerDecision(null, null), { picker: false, remember: null });
  assert.deepEqual(pickerDecision(null, null, "Kid"), { picker: false, send: "Kid", remember: null });
});

test("a pick carries the picture only when there is one", () => {
  assert.equal(pickOf(row("a1", "Mia", { avatar: "/api/v1/profiles/a1/avatar?v=1" })).avatar, "/api/v1/profiles/a1/avatar?v=1");
  assert.equal("avatar" in pickOf(row("a1", "Mia", { avatar: null })), false);
});

test("one profile plays without asking; a saved one still listed plays", () => {
  assert.deepEqual(pickerDecision([MIA], null), { picker: false, send: "a1", remember: null });
  const saved = { id: "b2", display_name: "Kiddo", remember: true };
  assert.deepEqual(pickerDecision([MIA, KID], saved), {
    picker: false,
    send: "b2",
    remember: { id: "b2", display_name: "Kid", remember: true },
  });
});

test("a link wins by id or name, and asks when it names nobody", () => {
  assert.equal(pickerDecision([MIA, KID], null, "kid").send, "b2");
  assert.equal(pickerDecision([MIA, KID], null, "a1").send, "a1");
  assert.deepEqual(pickerDecision([MIA, KID], null, "Ghost"), { picker: true, remember: null });
});

test("a device's old seat plays as its profile; otherwise the picker asks, naming a gone pick", () => {
  const legacy = row("c3", "Desk", { legacy_seat: true });
  assert.deepEqual(pickerDecision([MIA, legacy], null), {
    picker: false,
    send: "c3",
    remember: { id: "c3", display_name: "Desk" },
  });
  assert.deepEqual(pickerDecision([MIA, KID], { id: "zz", display_name: "Old" }), {
    picker: true,
    gone: "Old",
    remember: null,
  });
  assert.deepEqual(pickerDecision([MIA, KID], null), { picker: true, remember: null });
});

test("the seat decides: dial, wake, wait or refuse", () => {
  assert.deepEqual(seatGate(MIA), { kind: "dial" });
  assert.deepEqual(seatGate(KID), { kind: "wake" });
  assert.deepEqual(seatGate(row("x", "X", { seat: { state: "starting", detail: "Signing in…" } })), {
    kind: "wait",
    detail: "Signing in…",
  });
  assert.deepEqual(seatGate(row("x", "X", { seat: { state: "unavailable" } })), {
    kind: "refuse",
    line: "That profile can't play on this host right now.",
  });
  for (const state of ["ready", "occupied", "from-a-newer-host"]) {
    assert.deepEqual(seatGate(row("x", "X", { seat: { state } })), { kind: "dial" }, state);
  }
});

test("a card says what its seat is doing", () => {
  assert.equal(profileNote(MIA), undefined);
  assert.equal(profileNote(row("x", "X", { seat: { state: "occupied", occupant: "Pixel" } })), "In use by Pixel");
  assert.equal(profileNote(row("x", "X", { seat: { state: "starting" } })), "Getting ready…");
  assert.equal(profileNote(row("x", "X", { seat: { state: "ready", steam_sign_in: true } })), "Steam sign-in once");
  assert.equal(initials("mia van  der berg"), "MV");
});

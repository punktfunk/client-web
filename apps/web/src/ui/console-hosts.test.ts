import assert from "node:assert/strict";
import { test } from "node:test";
import { hostRow, originFor } from "./console-hosts.ts";
import type { HostCard } from "./types.ts";

/** The rows as `ConsoleUi.pushHosts` builds them, and its key → origin map. */
function rows(cards: HostCard[]) {
  const all = cards.map((h) => hostRow(h, h.fingerprint));
  return { all, origins: new Map(all.map((r, i) => [r.key, cards[i]!.origin])) };
}

test("hosts the page's server lists without a plane each get their own row", () => {
  const cards: HostCard[] = [
    { origin: "https://page.example/h/desk", name: "desk" },
    { origin: "https://page.example/h/den", name: "den" },
  ];
  const { all, origins } = rows(cards);
  assert.notEqual(all[0]!.key, all[1]!.key);
  assert.notEqual(all[0]!.addr, all[1]!.addr);
  // A Pair names the key; a Launch for an unpaired host names only the address.
  for (const [i, h] of cards.entries()) {
    assert.equal(originFor(origins, cards, all[i]!.key, ""), h.origin);
    assert.equal(originFor(origins, cards, "", all[i]!.addr), h.origin);
  }
});

test("a host with a plane, and one dialled directly, keep their address", () => {
  const cards: HostCard[] = [
    { origin: "https://page.example/h/desk", name: "desk", plane: "192.168.1.20" },
    { origin: "https://192.168.1.31:47990", name: "deck" },
  ];
  const { all, origins } = rows(cards);
  assert.equal(all[0]!.addr, "192.168.1.20");
  assert.equal(all[1]!.addr, "192.168.1.31");
  assert.equal(all[1]!.key, "192.168.1.31:47990");
  assert.equal(originFor(origins, cards, "", "192.168.1.20"), cards[0]!.origin);
});

test("a paired row is keyed by its fingerprint", () => {
  const cards: HostCard[] = [{ origin: "https://page.example/h/desk", name: "desk", fingerprint: "ab".repeat(32) }];
  const { all, origins } = rows(cards);
  assert.equal(all[0]!.key, "ab".repeat(32));
  assert.equal(all[0]!.paired, true);
  assert.equal(originFor(origins, cards, "ab".repeat(32), ""), cards[0]!.origin);
});

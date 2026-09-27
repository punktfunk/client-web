// The browser's host list: a host the page's server lists can be named before it is reached.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as Storage;
const { hosts } = await import("./pf-connect.ts");

test("a host never connected to can still be renamed", () => {
  store.clear();
  const origin = "https://pf.example/h/desk";
  hosts.rename(origin, "  Desk  ");
  assert.equal(hosts.list().find((h) => h.origin === origin)?.label, "Desk");
  hosts.rename(origin, "");
  assert.equal(hosts.list().find((h) => h.origin === origin)?.label, undefined);
});

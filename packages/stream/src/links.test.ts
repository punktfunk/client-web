// Connect links: what a page accepts from a URL anyone could have built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { linkFor, parseLink } from "./links.ts";

const fp = "ab".repeat(32);

test("a link names a host, and optionally its pin, a title and a label", () => {
  assert.equal(parseLink("?ui=console"), null, "no link at all");
  assert.deepEqual(parseLink(`?connect=192.168.1.21&fp=${fp.toUpperCase()}&launch=steam:570&name=Desk`), {
    host: "192.168.1.21",
    fp,
    launch: "steam:570",
    name: "Desk",
  });
  assert.deepEqual(parseLink("?connect=desk&launch="), { host: "desk" }, "an empty launch is none");
});

test("a malformed link is refused, never half-used", () => {
  assert.equal(parseLink("?connect="), "missing-host");
  assert.equal(parseLink(`?connect=${"a".repeat(129)}`), "too-long");
  assert.equal(parseLink("?connect=desk%0Aevil"), "control-char");
  assert.equal(parseLink("?connect=desk&fp=abc"), "bad-fingerprint");
  assert.equal(parseLink("?connect=desk&launch=a%20b"), "bad-launch", "no spaces");
  assert.equal(parseLink("?connect=desk&launch=$(reboot)"), "bad-launch", "nothing a shell reads");
});

test("a copied link round-trips", () => {
  const url = linkFor("https://pf.example/app/?ui=console#x", "https://192.168.1.21:47990", fp);
  assert.deepEqual(parseLink(new URL(url).search), { host: "https://192.168.1.21:47990", fp });
});

// `hide-for-me-vectors.json` is punktfunk's `clients/shared/hide-for-me-vectors.json` at
// 7ff5eeeedcd8c3fad7be45ab57ca7023dced9259, copied verbatim; the Rust, Swift and Kotlin twins
// replay the same file. Every section runs here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchHidden, hideNotice, hideOffer, hideOutcome, hideRequest } from "./hide.ts";
import { useEnglish } from "./words.testing.ts";

useEnglish();

interface Answer {
  status: number;
  body: unknown;
}
interface Vectors {
  offer: { name: string; listed: { id: string; display_name: string; person?: boolean }[] | null; pick: string | null; offered: string | null }[];
  set_hidden: { name: string; profile: string; id: string; hidden: boolean; path: string; body: unknown; reply: Answer; outcome: string; said: string | null }[];
  hidden_list: { name: string; profile: string; host: Record<string, Answer>; asked: string[]; ids: string[] | null }[];
}
const vectors = JSON.parse(readFileSync(new URL("./hide-for-me-vectors.json", import.meta.url), "utf8")) as Vectors;

test("the offer follows the shared vectors", () => {
  assert.ok(vectors.offer.length > 0);
  for (const c of vectors.offer) {
    assert.equal(hideOffer(c.listed, c.pick)?.display_name ?? null, c.offered, c.name);
  }
});

test("a hide follows the shared vectors", () => {
  assert.ok(vectors.set_hidden.length > 0);
  for (const c of vectors.set_hidden) {
    const { path, body } = hideRequest(c.profile, c.id, c.hidden);
    assert.equal(path, c.path, c.name);
    assert.deepEqual(JSON.parse(body), c.body, c.name);
    const outcome = hideOutcome(c.reply.status, c.reply.body === null ? "" : JSON.stringify(c.reply.body));
    assert.equal(outcome.kind, c.outcome, c.name);
    assert.equal(outcome.kind === "refused" ? outcome.said : null, c.said, c.name);
  }
});

test("the hidden list follows the shared vectors", async () => {
  assert.ok(vectors.hidden_list.length > 0);
  for (const c of vectors.hidden_list) {
    const asked: string[] = [];
    const shown = await fetchHidden<{ id: string; hidden?: boolean }>(c.profile, async (path) => {
      asked.push(path);
      const a = c.host[path];
      return a ? { status: a.status, body: JSON.stringify(a.body) } : { status: 404, body: "" };
    }).then(
      (rows) => rows.map((r) => r.id),
      () => null,
    );
    assert.deepEqual(asked, c.asked, `${c.name}: asked`);
    assert.deepEqual(shown, c.ids, `${c.name}: ids`);
  }
});

test("each outcome reads as one line, and the host's sentence stands as it came", () => {
  const refused = { kind: "refused", said: "This device can't change this profile." } as const;
  assert.equal(hideNotice(refused, true, "Dota 2", "Kid"), "This device can't change this profile.");
  assert.equal(hideNotice({ kind: "done" }, true, "Dota 2", "Kid"), "Dota 2 is hidden for Kid");
  assert.equal(hideNotice({ kind: "done" }, false, "Dota 2", "Kid"), "Dota 2 is back for Kid");
  assert.equal(hideNotice({ kind: "failed", why: "no answer" }, false, "Dota 2", "Kid"), "Couldn't show Dota 2 — no answer");
  // An operator's line with no code is never shown: the page words the failure.
  const uncoded = hideOutcome(404, JSON.stringify({ error: "this profile's library lists no such title" }));
  assert.equal(hideNotice(uncoded, true, "Dota 2", "Kid"), "Couldn't hide Dota 2 — the host refused it (404)");
});

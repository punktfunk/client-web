// Which library this page asks a host for. `library-profile-vectors.json` is punktfunk's
// `clients/shared/library-profile-vectors.json` at 7ff5eeeedcd8c3fad7be45ab57ca7023dced9259,
// copied verbatim; the Rust, Swift and Kotlin twins replay the same file. Replayed through the
// real `Host`, so the paths are the ones the generated client asks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as Storage;
const { Host } = await import("./host.ts");

interface Case {
  name: string;
  pick: string | null;
  host: Record<string, { status: number; body: unknown }>;
  expect: { asked: string[]; as: string | null; ids: string[] | null };
}
const { cases } = JSON.parse(readFileSync(new URL("./library-profile-vectors.json", import.meta.url), "utf8")) as { cases: Case[] };

const ORIGIN = "https://desk.example:47990";
const signer = { spki: async () => "", sign: async () => new Uint8Array(64).fill(1) };

/** A page as a host sends it. The generated client decodes the whole page, and the vectors'
 *  pages carry only what the rule reads. */
const whole = (body: unknown): unknown =>
  body && typeof body === "object" && "items" in body ? { total: (body as { items: unknown[] }).items.length, platforms: [], ...body } : body;

/** A host that answers `c.host`'s paths as written, and 404 with no body for any other. */
function hostOf(c: Case): { host: InstanceType<typeof Host>; asked: string[] } {
  const asked: string[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/auth/device/challenge")) return Response.json({ nonce: "ef".repeat(32) });
    if (url.pathname.endsWith("/auth/device/token")) return Response.json({ token: "t", expires_at: Date.now() / 1000 + 3600 });
    const path = url.pathname + url.search;
    asked.push(path);
    const answer = c.host[path];
    return answer ? Response.json(whole(answer.body), { status: answer.status }) : new Response(null, { status: 404 });
  };
  return { host: new Host(ORIGIN, "ab".repeat(32), signer, fetch as typeof globalThis.fetch), asked };
}

test("the library is asked for as the saved pick, per the shared vectors", async () => {
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const { host, asked } = hostOf(c);
    const got = await host.library(c.pick ?? undefined).catch(() => null);
    assert.deepEqual(asked, c.expect.asked, `${c.name}: asked`);
    assert.deepEqual(got ? got.entries.map((e) => e.id) : null, c.expect.ids, `${c.name}: ids`);
    if (got) assert.equal(got.as ?? null, c.expect.as, `${c.name}: as`);
  }
});

test("a hide is one PUT with the profile in as=, and its answer is the outcome", async () => {
  const seen: { method: string; path: string; body: string }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/auth/device/challenge")) return Response.json({ nonce: "ef".repeat(32) });
    if (url.pathname.endsWith("/auth/device/token")) return Response.json({ token: "t", expires_at: Date.now() / 1000 + 3600 });
    seen.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body: String(init?.body ?? "") });
    return Response.json({ error: "That profile is gone from this host. Pick another one.", code: "profile_unknown" }, { status: 404 });
  };
  const host = new Host(ORIGIN, "ab".repeat(32), signer, fetch as typeof globalThis.fetch);
  const outcome = await host.setHidden("a1b2c3d4e5f6", "steam:570", true);
  assert.deepEqual(seen, [{ method: "PUT", path: "/api/v1/library/hidden/steam:570?as=a1b2c3d4e5f6", body: '{"hidden":true}' }]);
  assert.equal(outcome.kind, "refused");
  await assert.rejects(host.hidden("a1b2c3d4e5f6"), "a failed page fails the list");
  assert.equal(seen[1]?.path, "/api/v1/library/page?limit=200&hidden=true&as=a1b2c3d4e5f6");
});

// What this page's own server is shown: the pass on every request to it, and the paired host on
// every request for that host. A request anywhere else goes out untouched.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
Object.assign(globalThis, {
  location: { href: "https://page.example/app/" },
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});
const { onPass, passFor, renewPass, serverFetch } = await import("./pass.ts");

const FP = "cd".repeat(32);
const PASS = "ab".repeat(32);

/** A fetch that records what it was given, and answers `answer`. */
function recording(answer: () => Response = () => new Response("{}")) {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

test("a request to this page's server carries the pass and names the paired host", async () => {
  store.clear();
  store.set("punktfunk.pass", JSON.stringify({ pass: PASS, hosts: [FP] }));
  const { fetch, seen } = recording();
  const via = serverFetch(FP, fetch);
  await via("https://page.example/app/h/desk/api/v1/auth/device/challenge", { method: "POST" });
  await via("https://page.example/app/h/desk/api/v1/status", { headers: { authorization: "Bearer t" } });
  await via("https://desk.example:47990/api/v1/status", { headers: { authorization: "Bearer t" } });
  await serverFetch(undefined, fetch)("https://page.example/app/config.json");
  assert.equal(seen[0]!.headers.get("pf-pass"), PASS);
  assert.equal(seen[0]!.headers.get("pf-host"), FP, "the device exchange carries no token");
  assert.equal(seen[1]!.headers.get("pf-host"), FP);
  assert.equal(seen[3]!.headers.get("pf-host"), null, "no host known, none named");
  assert.equal(seen[1]!.headers.get("authorization"), "Bearer t");
  assert.equal(seen[2]!.headers.get("pf-pass"), null, "another origin is not this server");
  assert.equal(seen[2]!.headers.get("pf-host"), null);
});

test("a stranger's request carries no pass", async () => {
  store.clear();
  const { fetch, seen } = recording();
  await serverFetch(undefined, fetch)("./config.json");
  assert.equal(seen[0]!.headers.get("pf-pass"), null);
  assert.equal(passFor(FP), null);
});

test("a login renews the pass for that host, and only a route on this server asks", async () => {
  store.clear();
  let changed = 0;
  onPass(() => changed++);
  const { fetch, seen } = recording(() => Response.json({ pass: PASS }));
  await renewPass("https://page.example/app/a/192.168.1.21:47990", "Bearer t", FP.toUpperCase(), fetch);
  assert.equal(seen[0]!.url, "https://page.example/app/pass/a/192.168.1.21:47990");
  assert.equal(seen[0]!.headers.get("pf-host"), FP.toUpperCase());
  assert.deepEqual([...passFor(FP)!], Array(32).fill(0xab));
  assert.equal(passFor("ef".repeat(32)), null, "a pass covers only the hosts it was proven to");
  assert.equal(changed, 1);
  await renewPass("https://desk.example:47990", "Bearer t", FP, fetch);
  assert.equal(seen.length, 1, "a host reached directly has no pass to ask for");
});

test("a renewal says whether this page holds a pass for the host afterwards", async () => {
  store.clear();
  const refused = recording(() => new Response("Too many requests", { status: 429 }));
  assert.equal(await renewPass("https://page.example/app/h/desk", "Bearer t", FP, refused.fetch), false);
  const given = recording(() => Response.json({ pass: PASS }));
  assert.equal(await renewPass("https://page.example/app/h/desk", "Bearer t", FP, given.fetch), true);
  assert.equal(await renewPass("https://desk.example:47990", "Bearer t", FP, given.fetch), true, "nothing to ask for");
});

test("a pass the server refused is asked for again with the next call", async () => {
  store.clear();
  const { Host } = await import("./host.ts");
  const passes: number[] = [];
  const answers = [429, 200];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/device/challenge")) return Response.json({ nonce: "ef".repeat(32) });
    if (url.endsWith("/auth/device/token")) return Response.json({ token: "t", expires_at: Date.now() / 1000 + 3600 });
    if (url.includes("/pass/")) {
      const status = answers.shift() ?? 200;
      passes.push(status);
      return status === 200 ? Response.json({ pass: PASS }) : new Response("no", { status });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const signer = { spki: async () => "", sign: async () => new Uint8Array(64).fill(1) };
    const host = new Host("https://page.example/app/h/desk", FP, signer);
    await host.art("/api/v1/library/art/a");
    assert.deepEqual(passes, [429]);
    assert.equal(passFor(FP), null);
    await host.art("/api/v1/library/art/b");
    assert.deepEqual(passes, [429, 200], "asked again");
    assert.deepEqual([...passFor(FP)!], Array(32).fill(0xab));
    await host.art("/api/v1/library/art/c");
    assert.equal(passes.length, 2, "held: not asked a third time");
  } finally {
    globalThis.fetch = real;
  }
});

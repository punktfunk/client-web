import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "./config.ts";

const PAGE = "https://pf.example/web/";
const answer = (r: Response) => (async () => r) as unknown as typeof fetch;

test("the list resolves against the page, and a host without a plane keeps none", async () => {
  const body = { hosts: [{ name: "desk", api: "h/desk", bridge: "w/desk", wake: "wake/desk" }], add: true };
  const c = await readConfig(answer(Response.json(body)), PAGE);
  assert.equal(c?.viaServer, true);
  assert.equal(c?.wait, undefined);
  const desk = c?.listed.get("https://pf.example/web/h/desk");
  assert.deepEqual(desk, {
    api: "https://pf.example/web/h/desk",
    name: "desk",
    wake: "https://pf.example/web/wake/desk",
    bridge: "w/desk",
  });
  assert.equal(desk !== undefined && "plane" in desk, false);
});

test("a 429 is the page's own server: it proxies, and the list is owed after Retry-After", async () => {
  const busy = new Response("Too many requests", { status: 429, headers: { "retry-after": "3" } });
  const c = await readConfig(answer(busy), PAGE);
  assert.deepEqual({ size: c?.listed.size, viaServer: c?.viaServer, wait: c?.wait }, { size: 0, viaServer: true, wait: 3 });
  const bare = await readConfig(answer(new Response("", { status: 429 })), PAGE);
  assert.equal(bare?.wait, 60);
});

test("a server without config.json, or no answer, is no page server", async () => {
  const html = new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  assert.equal(await readConfig(answer(html), PAGE), null);
  const down = (async () => {
    throw new TypeError("network");
  }) as unknown as typeof fetch;
  assert.equal(await readConfig(down, PAGE), null);
});

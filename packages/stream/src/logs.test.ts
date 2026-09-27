// The page's log ring: it keeps the newest lines, names the browser, and stays under the host's cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { captureLog, pageLog } from "./logs.ts";

test("the log keeps the newest lines of the visit", () => {
  const quiet = console.log;
  console.log = () => {};
  captureLog();
  for (let i = 0; i < 2100; i++) console.log(`line ${i}`, { n: i });
  console.log = quiet;
  const log = pageLog();
  assert.match(log, /^punktfunk web client\nuser agent: /);
  assert.match(log, /LOG line 2099 \{"n":2099\}/);
  assert.doesNotMatch(log, /line 0 /, "the oldest lines have gone");
  assert.ok(log.length < 1_000_000, "under the host's 1 MiB cap");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { gameEndNotice, gameEndOf, gameGone } from "./game-end.ts";

test("a status maps to what the player is told, in the native clients' words", () => {
  assert.equal(gameEndOf(200).kind, "ended");
  assert.equal(gameEndOf(409).kind, "not-running");
  assert.equal(gameEndOf(401).kind, "unsupported");
  assert.equal(gameEndOf(404).kind, "unsupported");
  assert.equal(gameEndOf(403).kind, "expired");
  assert.equal(gameEndNotice(gameEndOf(409), "Hades"), "Hades isn't running any more.");
  assert.equal(gameEndNotice(gameEndOf(500), "Hades"), "Couldn't end Hades \u2014 the host refused it (500)");
});

test("only an ended or already-gone game lets a stream end", () => {
  assert.ok(gameGone(gameEndOf(200)));
  assert.ok(gameGone(gameEndOf(409)));
  assert.ok(!gameGone(gameEndOf(403)));
  assert.ok(!gameGone(gameEndOf(404)));
});

// The engine's words: a message it names, a host message by id, and what an id this build lacks reads as.

import assert from "node:assert/strict";
import { test } from "node:test";
import { hostWord, launchNotice, setWords, words } from "./words.ts";
import { useEnglish } from "./words.testing.ts";

test("a message nobody installed reads as its key", () => {
  setWords({} as never);
  assert.equal(words.browser_too_many(), "browser_too_many");
  assert.equal(hostWord("seatline_seats_off", null, "the host's English"), "the host's English");
});

test("a launch verdict reads by its message id, else as the host sent it", () => {
  useEnglish();
  const sent = (v: object) => launchNotice(JSON.stringify(v));
  assert.equal(
    sent({ english: "x", id: "launch_closed_at_once", params: { title: "Hades", seconds: "3" } }),
    "Couldn't start Hades — it closed again after 3 s.",
  );
  assert.equal(sent({ english: "The host's English", id: "launch_from_a_newer_host", params: {} }), "The host's English");
  assert.equal(sent({ english: "No id", id: "", params: {} }), "No id");
  assert.equal(
    sent({ english: "The host's English", id: "launch_closed_at_once", params: { title: "Hades" } }),
    "The host's English",
    "a value the message reads is missing",
  );
  assert.equal(launchNotice("not json"), "not json");
});

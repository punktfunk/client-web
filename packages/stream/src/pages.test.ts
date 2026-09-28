import assert from "node:assert/strict";
import { test } from "node:test";
import { walkPages } from "./pages.ts";

test("a walk follows the cursor to the last page", async () => {
  const asked: (string | undefined)[] = [];
  const titles = await walkPages(async (cursor) => {
    asked.push(cursor);
    if (cursor === undefined) return { items: ["a", "b"], next_cursor: "c1" };
    if (cursor === "c1") return { items: ["c"], next_cursor: "c2" };
    return { items: ["d"], next_cursor: null };
  });
  assert.deepEqual(titles, ["a", "b", "c", "d"]);
  assert.deepEqual(asked, [undefined, "c1", "c2"]);
});

test("a walk ends on a cursor that does not move", async () => {
  let calls = 0;
  const titles = await walkPages(async () => {
    calls++;
    return { items: ["a"], next_cursor: "stuck" };
  });
  assert.equal(calls, 2);
  assert.equal(titles.length, 2);
});

test("a failed page fails the walk", async () => {
  await assert.rejects(
    walkPages(async (cursor) => {
      if (cursor) throw new Error("the host went away");
      return { items: ["a"], next_cursor: "c1" };
    }),
    /the host went away/,
  );
});

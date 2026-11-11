import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { CjkFonts, type Family, familyFor, isCjk, parseRanges, sliceOf } from "./cjk-font.ts";

const require = createRequire(import.meta.url);
const PACKAGES: Record<Family, string> = { jp: "noto-sans-jp", kr: "noto-sans-kr", sc: "noto-sans-sc", tc: "noto-sans-tc" };

/** A family's `ranges.json` as `vite.config.ts` writes it: the numbered slices only. */
function ranges(family: Family): Record<string, string> {
  const unicode = JSON.parse(readFileSync(require.resolve(`@fontsource/${PACKAGES[family]}/unicode.json`), "utf8"));
  return Object.fromEntries(
    Object.entries(unicode as Record<string, string>).flatMap(([k, v]) => {
      const n = /^\[(\d+)\]$/.exec(k)?.[1];
      return n === undefined ? [] : [[n, v]];
    }),
  );
}

test("the UI language picks the Han shapes, then the browser's list, then Japanese", () => {
  assert.equal(familyFor(["ja"]), "jp");
  assert.equal(familyFor(["ko-KR"]), "kr");
  assert.equal(familyFor(["zh-Hans"]), "sc");
  assert.equal(familyFor(["zh-Hant"]), "tc");
  assert.equal(familyFor(["en", "de", "zh-TW", "ja"]), "tc");
  assert.equal(familyFor(["zh_HK"]), "tc");
  assert.equal(familyFor(["zh-MO"]), "tc");
  assert.equal(familyFor(["zh-Hans-HK"]), "sc");
  assert.equal(familyFor(["zh-Hant-CN"]), "tc");
  assert.equal(familyFor(["zh"]), "sc");
  assert.equal(familyFor(["zh-SG"]), "sc");
  assert.equal(familyFor(["en", "fr"]), "jp");
  assert.equal(familyFor([]), "jp");
});

test("only Chinese, Japanese and Korean chars count as CJK", () => {
  for (const c of "あア日门門가ㄱㄅ。、「」Ａｱ𠀋") assert.ok(isCjk(c.codePointAt(0)!), c);
  for (const c of "aZ€ßЖ★™é😀🎮") assert.ok(!isCjk(c.codePointAt(0)!), c);
});

test("a char finds the slice whose unicode-range holds it", () => {
  const runs = parseRanges({ "3": "U+4e00-4e0f,U+4e11", "7": "U+3042, U+20000" });
  assert.deepEqual(runs, [
    [0x3042, 0x3042, 7],
    [0x4e00, 0x4e0f, 3],
    [0x4e11, 0x4e11, 3],
    [0x20000, 0x20000, 7],
  ]);
  assert.equal(sliceOf(runs, 0x4e00), 3);
  assert.equal(sliceOf(runs, 0x4e0f), 3);
  assert.equal(sliceOf(runs, 0x4e10), undefined);
  assert.equal(sliceOf(runs, 0x3042), 7);
  assert.equal(sliceOf(runs, 0x20000), 7);
  assert.equal(sliceOf(runs, 0x41), undefined);
  assert.equal(sliceOf([], 0x3042), undefined);
});

test("every char of every shipped slice maps back to that slice", () => {
  for (const family of Object.keys(PACKAGES) as Family[]) {
    const map = ranges(family);
    const runs = parseRanges(map);
    assert.ok(Object.keys(map).length >= 97, family);
    for (const [first, last, slice] of runs) {
      assert.equal(sliceOf(runs, first), slice);
      assert.equal(sliceOf(runs, last), slice);
    }
    for (let i = 1; i < runs.length; i++) assert.ok(runs[i]![0] > runs[i - 1]![1], `${family}: runs overlap`);
  }
});

/** `fetch` answering from the real ranges, recording each URL; `fail` answers those with 404. */
function stubFetch(fail: (url: string) => boolean = () => false): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (fail(url)) return new Response(null, { status: 404 });
    const m = /\/(jp|kr|sc|tc)\/ranges\.json$/.exec(url);
    if (m) return Response.json(ranges(m[1] as Family));
    return new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x46]));
  }) as typeof fetch;
  return asked;
}

/** Let every fetch and hand-over settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const DIR = new URL("https://page.test/fonts/cjk-5.3.1/");
const paths = (urls: string[]) => urls.map((u) => new URL(u).pathname.replace("/fonts/cjk-5.3.1/", ""));

test("a Japanese title fetches its family's ranges once and each slice it needs once", async () => {
  const asked = stubFetch();
  const faces: Uint8Array[] = [];
  const fonts = new CjkFonts(DIR, "jp", (f) => faces.push(f));
  fonts.want("ゼルダの伝説");
  await settle();
  const runs = parseRanges(ranges("jp"));
  const slices = new Set([..."ゼルダの伝説"].map((c) => sliceOf(runs, c.codePointAt(0)!)));
  assert.deepEqual(paths(asked).sort(), ["jp/ranges.json", ...[...slices].map((s) => `jp/${s}.woff`)].sort());
  assert.equal(faces.length, slices.size);
  // The console reports what is still missing after each face; nothing is fetched twice.
  fonts.want("ゼルダの伝説");
  await settle();
  assert.equal(asked.length, slices.size + 1);
});

test("a title with no CJK char fetches nothing", async () => {
  const asked = stubFetch();
  const fonts = new CjkFonts(DIR, "jp", () => assert.fail("no face"));
  fonts.want("★😀\u{fe0f}é");
  await settle();
  assert.deepEqual(asked, []);
});

test("Hangul on a Japanese page comes from the Korean faces", async () => {
  const asked = stubFetch();
  const fonts = new CjkFonts(DIR, "jp", () => {});
  fonts.want("가");
  await settle();
  const slice = sliceOf(parseRanges(ranges("kr")), 0xac00);
  assert.deepEqual(paths(asked), ["jp/ranges.json", "kr/ranges.json", `kr/${slice}.woff`]);
});

test("a slice that does not load is not asked for again, and the page keeps going", async () => {
  const asked = stubFetch((url) => url.endsWith(".woff"));
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  try {
    const fonts = new CjkFonts(DIR, "jp", () => assert.fail("no face"));
    fonts.want("日本");
    await settle();
    fonts.want("日本");
    await settle();
    assert.equal(asked.filter((u) => u.endsWith(".woff")).length, new Set(asked.filter((u) => u.endsWith(".woff"))).size);
    assert.equal(asked.filter((u) => u.endsWith("ranges.json")).length, 1);
    assert.equal(warned, 1);
  } finally {
    console.warn = warn;
  }
});

test("a family whose ranges do not load is not asked for again", async () => {
  const asked = stubFetch(() => true);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const fonts = new CjkFonts(DIR, "kr", () => assert.fail("no face"));
    fonts.want("한국어");
    await settle();
    fonts.want("한국어");
    await settle();
    assert.deepEqual(paths(asked), ["kr/ranges.json"]);
  } finally {
    console.warn = warn;
  }
});

// Faces for the console's chars Geist lacks: Noto Sans CJK, Regular, in the unicode-range slices
// `@fontsource` cuts, served beside the page (`vite.config.ts`). The console reports what it drew
// as boxes; a slice holding one of those chars is fetched once, from this page's own origin, and
// kept in Cache Storage. Nothing is fetched until the console draws a Chinese, Japanese or Korean
// char, and a slice that does not arrive leaves its chars as boxes: nothing retries.

/** A Han region's faces: the shapes that region's readers expect. */
export type Family = "jp" | "kr" | "sc" | "tc";

/** The order the other families are tried in when the first lacks a char. */
const FAMILIES: readonly Family[] = ["jp", "kr", "sc", "tc"];

/**
 * The family for the first CJK tag in `tags`, the UI language first and then the browser's list;
 * Japanese when none is. A `zh` tag with no script is read by region: `TW`, `HK` and `MO` are
 * Traditional, every other Simplified.
 */
export function familyFor(tags: readonly string[]): Family {
  for (const tag of tags) {
    const [lang, ...rest] = tag.toLowerCase().split(/[-_]/);
    if (lang === "ja") return "jp";
    if (lang === "ko") return "kr";
    if (lang !== "zh") continue;
    if (rest.includes("hant")) return "tc";
    if (rest.includes("hans")) return "sc";
    return rest.some((r) => r === "tw" || r === "hk" || r === "mo") ? "tc" : "sc";
  }
  return "jp";
}

/** Han, kana, Hangul, bopomofo, CJK punctuation and full-width forms. Only such a char fetches a
 *  family's ranges; once they are here, any char they hold fetches its slice. */
const CJK: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff],
  [0x2e80, 0x2fff],
  [0x3000, 0x9fff],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
  [0x1b000, 0x1b16f],
  [0x20000, 0x3ffff],
];

export function isCjk(cp: number): boolean {
  return CJK.some(([first, last]) => cp >= first && cp <= last);
}

/** One family's slices as `[first, last, slice]` runs, sorted by `first`. */
export type Runs = Array<[number, number, number]>;

/** A family's `ranges.json`: each slice's CSS `unicode-range`, `{"12": "U+4e00-4e0f,U+4e11"}`. */
export function parseRanges(ranges: Record<string, string>): Runs {
  const runs: Runs = [];
  for (const [slice, range] of Object.entries(ranges)) {
    for (const part of range.split(",")) {
      const [first = "", last = first] = part.trim().slice(2).split("-");
      runs.push([parseInt(first, 16), parseInt(last, 16), Number(slice)]);
    }
  }
  return runs.sort((a, b) => a[0] - b[0]);
}

/** The slice that holds `cp`, or `undefined`. */
export function sliceOf(runs: Runs, cp: number): number | undefined {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last, slice] = runs[mid]!;
    if (cp < first) hi = mid - 1;
    else if (cp > last) lo = mid + 1;
    else return slice;
  }
  return undefined;
}

/** Cache Storage names start with this; the rest is the slices' directory, which names their
 *  version, so an older version's cache is deleted when this one opens. */
const CACHE = "pf-fonts ";

export class CjkFonts {
  private readonly order: Family[];
  private readonly maps = new Map<Family, Promise<Runs>>();
  /** Slices asked for, as `<family>/<slice>.woff`: each is fetched once, whatever came of it. */
  private readonly asked = new Set<string>();
  private warned = false;
  private store: Promise<Cache | undefined> | undefined;

  /**
   * `dir` holds `<family>/ranges.json` and `<family>/<slice>.woff`; `first` is tried before the
   * others; `add` takes each slice that arrived, as WOFF.
   */
  constructor(
    private readonly dir: URL,
    first: Family,
    private readonly add: (face: Uint8Array) => void,
  ) {
    this.order = [first, ...FAMILIES.filter((f) => f !== first)];
  }

  /** Chars the console could not draw. Returns at once; the faces follow. */
  want(chars: string): void {
    for (const c of chars) void this.find(c.codePointAt(0)!).catch((e: unknown) => this.fail(e));
  }

  /** Fetch the slice that holds `cp`, from the first family whose ranges have it. */
  private async find(cp: number): Promise<void> {
    for (const family of this.order) {
      let map = this.maps.get(family);
      if (!map) {
        if (!isCjk(cp)) return;
        map = this.get(`${family}/ranges.json`).then(async (r) => parseRanges((await r.json()) as Record<string, string>));
        this.maps.set(family, map);
      }
      const slice = sliceOf(await map, cp);
      if (slice === undefined) continue;
      const name = `${family}/${slice}.woff`;
      if (this.asked.has(name)) return;
      this.asked.add(name);
      this.add(new Uint8Array(await (await this.get(name)).arrayBuffer()));
      return;
    }
  }

  /** `name` under the slices' directory: Cache Storage first, then this page's server. */
  private async get(name: string): Promise<Response> {
    const url = new URL(name, this.dir).href;
    const store = await (this.store ??= openCache(CACHE + this.dir.pathname));
    const hit = await store?.match(url);
    if (hit) return hit;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    await store?.put(url, res.clone()).catch(() => {});
    return res;
  }

  private fail(e: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn("punktfunk: CJK font slices did not load; those characters stay boxes", e);
  }
}

/** The cache `name`, after deleting this page's older ones. `undefined` where there is no Cache
 *  Storage: an insecure context, or a browser that refuses it. */
async function openCache(name: string): Promise<Cache | undefined> {
  try {
    const caches = globalThis.caches;
    if (!caches) return undefined;
    for (const old of await caches.keys()) if (old.startsWith(CACHE) && old !== name) void caches.delete(old);
    return await caches.open(name);
  } catch {
    return undefined;
  }
}

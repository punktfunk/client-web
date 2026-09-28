// The host's library, a page at a time (`GET /api/v1/library/page`), so no answer grows with
// the library. Every punktfunk client walks it the same way.

/** Titles a request: the host's ceiling for one page. */
export const PAGE_LIMIT = 200;

/** 500 pages of 200 is 100 000 titles. A host whose cursor never runs out stops here. */
const MAX_PAGES = 500;

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly next_cursor?: string | null;
}

/**
 * Every title, in the host's order. `get` takes the cursor of the page before. Any page
 * failing fails the walk: half a catalog is not one.
 */
export async function walkPages<T>(get: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await get(cursor);
    out.push(...page.items);
    const next = page.next_cursor;
    // A cursor that does not move would ask for the same page forever.
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

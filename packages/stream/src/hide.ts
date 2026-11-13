// "Hide for me": a player takes a title off the library of the locked profile this device is
// let into, and brings it back. A twin of `pf_client_core::hide`, pinned by the same
// `hide-for-me-vectors.json`. `enumerate` marks such a row `person`; a host that sends no mark
// has no action, and nothing probes for one.

import { PAGE_LIMIT, type Page, walkPages } from "./pages.ts";
import { hostWord, words } from "./words.ts";

/** A management answer: its status and body text. */
export interface Reply {
  readonly status: number;
  readonly body: string;
}

/** `s` percent-encoded byte by byte; ASCII letters, digits and `keep` stay. */
function escaped(s: string, keep: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => {
    const ch = String.fromCharCode(b);
    return /[A-Za-z0-9]/.test(ch) || keep.includes(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

const queryValue = (s: string): string => escaped(s, "-_.~");
/** An id as one path segment: `:` stays, as in `steam:570`. */
const pathSegment = (s: string): string => escaped(s, "-_.~:");

/** The row of the profile this device plays as when it may hide titles there: `listed` is what
 *  `enumerate` answered (`null`: no profiles), `pick` the saved pick's id. */
export function hideOffer<P extends { readonly id: string; readonly person?: unknown }>(
  listed: ReadonlyArray<P> | null | undefined,
  pick: string | null | undefined,
): P | undefined {
  if (!pick) return undefined;
  return listed?.find((p) => p.id === pick && p.person === true);
}

/** The path and JSON body of the `PUT` that hides (`hidden`) or shows title `id` for `profile`. */
export function hideRequest(profile: string, id: string, hidden: boolean): { path: string; body: string } {
  return { path: `/api/v1/library/hidden/${pathSegment(id)}?as=${queryValue(profile)}`, body: JSON.stringify({ hidden }) };
}

/** What a hide or a show came to. `refused` carries the host's sentence; `failed` a cause. */
export type HideOutcome = { kind: "done" } | { kind: "refused"; said: string } | { kind: "failed"; why: string };

/** Only a coded error is a sentence for the player: `apierr_<code>` where the page has it, else
 *  the host's English. One with no code is the operator's line and reads as a failure. */
export function hideOutcome(status: number, body: string): HideOutcome {
  if (status >= 200 && status < 300) return { kind: "done" };
  let said: string | undefined;
  try {
    const j = JSON.parse(body) as { error?: unknown; code?: unknown; params?: unknown } | null;
    if (typeof j?.code === "string" && j.code) {
      const given = Object.entries((j.params as Record<string, unknown> | null) ?? {});
      const params = Object.fromEntries(given.filter((kv): kv is [string, string] => typeof kv[1] === "string"));
      said = hostWord(`apierr_${j.code}`, params, typeof j.error === "string" ? j.error : "");
    }
  } catch {
    // Not JSON: nothing the host said.
  }
  return said ? { kind: "refused", said } : { kind: "failed", why: words.error_mgmt_refused({ code: status }) };
}

/** The line a player reads after hiding (`hidden`) or showing `title` for profile `name`. */
export function hideNotice(outcome: HideOutcome, hidden: boolean, title: string, name: string): string {
  switch (outcome.kind) {
    case "done":
      return hidden ? words.lib_hidden_done({ title, name }) : words.lib_shown_done({ title, name });
    case "refused":
      return outcome.said;
    case "failed":
      return hidden ? words.lib_hide_failed({ title, why: outcome.why }) : words.lib_show_failed({ title, why: outcome.why });
  }
}

/**
 * What `profile` hides, its person asking: every page of `hidden=true`, keeping only the rows
 * marked hidden, so a host that ignores the flag lists nothing. `get` answers one path. A page
 * that fails fails the list: no retry without `as`, no other route.
 */
export async function fetchHidden<T extends { readonly hidden?: unknown }>(
  profile: string,
  get: (path: string) => Promise<Reply>,
): Promise<T[]> {
  const rows = await walkPages<T>(async (cursor) => {
    const at = cursor ? `&cursor=${queryValue(cursor)}` : "";
    const reply = await get(`/api/v1/library/page?limit=${PAGE_LIMIT}&hidden=true${at}&as=${queryValue(profile)}`);
    if (reply.status < 200 || reply.status >= 300) throw new Error(words.error_mgmt_refused({ code: reply.status }));
    return JSON.parse(reply.body) as Page<T>;
  });
  return rows.filter((r) => r.hidden === true);
}

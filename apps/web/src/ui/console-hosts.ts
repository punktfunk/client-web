// A known host as the console's Home draws it, and back: the row the page pushes, and the origin
// a row's key or address names when the console raises a command for it.

import type { ConsoleHostRow } from "@punktfunk/stream";
import type { HostCard } from "./types.ts";

/** Where a row says its host is: its plane address, else its own hostname. A host the page's
 *  server routes without telling its plane is its route, which no two hosts share. */
export function hostAddr(h: HostCard): string {
  const url = new URL(h.origin);
  return h.plane ?? (url.pathname === "/" ? url.hostname : h.origin);
}

/** The console's row for `h`, pinned to `fp` when this browser paired with it. */
export function hostRow(h: HostCard, fp: string | undefined): ConsoleHostRow {
  const addr = hostAddr(h);
  const mgmt = Number(new URL(h.origin).port) || 47990;
  return {
    key: fp ?? `${addr}:${mgmt}`,
    id: h.origin,
    name: h.label ?? h.name ?? addr,
    addr,
    port: 9778,
    fp_hex: fp ?? "",
    paired: !!fp,
    saved: true,
    online: h.reach === "ok",
    mgmt_port: mgmt,
    can_wake: !!h.wake && h.reach !== "ok",
    last_used: h.seen ? Math.floor(h.seen / 1000) : null,
    os: "",
    pin: null,
    bound_preset: null,
    profile: h.profile ?? null,
  };
}

/** The origin a console key or address stands for: `origins` maps each row's key to its origin,
 *  and `cards` are the rows' hosts. */
export function originFor(
  origins: ReadonlyMap<string, string>,
  cards: readonly HostCard[],
  key: string,
  addr: string,
): string | undefined {
  const byKey = origins.get(key);
  if (byKey) return byKey;
  for (const [k, o] of origins) if (k.startsWith(`${addr}:`)) return o;
  return cards.find((h) => hostAddr(h) === addr)?.origin;
}

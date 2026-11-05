// What the page's own server says in `config.json`: the hosts it proxies, and whether it also
// proxies a host typed here by its IP address. Apart from `app.ts` so a test can read it.

import type { HostTarget } from "@punktfunk/stream";

/** A host from the page server's `config.json`. `wake` is its wake URL when the server can. */
export interface Configured extends HostTarget {
  name: string;
  wake?: string;
}

export interface ServerConfig {
  listed: Map<string, Configured>;
  /** The server also proxies a host typed here by its IP address. */
  viaServer: boolean;
  /** The server turned the read away (`429`): seconds until it may be asked again. */
  wait?: number;
}

/**
 * Read `config.json` through `fetch`, resolving its routes against `page`. `null` is a server
 * without one: a dev server answers `index.html`, which does not parse. A `429` is the page's
 * own server metering a stranger, so it proxies, and its list is owed.
 */
export async function readConfig(fetch: typeof globalThis.fetch, page: string): Promise<ServerConfig | null> {
  try {
    const r = await fetch(new URL("config.json", page).href, { cache: "no-store" });
    if (r.status === 429) {
      const wait = Number(r.headers.get("retry-after"));
      return { listed: new Map(), viaServer: true, wait: wait > 0 ? wait : 60 };
    }
    const c = (await r.json()) as {
      hosts?: Array<{ name: string; api: string; plane?: string; wake?: string; bridge?: string }>;
      add?: boolean;
    };
    const listed = new Map(
      (c.hosts ?? []).map((h): [string, Configured] => {
        const api = new URL(h.api, page).href.replace(/\/+$/, "");
        const wake = h.wake ? new URL(h.wake, page).href : undefined;
        const bridge = h.bridge ? { bridge: h.bridge } : {};
        const plane = h.plane ? { plane: h.plane } : {};
        return [api, { api, ...plane, name: h.name, ...(wake ? { wake } : {}), ...bridge }];
      }),
    );
    return { listed, viaServer: c.add === true };
  } catch {
    return null;
  }
}

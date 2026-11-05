// The page server's pass: shown to the server once a host has taken this browser's device token.
// It opens nothing on a host; the server lifts its stranger limits for it. One per page origin,
// kept with the fingerprints of the hosts it was proven to. `serverFetch` is the one place it,
// and the paired host's fingerprint, go on a request.

const KEY = "punktfunk.pass";

/** What a `429` from this page's own server means to the person reading it. */
export const TOO_MANY = "too many requests from this address. Wait a minute, then try again";

interface Held {
  pass: string;
  /** Lowercase hex fingerprints of the hosts this pass was proven to. */
  hosts: string[];
}

function read(): Held | null {
  try {
    const held = JSON.parse(localStorage.getItem(KEY) ?? "null") as Held | null;
    return held && /^[0-9a-f]{64}$/.test(held.pass) && Array.isArray(held.hosts) ? held : null;
  } catch {
    return null;
  }
}

function write(held: Held): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(held));
  } catch {
    // Kept nowhere: the next login asks for it again.
  }
}

const listeners = new Set<() => void>();

/** Call `f` whenever the pass changes or covers another host. Returns the unsubscribe. */
export function onPass(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** The pass as the bridge's first message carries it, when it covers the host `fingerprint`. */
export function passFor(fingerprint: string | null | undefined): Uint8Array | null {
  const held = read();
  if (!held || !fingerprint || !held.hosts.includes(fingerprint.toLowerCase())) return null;
  return Uint8Array.from(held.pass.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** Whether `url` is on this page's own server. */
export function ours(url: string): boolean {
  try {
    return new URL(url, location.href).origin === new URL(location.href).origin;
  } catch {
    return false;
  }
}

/**
 * `fetch`, with what this page's own server reads: the pass on every request to it and, given
 * the paired host's fingerprint, `pf-host`. The server then sends the device exchange and the
 * token only over a connection with that host's identity. A request anywhere else goes out as it
 * came.
 */
export function serverFetch(
  hostFingerprint?: string,
  // Unbound: `window.fetch` called as a method of anything but `window` throws "Illegal invocation".
  base: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!ours(url)) return base(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const held = read();
    if (held) headers.set("pf-pass", held.pass);
    if (hostFingerprint) headers.set("pf-host", hostFingerprint);
    return base(input, { ...init, headers });
  };
}

/**
 * After a device login: ask this page's server for a pass for the host at `origin`, or to extend
 * the one held to it. `origin` is the host's route on the server (`…/h/<id>`, `…/a/<ip:port>`);
 * a host the page reaches any other way has nothing to ask for.
 */
export async function renewPass(
  origin: string,
  token: string,
  fingerprint: string,
  base?: typeof fetch,
): Promise<void> {
  const page = new URL(".", location.href).href;
  const route = origin.startsWith(page) ? origin.slice(page.length).replace(/\/+$/, "") : "";
  if (!/^[ha]\/[^/]+$/.test(route)) return;
  const r = await serverFetch(fingerprint, base)(new URL(`pass/${route}`, page).href, {
    method: "POST",
    cache: "no-store",
    headers: { authorization: token },
  });
  if (!r.ok) return;
  const { pass } = (await r.json()) as { pass?: string };
  if (!pass || !/^[0-9a-f]{64}$/.test(pass)) return;
  const held = read();
  const fp = fingerprint.toLowerCase();
  const hosts = held?.pass === pass ? held.hosts : [];
  if (hosts.includes(fp)) return;
  write({ pass, hosts: [...hosts, fp] });
  for (const f of listeners) f();
}

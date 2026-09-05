// Finding a host, and deciding whether to trust it.
//
// This page is not served by the host, so it starts knowing nothing: the user names a host, and
// everything below hangs off that. Two walls stand between naming one and streaming from it, and
// they fail in completely different ways.
//
// **The certificate.** A punktfunk host serves its management API under a self-signed
// certificate, and no browser will let a page `fetch` that — not with CORS relaxed, not with
// `no-cors`, which fails identically because the connection never completes. The user has to open
// the host once in a tab and accept it; after that the exception is the browser's and fetches
// work. `reach` is what tells that case apart from a host that is simply not there, because the
// two are the same `TypeError` and only one of them is worth explaining.
//
// **Identity.** `GET /api/v1/webtransport` is unauthenticated and has to be — a browser that has
// never paired holds no credential — so a first connection is trust-on-first-use, exactly as the
// native clients' is, and PAKE pairing is what actually proves the host. Afterwards it is not:
// pairing stores the host's long-lived fingerprint, the route publishes that identity's signature
// over the short-lived WebTransport hash, and `verify` refuses to dial a host that cannot produce
// it.

import { derToRaw, fromBase64, hexBytes, type Bytes } from "./ecdsa.ts";

const CTX = "punktfunk-wt-cert-v1:";

/** Where a host's management API lives when the user does not say. */
export const DEFAULT_MGMT_PORT = 47990;

/** What `GET /api/v1/webtransport` publishes. The two attestation fields are absent on a host
 *  still serving the legacy RSA identity. */
export interface Plane {
  port: number;
  cert_hash_sha256: string;
  expires_at: number;
  allow_pooling: boolean;
  cert_hash_sig?: string;
  host_cert_der?: string;
}

/** `ok`, `blocked` (there, but its certificate has not been accepted in this browser) or
 *  `unreachable`. */
export type Reach = "ok" | "blocked" | "unreachable";

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// `192.168.1.25`, `192.168.1.25:47991`, `host.local`, or a full origin. Anything else throws
// rather than being guessed at — a mistyped address should say so, not fail later as a network
// error the user reads as "the host is down".
export function originOf(input: string | null | undefined): string {
  const raw = String(input ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("enter the host's address");
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    // The browser's own message quotes the `https://` we just added, which reads as though the
    // user typed it. Say what they can act on instead.
    throw new Error(`"${raw}" is not an address — try something like 192.168.1.25`);
  }
  if (url.protocol !== "https:") throw new Error("a punktfunk host is https");
  if (!url.port) url.port = String(DEFAULT_MGMT_PORT);
  return url.origin;
}

// Is this host reachable, and if not, why not?
//
// The distinction cannot be made from the error — every failure is the same opaque `TypeError` —
// so it is made from timing instead: a TLS refusal comes back immediately, where an unroutable
// address hangs until the timeout. Imperfect, and it only decides which sentence the user reads.
export async function reach(origin: string, timeoutMs = 4000): Promise<Reach> {
  const started = performance.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const r = await fetch(`${origin}/api/v1/health`, {
      cache: "no-store",
      signal: abort.signal,
    });
    return r.ok ? "ok" : "blocked";
  } catch {
    return performance.now() - started < timeoutMs * 0.75 ? "blocked" : "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/** Where to send someone to accept the certificate. Open, so it renders rather than prompting for
 *  a credential behind the warning the user is there to click through. */
export const acceptUrl = (origin: string): string => `${origin}/api/v1/health`;

/** What the host says about its browser plane. Everything here is public. */
export async function fetchPlane(origin: string): Promise<Plane> {
  const r = await fetch(`${origin}/api/v1/webtransport`, { cache: "no-store" });
  if (r.status === 404) throw new Error("this host does not offer the browser plane");
  if (!r.ok) throw new Error(`the host answered ${r.status}`);
  return (await r.json()) as Plane;
}

// Is this plane's certificate vouched for by the host we paired with?
//
// Two things have to hold and neither alone is worth anything: the certificate must be the one
// whose fingerprint we stored, and it must have signed THIS hash. A host that fails either is
// not dialled — the point is to refuse before the connection, not after.
export async function verify(plane: Plane, hostFingerprint: string): Promise<true> {
  if (!plane.cert_hash_sig || !plane.host_cert_der) {
    throw new Error("this host published no attestation, so a paired browser cannot dial it");
  }
  const der = fromBase64(plane.host_cert_der);
  const seen = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", der)));
  if (seen !== hostFingerprint) {
    throw new Error("this is not the host that was paired with");
  }
  const key = await crypto.subtle.importKey(
    "spki",
    spkiOf(der),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    // The host signs ASN.1 DER; WebCrypto verifies raw `r || s`, the same mismatch the client's
    // own signatures have in the other direction.
    derToRaw(hexBytes(plane.cert_hash_sig)),
    new TextEncoder().encode(CTX + plane.cert_hash_sha256),
  );
  if (!ok) throw new Error("the host's signature over its certificate hash does not verify");
  return true;
}

// The SubjectPublicKeyInfo inside an X.509 certificate.
//
// A P-256 SPKI is a fixed 91-byte shape, so finding its header is exact rather than a parse: the
// SEQUENCE, both OIDs and the BIT STRING tag are all determined by the key type. Anything else
// is not a certificate we can verify, which is the correct answer for a non-P-256 host.
function spkiOf(der: Bytes): Bytes {
  const header = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ];
  for (let i = 0; i + 91 <= der.length; i++) {
    if (header.every((b, j) => der[i + j] === b)) return der.subarray(i, i + 91);
  }
  throw new Error("the host certificate carries no P-256 key");
}

/** What this browser remembers about one host. Nothing here is secret. */
export interface KnownHost {
  /** SHA-256 of the host's long-lived certificate, stored at pairing. Absent until then. */
  fingerprint?: string;
  /** The host's own name, once we have streamed from it. */
  name?: string;
  seen?: number;
}

// The hosts this browser knows, by origin. `localStorage`, because it must survive the tab and
// holds nothing secret — the device key itself is in IndexedDB and non-extractable. Losing this
// costs a re-pair, not a compromise.
const KEY = "pf.hosts";

export const hosts = {
  all(): Record<string, KnownHost> {
    try {
      return (JSON.parse(localStorage.getItem(KEY) ?? "") as Record<string, KnownHost>) || {};
    } catch {
      return {};
    }
  },
  fingerprint(origin: string): string | null {
    return hosts.all()[origin]?.fingerprint ?? null;
  },
  remember(origin: string, fields: KnownHost): void {
    const all = hosts.all();
    all[origin] = { ...all[origin], ...fields, seen: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(all));
  },
  forget(origin: string): void {
    const all = hosts.all();
    delete all[origin];
    localStorage.setItem(KEY, JSON.stringify(all));
  },
  /** Most recently used first: the list the picker shows. */
  list(): Array<KnownHost & { origin: string }> {
    const all = hosts.all();
    return Object.keys(all)
      .sort((a, b) => (all[b]?.seen ?? 0) - (all[a]?.seen ?? 0))
      .map((origin) => ({ origin, ...all[origin] }));
  },
};

/** The host fingerprint to store at pairing: the identity that signed, not the throwaway plane
 *  certificate, which is replaced every twelve days. */
export async function hostFingerprint(plane: Plane): Promise<string | null> {
  if (!plane.host_cert_der) return null;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64(plane.host_cert_der))));
}

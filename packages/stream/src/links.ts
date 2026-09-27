// Connect links: `?connect=<host>[&fp=<64 hex>][&launch=<id>][&name=<label>]` on the page, the
// browser's form of the native clients' `punktfunk://connect/…` (pf-client-core `deeplink`).
//
// Same rules: a link names things, never values, and any website can build one, so a link only
// ever opens a confirmation; `fp` is a pin a host must match, never one it gets. The caps and the
// launch-id charset are the native parser's.

export interface PageLink {
  /** An address, a host's origin, or the name it is listed under here. */
  host: string;
  /** The host's certificate fingerprint, lowercase hex: it must match, or the link is refused. */
  fp?: string;
  /** A library id to start once connected. */
  launch?: string;
  /** What the confirmation calls the host when this browser does not know it. */
  name?: string;
}

export type LinkError = "missing-host" | "too-long" | "control-char" | "bad-fingerprint" | "bad-launch";

const MAX = { host: 128, launch: 128, name: 64 } as const;

/** The link in a page's query string: `null` when there is none, a reason when it is malformed. */
export function parseLink(search: string): PageLink | LinkError | null {
  const q = new URLSearchParams(search);
  if (!q.has("connect")) return null;
  const host = (q.get("connect") ?? "").trim();
  if (!host) return "missing-host";
  const fields = { host, launch: q.get("launch") ?? "", name: q.get("name") ?? "", fp: q.get("fp") ?? "" };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
  if (Object.values(fields).some((v) => /[\u0000-\u001f\u007f]/.test(v))) return "control-char";
  if (host.length > MAX.host || fields.launch.length > MAX.launch || fields.name.length > MAX.name) {
    return "too-long";
  }
  if (fields.fp && !/^[0-9a-fA-F]{64}$/.test(fields.fp)) return "bad-fingerprint";
  if (fields.launch && !/^[\x21-\x7e]+$/.test(fields.launch.replace(/["'\\$`]/g, "\u0000"))) {
    return "bad-launch";
  }
  return {
    host,
    ...(fields.fp ? { fp: fields.fp.toLowerCase() } : {}),
    ...(fields.launch ? { launch: fields.launch } : {}),
    ...(fields.name.trim() ? { name: fields.name.trim() } : {}),
  };
}

/** A link to `origin` on this page, pinned to `fingerprint` when this browser has one. */
export function linkFor(page: string, origin: string, fingerprint?: string): string {
  const url = new URL(page);
  url.search = "";
  url.hash = "";
  url.searchParams.set("connect", origin);
  if (fingerprint) url.searchParams.set("fp", fingerprint);
  return url.href;
}

// ECDSA P-256 signatures, in the two shapes the browser and the host disagree about.
//
// WebCrypto produces and consumes raw `r || s`, 32 bytes each. Everything on the host side —
// aws-lc-rs, rcgen, X.509 — speaks ASN.1 DER. Neither will take the other's, so the browser
// converts in both directions: DER in when it verifies the host's attestation, DER out when it
// signs a nonce for the management API.
//
// This is `src/ecdsa.rs` in TypeScript, and deliberately so: the wasm side converts for the
// control stream, the page converts for HTTP, and one of them being subtly wrong would show up
// as a signature the host rejects with no other clue. The round-trip test pins both.

/** A view WebCrypto will accept. It refuses a `SharedArrayBuffer` one, which is what the default
 *  `Uint8Array<ArrayBufferLike>` leaves open. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Wrap a raw `r || s` signature as `SEQUENCE { INTEGER r, INTEGER s }`.
 *
 *  DER integers are signed and minimal, so a value with a high top bit gains a leading zero and
 *  leading zeros are dropped. Getting that wrong yields a signature some verifiers take and
 *  others refuse, which is the worst possible failure. */
export function rawToDer(raw: Uint8Array): Bytes {
  if (raw.length !== 64) throw new Error("a P-256 signature is 64 bytes");
  const r = derInt(raw.subarray(0, 32));
  const s = derInt(raw.subarray(32));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  // A P-256 pair is at most 72 bytes, so never the long form.
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

/** One `INTEGER`, minimally encoded and never negative. */
function derInt(v: Uint8Array): Uint8Array {
  let i = 0;
  while (i < v.length && v[i] === 0) i++;
  const body = v.subarray(i);
  if (body.length === 0) return new Uint8Array([0x02, 0x01, 0x00]);
  const pad = (body[0] ?? 0) & 0x80 ? 1 : 0;
  const out = new Uint8Array(2 + pad + body.length);
  out[0] = 0x02;
  out[1] = body.length + pad;
  out.set(body, 2 + pad);
  return out;
}

/** Unwrap a DER signature to the raw `r || s` WebCrypto wants.
 *
 *  Strict: a trailing byte, a long-form length or an over-long integer is a refusal, not
 *  something to read past. This parses input from the network. */
export function derToRaw(der: Uint8Array): Bytes {
  let i = 0;
  const bad = () => new Error("bad signature");
  const int = (): Uint8Array => {
    if (der[i++] !== 0x02) throw bad();
    const n = der[i++];
    if (n === undefined || n & 0x80) throw bad();
    let v = der.subarray(i, (i += n));
    while (v.length && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw bad();
    return v;
  };
  if (der[i++] !== 0x30 || der[i++] !== der.length - 2) throw bad();
  const r = int();
  const s = int();
  if (i !== der.length) throw bad();
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

export const toBase64 = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b));

export const fromBase64 = (s: string): Bytes =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const hexBytes = (hex: string): Bytes =>
  new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));

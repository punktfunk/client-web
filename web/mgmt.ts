// The management API, from a browser.
//
// Everything the shell shows that is not video comes through here: the library, host details,
// what a session is doing. A browser cannot present the client certificate this API expects, so
// it proves the same pairing the same way it does on the control stream — the host issues a
// nonce, the device key signs it, and the exchange returns a short-lived bearer token.
//
// The signing itself is not here and cannot be. The private key is non-extractable and reachable
// only from `pf-glue.ts`, so a `Device` is handed in. This file holds the protocol and the token,
// and nothing that could leak a key.

import { rawToDer, toBase64, hexBytes, type Bytes } from "./ecdsa.ts";

/** What the host says about itself. Only the fields the shell renders. */
export interface HostInfo {
  hostname: string;
  version?: string;
  uniqueid?: string;
}

/** One entry in the library. The API carries more; this is what a grid needs. */
export interface LibraryEntry {
  id: string;
  title: string;
  /** Art path, relative to the API root. Fetched with the token, not put in an `<img src>`. */
  art?: string;
}

/** The device key, as only the wasm module can offer it. */
export interface Device {
  /** SPKI of the public half, base64 — the bytes the host stored at pairing. */
  spki(): Promise<string>;
  /** Sign with the private half. Returns raw `r || s`, which is what WebCrypto produces. */
  sign(message: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
}

const CTX = "punktfunk-device-auth-v1:";

/**
 * A management-API session for one host.
 *
 * Holds a token and renews it when the host stops accepting one. Nothing else should hold a
 * token: it is authority, and having one place to drop it is the point.
 */
export class Mgmt {
  private token: string | null = null;
  private expiresAt = 0;
  /** In-flight exchange, so a burst of calls runs one handshake rather than four. */
  private pending: Promise<string> | null = null;

  constructor(
    private readonly origin: string,
    /** SHA-256 of the host's long-lived certificate: what a signature is bound to, and what
     *  pairing stored. Binding to it means a signature made for one host is useless at another. */
    private readonly hostFingerprint: string,
    private readonly device: Device,
  ) {}

  async library(): Promise<LibraryEntry[]> {
    const body = await this.json<{ entries?: LibraryEntry[] } | LibraryEntry[]>("/library");
    return Array.isArray(body) ? body : (body.entries ?? []);
  }

  async host(): Promise<HostInfo> {
    return this.json<HostInfo>("/host");
  }

  /** Cover art as an object URL. Art needs the token too, so an `<img src>` pointed straight at
   *  the host would 401 — it is fetched and handed over as a blob instead. The caller revokes. */
  async art(path: string): Promise<string | null> {
    const res = await this.call(path.startsWith("/") ? path : `/${path}`);
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.call(path);
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** One authenticated call, renewing the token once if the host has stopped accepting it. */
  private async call(path: string, retry = true): Promise<Response> {
    const token = await this.authorize();
    const res = await fetch(`${this.origin}/api/v1${path}`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && retry) {
      // Lapsed, or the host restarted and forgot every token it had issued. One retry, then the
      // caller sees the failure.
      this.token = null;
      return this.call(path, false);
    }
    return res;
  }

  private authorize(): Promise<string> {
    // A minute of margin: a token that expires in flight costs the retry above a round trip.
    if (this.token && Date.now() / 1000 < this.expiresAt - 60) {
      return Promise.resolve(this.token);
    }
    this.pending ??= this.exchange().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const challenge = await fetch(`${this.origin}/api/v1/auth/device/challenge`, {
      method: "POST",
      cache: "no-store",
    });
    if (!challenge.ok) throw new Error(`the host refused a challenge (${challenge.status})`);
    const { nonce } = (await challenge.json()) as { nonce: string };

    const raw = await this.device.sign(signedMessage(this.hostFingerprint, nonce));
    const res = await fetch(`${this.origin}/api/v1/auth/device/token`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_key: await this.device.spki(),
        nonce,
        // The host verifies ASN.1 DER; WebCrypto signs raw. The same mismatch as the
        // attestation, in the other direction.
        signature: toBase64(rawToDer(raw)),
      }),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? "this host no longer accepts this browser — pair again"
          : `the token exchange failed (${res.status})`,
      );
    }
    const grant = (await res.json()) as { token: string; expires_at: number };
    this.token = grant.token;
    this.expiresAt = grant.expires_at;
    return grant.token;
  }
}

/**
 * The exact bytes a device signature covers: context, the channel, then the nonce.
 *
 * The same construction as `punktfunk_core::quic::auth_signed_message`, which is what the host
 * verifies against. Both halves have to agree byte for byte, so this is the one place the
 * browser writes it and a test pins it against a known vector.
 */
export function signedMessage(hostFingerprintHex: string, nonceHex: string): Bytes {
  const ctx = new TextEncoder().encode(CTX);
  const binding = hexBytes(hostFingerprintHex);
  const nonce = hexBytes(nonceHex);
  if (binding.length !== 32 || nonce.length !== 32) {
    throw new Error("the binding and the nonce are 32 bytes each");
  }
  const out: Bytes = new Uint8Array(ctx.length + 64);
  out.set(ctx, 0);
  out.set(binding, ctx.length);
  out.set(nonce, ctx.length + 32);
  return out;
}

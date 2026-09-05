// The management API, through the SDK.
//
// `@punktfunk/host/core` is the generated client — every operation typed, every response
// decoded through its Schema — on an `HttpClient` that carries the device credential and
// re-earns it when the host says 401. Nothing here names a path or a JSON shape; if the host's
// API changes, this file finds out by failing to compile against the regenerated client, which
// is the whole reason to consume the SDK rather than `fetch`.
//
// Effect stops at this file's edge. The app holds a `Screen` and the renderers draw it, and
// neither needs to know a `Layer` exists — the SDK's own front door makes the same choice.

import {
  api,
  connection,
  DeviceRefused,
  deviceKey,
  httpClientFor,
  type Connection,
  type Signer,
} from "@punktfunk/host/core";
import { Effect } from "effect";
import { SchemaError } from "effect/Schema";

export type LibraryEntry = api.OperatorGameEntry;
export type HostInfo = api.HostInfo;

/** The host speaks a wire shape this page does not: one side is newer than the other. */
export class VersionSkew extends Error {
  constructor(readonly operation: string, readonly issue: string) {
    super(`this host's ${operation} does not match what this page expects`);
    this.name = "VersionSkew";
  }
}

export class Host {
  private readonly conn: Connection;
  private readonly client: Promise<ReturnType<typeof api.make>>;

  constructor(
    readonly origin: string,
    /** SHA-256 of the host's long-lived certificate — what pairing stored, and what every
     *  device signature is bound to. */
    hostFingerprint: string,
    signer: Signer,
  ) {
    this.conn = connection({
      url: origin,
      credential: deviceKey({ url: origin, hostFingerprint, signer }),
    });
    this.client = Effect.runPromise(httpClientFor(this.conn)).then((http) => api.make(http));
  }

  library(): Promise<ReadonlyArray<LibraryEntry>> {
    return this.run("library", (c) => c.getLibrary(undefined));
  }

  info(): Promise<HostInfo> {
    return this.run("host", (c) => c.getHostInfo(undefined));
  }

  /**
   * Cover art as something an `<img>` can show.
   *
   * A CDN URL is returned as it is. A host-relative one needs the credential, which an `<img
   * src>` cannot carry, so it is fetched and handed back as an object URL. The caller revokes.
   */
  async art(url: string): Promise<string | null> {
    if (/^https?:\/\//.test(url)) return url;
    const res = await this.conn.fetch(`${this.origin}${url.startsWith("/") ? "" : "/"}${url}`, {
      cache: "no-store",
      headers: { authorization: await this.conn.credential.header() },
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  }

  private async run<A>(
    operation: string,
    f: (client: ReturnType<typeof api.make>) => Effect.Effect<A, unknown>,
  ): Promise<A> {
    const client = await this.client;
    try {
      return await Effect.runPromise(f(client));
    } catch (e) {
      throw translate(operation, e);
    }
  }
}

/** The SDK's errors, as the three things the app can act on. */
function translate(operation: string, e: unknown): Error {
  const cause = unwrap(e);
  if (cause instanceof DeviceRefused) return cause;
  if (cause instanceof SchemaError) return new VersionSkew(operation, String(cause));
  if (cause instanceof Error) return cause;
  return new Error(String(cause));
}

/** `Effect.runPromise` rejects with the failure wrapped in a `FiberFailure`; the cause is what
 *  the app wants. */
function unwrap(e: unknown): unknown {
  const inner = (e as { cause?: unknown } | null)?.cause;
  return inner ?? e;
}

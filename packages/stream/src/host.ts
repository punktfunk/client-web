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
import { type GameEnd, gameEndOf } from "./game-end.ts";
import { PAGE_LIMIT, walkPages } from "./pages.ts";

export { DeviceRefused };
export type LibraryEntry = api.OperatorGameEntry;
export type HostInfo = api.HostInfo;
export type HostStatus = api.RuntimeStatus;
export type HostAction = api.ActionInfo;

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

  /**
   * The host's catalog, walked a page at a time. A host older than the paged route refuses
   * it, so the whole list is asked for instead, and its failure is the one reported.
   */
  async library(): Promise<ReadonlyArray<LibraryEntry>> {
    try {
      return await walkPages((cursor) =>
        this.run("library", (c) =>
          c.getLibraryPage({ params: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } }),
        ),
      );
    } catch {
      return this.run("library", (c) => c.getLibrary(undefined));
    }
  }

  info(): Promise<HostInfo> {
    return this.run("host", (c) => c.getHostInfo(undefined));
  }

  /**
   * What the host is doing now: sessions, the running title, whether pairing is waiting on a
   * PIN. Polled rather than pushed — `/events` names every other client and is not on the
   * paired-device lane; `/status` is, and it is what a shell needs to show a running game.
   */
  status(): Promise<HostStatus> {
    return this.run("status", (c) => c.getStatus(undefined));
  }

  /**
   * Cover art as something an `<img>` can show.
   *
   * A CDN URL is returned as it is. A host-relative one needs the credential, which an `<img
   * src>` cannot carry, so it is fetched and handed back as an object URL. The caller revokes.
   */
  async art(url: string): Promise<string | null> {
    if (/^https?:\/\//.test(url)) return url;
    // Unbound: `window.fetch` called as a method of anything but `window` throws "Illegal invocation".
    const fetch = this.conn.fetch;
    const res = await fetch(`${this.origin}${url.startsWith("/") ? "" : "/"}${url}`, {
      cache: "no-store",
      headers: { authorization: await this.conn.credential.header() },
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  }

  /** The host actions this device sees, power among them, and whether its access allows each. */
  async actions(): Promise<ReadonlyArray<HostAction>> {
    return (await this.run("actions", (c) => c.listActions(undefined))).actions;
  }

  /**
   * Run a host action. Power actions end every session first, this device's included.
   *
   * By hand rather than through the client: a power action answers `202` with no body, which the
   * generated decoder, written for `display.next`'s `200`, would report as a version mismatch.
   */
  async invoke(id: string): Promise<void> {
    const res = await this.post(`/api/v1/actions/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(await refusal(res, "the host did not run that action"));
  }

  /**
   * End a title this device launched, live stream included. By hand like `invoke`: each status
   * is an answer to tell the player (409, 403, an older host's 404), not an error to decode.
   */
  async endGame(appId: string): Promise<GameEnd> {
    try {
      const body = JSON.stringify({ app_id: appId, streaming: true });
      return gameEndOf((await this.post("/api/v1/game/end", body, "application/json")).status);
    } catch (e) {
      return { kind: "failed", why: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Hand the page's log to the host, which files it under this device for its console. The
   * client does not carry the plain-text body this route takes, so this is by hand too.
   */
  async uploadLog(text: string): Promise<string> {
    const res = await this.post("/api/v1/client-logs", text);
    if (!res.ok) throw new Error(await refusal(res, "the host did not take the log"));
    return ((await res.json()) as { id: string }).id;
  }

  private async post(path: string, body?: string, type = "text/plain; charset=utf-8"): Promise<Response> {
    // Unbound: `window.fetch` called as a method of anything but `window` throws "Illegal invocation".
    const fetch = this.conn.fetch;
    return fetch(`${this.origin}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: await this.conn.credential.header(),
        ...(body === undefined ? {} : { "content-type": type }),
      },
      ...(body === undefined ? {} : { body }),
    });
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

/** The host's own sentence for a refusal, when its body carries one, else `fallback`. */
async function refusal(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
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

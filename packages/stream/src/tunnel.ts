// The management API over the browser plane: a `fetch` on `/mgmt`.
//
// A packaged page runs from `file://`, where no `fetch` completes against the host's self-signed
// certificate and nobody can accept it. The plane it can dial, pinned by hash, so the API rides
// the plane: one request per bidirectional stream, as the host's `webtransport/mgmt.rs` serves
// it. `tunnelFetch` is a `fetch` the SDK takes as it is — the same arguments, a real `Response`,
// and a rejection wherever `fetch` would reject — so nothing above this file knows the API moved.
//
// Its own session, not the glue's: that one is for pairing and media, and the host gives it ten
// seconds to speak. The host closes this one after a minute idle; the next call reopens it.
//
// The frame, both ways: four bytes of big-endian length, a JSON head, then the body until FIN.
// A request head is `{m, p, h}` — method, path with query, header pairs. A reply head is
// `{s, h}` — status and header pairs. The host caps the head at 16 KiB and the body at 1 MiB.

/** Requests in flight per session. The host refuses a seventeenth; the rest wait here. */
const MAX_IN_FLIGHT = 16;

/** A `fetch` over one tunnel, and the way to close it. */
export interface TunnelFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Close the session. The next call would open a fresh one. */
  close(): void;
}

/** The part of a WebTransport session this file uses — a seam, so a test can stand one up. */
export interface TunnelSession {
  createBidirectionalStream(): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;
  /** Settles when the session is gone, however it went. */
  closed: Promise<unknown>;
  close(): void;
}

/** A tunnel to `url` (`https://host:port/mgmt`), pinned to the plane's certificate hash. */
export function tunnelFetch(url: string, certHashHex: string): TunnelFetch {
  const hash = hexBytes(certHashHex);
  return tunnelOver(async () => {
    const wt = new WebTransport(url, {
      allowPooling: false,
      serverCertificateHashes: [{ algorithm: "sha-256", value: hash }],
    });
    await wt.ready;
    return wt;
  });
}

/** A tunnel over whatever `open` returns. `tunnelFetch` passes a WebTransport; a test, a fake. */
export function tunnelOver(open: () => Promise<TunnelSession>): TunnelFetch {
  const tunnel = new Tunnel(open);
  const f = ((input: RequestInfo | URL, init?: RequestInit) => tunnel.fetch(input, init)) as TunnelFetch;
  f.close = () => tunnel.close();
  return f;
}

class Tunnel {
  private session: Promise<TunnelSession> | null = null;
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly open: () => Promise<TunnelSession>) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = await normalize(input, init);
    if (req.signal?.aborted) throw abortError();
    await this.slot();
    try {
      const session = await this.connect();
      const stream = await session.createBidirectionalStream();
      // The request goes out while the reply is read: a host that refuses early stops reading,
      // and a write that fails for that reason must not hide the reply that says why.
      const writer = stream.writable.getWriter();
      void writer
        .write(encodeRequest(req))
        .then(() => writer.close())
        .catch(() => {});
      const onAbort = () => {
        void stream.readable.cancel().catch(() => {});
        void writer.abort().catch(() => {});
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await readReply(stream.readable);
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
      }
    } catch (e) {
      if (req.signal?.aborted) throw abortError();
      throw e instanceof TypeError ? e : new TypeError(`Failed to fetch: ${(e as Error)?.message ?? e}`);
    } finally {
      this.release();
    }
  }

  close(): void {
    const s = this.session;
    this.session = null;
    void s?.then((session) => session.close()).catch(() => {});
  }

  /** The live session, or a fresh one. Forgotten the moment it closes, so the next call dials. */
  private connect(): Promise<TunnelSession> {
    if (this.session) return this.session;
    const opened = this.open().then((session) => {
      void Promise.resolve(session.closed)
        .catch(() => {})
        .then(() => {
          if (this.session === opened) this.session = null;
        });
      return session;
    });
    opened.catch(() => {
      if (this.session === opened) this.session = null;
    });
    this.session = opened;
    return opened;
  }

  private slot(): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((ready) => this.waiting.push(ready));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }
}

/** One request, as the head carries it. */
export interface TunnelRequest {
  method: string;
  /** Path and query, as `fetch` would send them. */
  path: string;
  headers: Array<[string, string]>;
  body: Uint8Array | null;
  signal?: AbortSignal | null;
}

/** `fetch`'s arguments as the frame needs them. Only what the SDK and the page send is taken:
 *  a string, bytes or a `Blob` as the body; `FormData` and streams are not carried. */
export async function normalize(input: RequestInfo | URL, init?: RequestInit): Promise<TunnelRequest> {
  const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), typeof location === "undefined" ? "http://localhost/" : location.href);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers: Array<[string, string]> = [];
  const take = (h: HeadersInit | Headers | undefined) => {
    if (!h) return;
    for (const [name, value] of new Headers(h)) headers.push([name, value]);
  };
  take(request?.headers);
  take(init?.headers);
  const raw = init?.body ?? (request && request.body ? await request.arrayBuffer() : null);
  return {
    method,
    path: url.pathname + url.search,
    headers,
    body: await bodyBytes(raw),
    signal: init?.signal ?? request?.signal ?? null,
  };
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new TypeError("the tunnel carries a string, bytes or a Blob as the body");
}

/** The frame for one request: length, head, body. */
export function encodeRequest(req: TunnelRequest): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({ m: req.method, p: req.path, h: req.headers }));
  const body = req.body ?? new Uint8Array(0);
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length, false);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out;
}

/** Statuses `Response` refuses a body for; the host sends none there either. */
const BODYLESS = new Set([101, 204, 205, 304]);

/** The reply off the stream: the head, then a `Response` whose body is the rest of it. */
export async function readReply(readable: ReadableStream<Uint8Array>): Promise<Response> {
  const reader = readable.getReader();
  let buffered: Uint8Array = new Uint8Array(0);
  let done = false;
  const need = async (n: number): Promise<boolean> => {
    while (buffered.length < n && !done) {
      const chunk = await reader.read();
      if (chunk.done) done = true;
      else buffered = concat(buffered, chunk.value);
    }
    return buffered.length >= n;
  };
  if (!(await need(4))) throw new TypeError("Failed to fetch: the tunnel closed before a reply");
  const len = new DataView(buffered.buffer, buffered.byteOffset).getUint32(0, false);
  if (!(await need(4 + len))) throw new TypeError("Failed to fetch: the reply head is truncated");
  let head: { s: number; h: Array<[string, string]> };
  try {
    head = JSON.parse(new TextDecoder().decode(buffered.subarray(4, 4 + len))) as typeof head;
  } catch {
    throw new TypeError("Failed to fetch: the reply head is not one");
  }
  const rest = buffered.subarray(4 + len);
  const headers = new Headers();
  for (const [name, value] of head.h ?? []) {
    try {
      headers.append(name, value);
    } catch {
      // A header the browser will not hold is not one the page reads.
    }
  }
  if (BODYLESS.has(head.s)) {
    void reader.cancel().catch(() => {});
    return new Response(null, { status: head.s, headers });
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (rest.length) controller.enqueue(rest);
      if (done) controller.close();
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel() {
      return reader.cancel();
    },
  });
  return new Response(body, { status: head.s, headers });
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

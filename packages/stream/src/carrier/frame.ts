// The bridge's framing: one WebSocket message is one tag byte, then the payload. Every u32 is
// big-endian; `server/src/bridge/frame.rs` is the other copy of this contract. A ping's f64 is
// echoed byte for byte, so only this side reads it.
//
//   0  both            one datagram, as on the wire
//   1  both            control-stream bytes, any chunking
//   2  host → browser  one whole unidirectional stream
//   3  both            u32 close code, then the UTF-8 reason
//   4  both            ping: f64 sender ms; pong: the same f64, then u32 the bridge's RTT in µs
//   5  browser → host  first: the 32-byte pass, for the paired pool
//   6  browser → host  first, empty: a browser without a pass for this host, asking to pair

export const TAG = { DATAGRAM: 0, CONTROL: 1, UNI: 2, CLOSE: 3, PING: 4, PASS: 5, PAIR: 6 } as const;

export type Frame =
  | { tag: typeof TAG.DATAGRAM | typeof TAG.CONTROL | typeof TAG.UNI; bytes: Uint8Array }
  | { tag: typeof TAG.CLOSE; code: number; reason: string }
  | { tag: typeof TAG.PING; sentMs: number; bridgeRttUs?: number }
  | { tag: typeof TAG.PASS; pass: Uint8Array }
  | { tag: typeof TAG.PAIR };

export function encode(f: Frame): Uint8Array<ArrayBuffer> {
  switch (f.tag) {
    case TAG.PASS: {
      const out = new Uint8Array(33);
      out[0] = f.tag;
      out.set(f.pass, 1);
      return out;
    }
    case TAG.PAIR:
      return new Uint8Array([f.tag]);
    case TAG.CLOSE: {
      const reason = new TextEncoder().encode(f.reason);
      const out = new Uint8Array(5 + reason.length);
      out[0] = f.tag;
      new DataView(out.buffer).setUint32(1, f.code >>> 0);
      out.set(reason, 5);
      return out;
    }
    case TAG.PING: {
      const out = new Uint8Array(f.bridgeRttUs === undefined ? 9 : 13);
      const view = new DataView(out.buffer);
      out[0] = f.tag;
      view.setFloat64(1, f.sentMs);
      if (f.bridgeRttUs !== undefined) view.setUint32(9, f.bridgeRttUs >>> 0);
      return out;
    }
    default: {
      const out = new Uint8Array(1 + f.bytes.length);
      out[0] = f.tag;
      out.set(f.bytes, 1);
      return out;
    }
  }
}

/** One message, or `null` for an unknown tag or a payload too short for its tag. Bytes are views
 *  into `msg`, not copies. */
export function decode(msg: Uint8Array): Frame | null {
  const tag = msg[0];
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  switch (tag) {
    case TAG.DATAGRAM:
    case TAG.CONTROL:
    case TAG.UNI:
      return { tag, bytes: msg.subarray(1) };
    case TAG.CLOSE:
      if (msg.length < 5) return null;
      return { tag, code: view.getUint32(1), reason: new TextDecoder().decode(msg.subarray(5)) };
    case TAG.PING:
      if (msg.length === 9) return { tag, sentMs: view.getFloat64(1) };
      if (msg.length === 13) return { tag, sentMs: view.getFloat64(1), bridgeRttUs: view.getUint32(9) };
      return null;
    case TAG.PASS:
      return msg.length === 33 ? { tag, pass: msg.subarray(1) } : null;
    case TAG.PAIR:
      return msg.length === 1 ? { tag } : null;
    default:
      return null;
  }
}

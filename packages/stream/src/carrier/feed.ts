// How the bytes a carrier received reach Rust. The one copy: neither carrier can drift from the
// other in how a datagram lands in the ring or a control chunk crosses into wasm memory.

import type { PunktfunkModule } from "../emscripten.ts";

/** What a carrier hands the wasm side. */
export interface Feed {
  /** One datagram, into the ring; the session is pumped once per burst. */
  datagram(bytes: Uint8Array): void;
  /** Control-stream bytes, in whatever chunks arrived: Rust reassembles. */
  control(bytes: Uint8Array): void;
  /** One whole stream the host opened: why it is about to close, as one `Refused` frame. */
  uni(bytes: Uint8Array): void;
  /** The control stream is open. */
  controlReady(): void;
  /** The session closed: the host's code and reason, or `-1` for a transport failure. */
  closed(code: number, reason: string): void;
}

/**
 * The feed into `mod`.
 *
 * Datagrams never become JavaScript objects that outlive one call: each is copied straight into
 * a ring slot Rust handed out, and nothing is allocated per packet on either side. At 4-5k/s a
 * `Uint8Array` kept per datagram is garbage the collector would be chasing during the stream.
 */
export function wasmFeed(mod: PunktfunkModule): Feed {
  let tick: MessageChannel | null = null;
  let queued = false;
  /** `bytes` in wasm memory for the length of one call. */
  const lend = (bytes: Uint8Array, f: (ptr: number, len: number) => void): void => {
    const p = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, p);
    f(p, bytes.length);
    mod._free(p);
  };
  return {
    datagram(bytes) {
      let slot = mod._pf_rx_claim();
      // A keyframe can outrun the ring inside one burst: drain it now instead of dropping.
      if (slot < 0 && mod.__pfOnData) {
        mod.__pfOnData();
        slot = mod._pf_rx_claim();
      }
      // A slot holds any datagram the protocol allows; a longer one would run into the next.
      if (slot >= 0 && bytes.length <= mod._pf_rx_stride()) {
        mod.HEAPU8.set(bytes, mod._pf_rx_base() + slot * mod._pf_rx_stride());
        mod._pf_rx_commit(slot, bytes.length);
      }
      // The session is pumped once per burst, on a task right after it: a frame starts
      // decoding when its last datagram lands, not at the next animation frame.
      if (!queued) {
        if (!tick) {
          tick = new MessageChannel();
          tick.port1.onmessage = () => {
            queued = false;
            mod.__pfOnData?.();
          };
        }
        queued = true;
        tick.port2.postMessage(0);
      }
    },
    control(bytes) {
      lend(bytes, (p, n) => mod._pf_ctl_recv(p, n));
    },
    uni(bytes) {
      if (bytes.length) lend(bytes, (p, n) => mod._pf_uni_recv(p, n));
    },
    controlReady() {
      mod.__pfOnCtlReady?.();
    },
    closed(code, reason) {
      mod.__pfOnClosed?.(code, reason);
    },
  };
}

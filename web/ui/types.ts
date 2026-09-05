// What a user interface for this client has to be able to draw, and what it may ask for back.
//
// There are two of them and that is the point. `shell.ts` is the web-native one — DOM, pointer,
// touch, a text field for the address — and `console.ts` is `pf-console-ui`, the same gamepad
// shell every other punktfunk client draws, on a canvas. They render the same `Screen` values and
// emit the same `Actions`, so `app.ts` holds the entire state machine and neither UI holds any.
//
// The split is what makes a second interface cheap rather than a fork: nothing about pairing,
// trust or the session lives in a renderer.

import type { KnownHost } from "../pf-connect.ts";
import type { LibraryEntry } from "../mgmt.ts";

/** Everything worth showing about a live session. */
export interface SessionStats {
  origin: string;
  width: number;
  height: number;
  /** Frames the decoder produced in the last second. */
  fps: number;
  /** Access units the wasm side delivered, since the session opened. */
  accessUnits: number;
  decoded: number;
  dropped: number;
  /** Average milliseconds uploading a frame to the video plane. */
  uploadMs: number;
  backend: "webgpu" | "webgl2" | null;
}

/**
 * Where the client is. One of these at a time, and `app.ts` is the only thing that decides.
 *
 * `busy` exists so a renderer can disable its own controls without tracking a second flag: every
 * screen that can be waited on carries it.
 */
export type Screen =
  | { kind: "picker"; hosts: Array<KnownHost & { origin: string }>; error?: string; busy?: boolean }
  | { kind: "accept"; origin: string; url: string }
  | { kind: "connecting"; origin: string }
  | { kind: "pair"; origin: string; message: string; error?: string; busy?: boolean }
  | {
      kind: "library";
      origin: string;
      /** The host's own name, once it has been read. */
      host?: string;
      entries: LibraryEntry[];
      /** Object URLs by entry id, filled in as art arrives. */
      art: Map<string, string>;
      error?: string;
      busy?: boolean;
    }
  | { kind: "streaming"; stats: SessionStats }
  | { kind: "error"; head: string; text: string };

/** What a renderer may ask the client to do. Nothing here returns a result: the answer arrives
 *  as the next `render`, which is what keeps a renderer stateless. */
export interface Actions {
  connect(address: string): void;
  pair(pin: string): void;
  /** Re-check a host after its certificate has been accepted. */
  retry(): void;
  back(): void;
  /** Start streaming. The library is what a browser could not see before it could authenticate
   *  to the management API, so this is the first screen with anything to choose. */
  play(entry?: LibraryEntry): void;
  forget(origin: string): void;
  disconnect(): void;
}

export interface Ui {
  /** Called once, before the first `render`. */
  mount(actions: Actions): void;
  render(screen: Screen): void;
  /** Once per `requestAnimationFrame`, after the video plane has presented. The console draws
   *  here; the web shell does not need it and leaves it out. */
  frame?(width: number, height: number): void;
  destroy(): void;
}

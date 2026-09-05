// What a user interface for this client has to be able to draw, and what it may ask for back.
//
// There are two of them and that is the point. `shell.tsx` is the web-native one — DOM, pointer,
// touch, a text field for the address — and `console.ts` is `pf-console-ui`, the same gamepad
// shell every other punktfunk client draws, on a canvas. They render the same `Screen` values and
// emit the same `Actions`, so `app.ts` holds the entire state machine and neither UI holds any.
//
// The split is what makes a second interface cheap rather than a fork: nothing about pairing,
// trust or the session lives in a renderer.

import type { AudioSnapshot, KnownHost, LibraryEntry, Reach, Settings } from "@punktfunk/stream";

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
  /** Is the pointer locked to the video canvas? Only ever true in `capture` mode. */
  pointerCaptured: boolean;
  /** What the audio pipe last reported — underruns and losses are the half of "is this
   *  connection healthy" the video counters cannot see. */
  audio: AudioSnapshot;
}

/**
 * A host on the home screen. `KnownHost` is what the browser stored; `reach` is what a probe
 * found just now, and is absent until one has answered.
 *
 * Reachability is deliberately per-card and late rather than gating the screen: the grid should
 * be on screen and clickable before any host has been asked whether it is awake.
 */
export interface HostCard extends KnownHost {
  origin: string;
  reach?: Reach;
}

/**
 * Where the client is. One of these at a time, and `app.ts` is the only thing that decides.
 *
 * `busy` exists so a renderer can disable its own controls without tracking a second flag: every
 * screen that can be waited on carries it.
 */
export type Screen =
  /** The way in. Known hosts as cards, and a field for one this browser has not seen —
   *  `adding` is what puts that field in front, and is forced on when there are no cards. */
  | { kind: "home"; hosts: HostCard[]; adding: boolean; error?: string; busy?: boolean }
  | { kind: "accept"; origin: string; url: string }
  /** One spinner screen for the three waits, told apart by `phase` so the wording can differ
   *  without the renderer owning three near-identical screens. */
  | { kind: "connecting"; origin: string; phase: "reaching" | "connecting" | "starting" }
  /**
   * The PIN ceremony. `mode` is why we are here, and it changes the wording rather than the
   * screen: `first` is a browser that has never paired, `again` is a host that has forgotten
   * this one — which is a different sentence and the same box.
   */
  | { kind: "pair"; origin: string; mode: "first" | "again"; error?: string; busy?: boolean }
  /**
   * The host answered, but it is not the host that was paired with. Its own screen, not an
   * error card: this is either a machine that was reinstalled or someone standing in the way of
   * it, and the two need different things from the person reading it.
   */
  | { kind: "trust"; origin: string; reason: string }
  | {
      kind: "library";
      origin: string;
      /** The host's own name, once it has been read. */
      host?: string;
      entries: LibraryEntry[];
      /** Object URLs by entry id, filled in as art arrives. */
      art: Map<string, string>;
      /** What the host is running right now, when something is. */
      running?: string;
      error?: string;
      busy?: boolean;
    }
  | { kind: "streaming"; stats: SessionStats; diagnostics: boolean }
  /**
   * The settings sheet. It renders over whatever screen was showing — including a live one —
   * so it carries no route of its own; `openSettings(false)` puts the previous screen back.
   */
  | { kind: "settings"; values: Settings; streaming: boolean }
  /** `retry` marks an error worth trying again from, which most network ones are. */
  | { kind: "error"; head: string; text: string; retry?: boolean };

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
  /** Name a host something this browser will remember. An empty label drops the name. */
  rename(origin: string, label: string): void;
  disconnect(): void;
  openSettings(on: boolean): void;
  setSettings(patch: Partial<Settings>): void;
  /** Take or release the pointer. Taking it needs a gesture, so this is only ever called from
   *  a click — the engine cannot arm pointer lock on its own. */
  toggleCapture(): void;
  /** Show the numbers behind the connection-quality dot. */
  showDiagnostics(on: boolean): void;
  /** Show or hide the address field on the home screen. Pure presentation, but the home screen
   *  is rebuilt from `app.ts` on every state change, so the flag cannot live in the renderer. */
  setAdding(on: boolean): void;
}

export interface Ui {
  /** Called once, before the first `render`. */
  mount(actions: Actions): void;
  render(screen: Screen): void;
  destroy(): void;
}

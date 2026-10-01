// What a user interface for this client has to be able to draw, and what it may ask for back.
//
// There are two of them and that is the point. `shell.tsx` is the web-native one — DOM, pointer,
// touch, a text field for the address — and `console.ts` is `pf-console-ui`, the same gamepad
// shell every other punktfunk client draws, on a canvas. They render the same `Screen` values and
// emit the same `Actions`, so `app.ts` holds the entire state machine and neither UI holds any.
//
// The split is what makes a second interface cheap rather than a fork: nothing about pairing,
// trust or the session lives in a renderer.

import type { AudioSnapshot, HudLine, KnownHost, LibraryEntry, Reach, Settings } from "@punktfunk/stream";

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
  /** The stats overlay, one entry per line; empty while the tier is off. */
  hud?: HudLine[];
  /** The host's sentence for a launch that did not give the player their game, while it shows. */
  launchNotice?: string;
  /** This device's access when it is limited or ends. */
  access?: string;
  /** A change to that access, or the warning before it ends, while it shows. */
  accessNotice?: string;
  /** The microphone going up to the host. */
  mic?: "off" | "starting" | "on" | "denied" | "unsupported";
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
  /** Where the page's server takes a wake request for this host; absent when it cannot wake it. */
  wake?: string;
  /** A wake went out and the host has not answered yet. */
  waking?: boolean;
}

/**
 * Where the client is. One of these at a time, and `app.ts` is the only thing that decides.
 *
 * `busy` exists so a renderer can disable its own controls without tracking a second flag: every
 * screen that can be waited on carries it.
 */
export type Screen = ScreenBody & {
  /** The sidebar entry to mark. A flow on the way to a host marks the tab it started from. */
  tab?: Tab;
};

type ScreenBody =
  /** The way in. Known hosts as cards, and a field for one this browser has not seen —
   *  `adding` is what puts that field in front, and is forced on when there are no cards. */
  | {
      kind: "home";
      hosts: HostCard[];
      adding: boolean;
      error?: string;
      busy?: boolean;
      /** What an action on a card just did — a link copied — for a moment. */
      notice?: string;
    }
  /** `again`: this host was just sent here, so accepting its certificate did not help. */
  | { kind: "accept"; origin: string; url: string; again?: boolean }
  /** One spinner screen for the three waits, told apart by `phase` so the wording can differ
   *  without the renderer owning three near-identical screens. */
  | { kind: "connecting"; origin: string; phase: "reaching" | "connecting" | "starting" }
  /**
   * The PIN ceremony. `mode` is why we are here, and it changes the wording rather than the
   * screen: `first` is a browser that has never paired, `again` is a host that has forgotten
   * this one — which is a different sentence and the same box.
   */
  | { kind: "pair"; origin: string; mode: "first" | "again"; error?: string; busy?: boolean }
  /** A request for access, held by the host until someone approves `name` in its console. */
  | { kind: "waiting"; origin: string; name: string }
  /**
   * The host answered, but it is not the host that was paired with. Its own screen, not an
   * error card: this is either a machine that was reinstalled or someone standing in the way of
   * it, and the two need different things from the person reading it.
   */
  | { kind: "trust"; origin: string; reason: string }
  | {
      kind: "library";
      /** The shelf: whose titles these are. `null` until some host is paired. */
      origin: string | null;
      /** Every paired host — the shelf switcher, and the Desktops row. */
      shelves: HostCard[];
      /** The host's name as the rest of the page shows it. */
      host?: string;
      /** Not connected to the shelf's host: its titles are the last ones read, and the host
       *  sheet and the running title wait for a connection. */
      offline?: boolean;
      entries: LibraryEntry[];
      /** Object URLs by entry id, filled in as art arrives. */
      art: Map<string, string>;
      /** What the host is running right now, when something is. */
      running?: string;
      /** The host sheet, while it is open: the actions this device may run, and the send-log line. */
      tools?: HostTools;
      /** That title's library entry, when it has one: streaming it picks the game back up. */
      resume?: LibraryEntry;
      /** The running title is this device's launch, so it may end it. */
      endable?: boolean;
      /** What the host said when End game last ran. */
      notice?: string;
      error?: string;
      busy?: boolean;
    }
  /** `menu`: the quick menu is open over the picture. `endGame`: the title this device launched
   *  that the stream plays, which End game ends. `notice`: what the host said when it refused. */
  | {
      kind: "streaming";
      stats: SessionStats;
      diagnostics: boolean;
      menu: boolean;
      endGame?: string;
      notice?: string;
    }
  /**
   * The settings sheet. It renders over whatever screen was showing — including a live one —
   * so it carries no route of its own; `openSettings(false)` puts the previous screen back.
   */
  | { kind: "settings"; values: Settings; streaming: boolean }
  /** A connect link, waiting for a yes: any site can build one, so none connects by itself. */
  | { kind: "link"; name: string; address: string; launch?: string }
  /** The gamepad console draws this one; the web shell stays out of its way. */
  | { kind: "console" }
  /** `retry` marks an error worth trying again from, which most network ones are. */
  | { kind: "error"; head: string; text: string; retry?: boolean };

/** The sidebar's destinations. Flows on the way to a host (pairing, trust, errors) sit under
 *  Hosts; the stream has no frame at all. */
export type Tab = "hosts" | "library" | "settings";

/** Which sidebar entry a screen belongs to: the one it names, else its own. */
export function tabOf(screen: Screen): Tab {
  if (screen.tab) return screen.tab;
  if (screen.kind === "library") return "library";
  if (screen.kind === "settings") return "settings";
  return "hosts";
}

/** The host sheet: power actions as this device sees them, and what the last step said. */
export interface HostTools {
  actions: Array<{ id: string; title: string; danger: boolean; enabled: boolean; reason?: string }>;
  busy: boolean;
  note?: string;
}

/** What a renderer may ask the client to do. Nothing here returns a result: the answer arrives
 *  as the next `render`, which is what keeps a renderer stateless. */
export interface Actions {
  /** Reach a host — typed or known — and open its library, pairing on the way if it must. */
  connect(address: string): void;
  /** Stream a known host's desktop: a host card's click, as on every other client. */
  streamDesktop(origin: string): void;
  /** Show a paired host's library. */
  browse(origin: string): void;
  pair(pin: string): void;
  /** Ask for access instead of typing a PIN; approval starts the desktop stream. */
  requestAccess(): void;
  /** Withdraw that request and go back to the pairing sheet. */
  cancelRequest(): void;
  /** Re-check a host after its certificate has been accepted. */
  retry(): void;
  back(): void;
  /** Stream a title from the open shelf, or its host's desktop. Connects first when the shelf's
   *  host is not connected. */
  play(entry?: LibraryEntry): void;
  forget(origin: string): void;
  /** Answer the link on screen: connect as it asks, or drop it. */
  followLink(yes: boolean): void;
  /** Put a link to this host, pinned to its fingerprint, on the clipboard. */
  copyLink(origin: string): void;
  /** The host sheet on the library: its power actions, and sending this page's log. */
  openTools(on: boolean): void;
  hostAction(id: string): void;
  /** End the title this device launched: the stream's, over a live picture, else the shelf's
   *  running one. Unsaved progress is lost, so the renderer asks first. */
  endGame(): void;
  sendLog(): void;
  /** Send a host the magic packet, through the page's server. */
  wake(origin: string): void;
  /** Name a host something this browser will remember. An empty label drops the name. */
  rename(origin: string, label: string): void;
  /** Leave the stream for the page it started from. `quit` ends the title too; without it the
   *  game keeps running. */
  disconnect(quit?: boolean): void;
  openMenu(on: boolean): void;
  /** Fullscreen on or off. Only from a gesture: the browser refuses it otherwise. */
  fullscreen(): void;
  /** Step the statistics overlay: off, compact, normal, detailed. */
  cycleStats(): void;
  /** Turn the microphone on or off. From a gesture: the browser asks for permission. */
  toggleMic(): void;
  openSettings(on: boolean): void;
  /** A sidebar entry. Leaving a flow half-way through (pairing, a certificate) cancels it. */
  navigate(tab: Tab): void;
  setSettings(patch: Partial<Settings>): void;
  /** Take or release the pointer. Taking it needs a gesture, so this is only ever called from
   *  a click — the engine cannot arm pointer lock on its own. */
  toggleCapture(): void;
  /** Show the numbers behind the connection-quality dot. */
  showDiagnostics(on: boolean): void;
  /** Wear the gamepad console, or go back to this interface. The page reloads into it. */
  consoleMode(on: boolean): void;
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

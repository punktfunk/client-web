// What this browser has been told to prefer, and where that is kept.
//
// These are the knobs the engine already takes — `StreamOptions`, the tunable half of
// `EngineOptions` — with somewhere to live between sessions. They are in the library rather than
// the app because every one of them is about the session or the wire: a second consumer wants
// the same store, and none of it is wording or layout.
//
// `localStorage` under one namespaced key, the same shape `hosts` uses next door. Nothing here
// is secret and losing it costs a re-pick, not a re-pair.
//
// Global rather than per-host. A machine-by-machine override is the obvious extension and is
// deliberately not here yet: it doubles the settings surface to serve a case — two hosts wanting
// different bitrates from the same browser — that no one has hit.

/** Everything a person can choose. `width`/`height` of 0 mean "whatever the window is". */
export interface Settings {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  /** Which video plane to prefer. `auto` takes WebGPU where the engine has it. */
  videoBackend: "auto" | "webgl2" | "webgpu";
  audio: boolean;
  /** Send the keyboard, pointer and gamepads to the host. */
  captureInput: boolean;
  /**
   * How the mouse is sent. `absolute` puts the remote cursor where the local one is, which is
   * what a desktop wants; `capture` takes pointer lock and sends relative motion, which is the
   * only thing a game with mouselook can use.
   */
  pointer: "absolute" | "capture";
  /** Renegotiate the stream's size when the window changes. Off by default — a mid-session
   *  rebuild is disruptive on the host, so it is a choice rather than a behaviour. */
  resizeStream: boolean;
  /** Stick travel below this is rest, 0–1. */
  deadzone: number;
}

export const DEFAULTS: Settings = {
  width: 0,
  height: 0,
  fps: 60,
  bitrateKbps: 20000,
  videoBackend: "auto",
  audio: true,
  captureInput: true,
  pointer: "absolute",
  resizeStream: false,
  deadzone: 0.05,
};

const KEY = "pf.settings";

/**
 * Stored values are merged over the defaults, never trusted to be complete: a build that adds a
 * setting must not find `undefined` in the field it just introduced, and one that removes a
 * setting must not carry the dead key forward. The merge does both.
 */
export const settings = {
  get(): Settings {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<Settings>;
      return sane({ ...DEFAULTS, ...raw });
    } catch {
      return { ...DEFAULTS };
    }
  },
  set(patch: Partial<Settings>): Settings {
    const next = sane({ ...settings.get(), ...patch });
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  },
  reset(): Settings {
    localStorage.removeItem(KEY);
    return { ...DEFAULTS };
  },
};

/**
 * Clamp what came out of storage to what the wire will accept.
 *
 * The even-dimension rule is the one that bites: H.264 and HEVC are 4:2:0, so an odd width or
 * height has no valid chroma grid and the host refuses the session outright. A hand-edited
 * `localStorage`, or a preset that met a device pixel ratio, can both produce one.
 */
function sane(s: Settings): Settings {
  const even = (px: number) => (px > 0 ? Math.max(2, Math.floor(px) & ~1) : 0);
  return {
    ...s,
    width: even(s.width),
    height: even(s.height),
    fps: Math.min(240, Math.max(1, Math.round(s.fps) || DEFAULTS.fps)),
    bitrateKbps: Math.min(200_000, Math.max(500, Math.round(s.bitrateKbps) || DEFAULTS.bitrateKbps)),
    deadzone: Math.min(0.5, Math.max(0, s.deadzone)),
  };
}

// The design harness: every `Screen` the shell can draw, without a host.
//
// `_e2e.ts` drives the engine against a real host, which is the right way to test behaviour and
// the wrong way to look at a screen — half of these are states a live session reaches only by
// misbehaving, and `trust` needs a second machine answering at the same address.
//
// This mounts the shell alone and hands it a value. `?s=<name>` picks one; nothing else on the
// page runs, so what it renders is exactly what the stylesheet and `shell.tsx` say and nothing
// the engine contributed. Dev-only: the build takes `index.html` as its one entry, so neither
// this nor `_e2e.html` reaches `dist/`.

import { DEFAULTS, type LibraryEntry } from "@punktfunk/stream";
import { WebShell } from "./ui/shell.tsx";
import type { Actions, Screen } from "./ui/types.ts";

/** A poster, as a data URI. Real art is a fetch through the credential; the grid only needs
 *  something with the right aspect and enough colour to show the tile treatment. */
const cover = (hue: number): string =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">
       <defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
         <stop offset="0" stop-color="hsl(${hue} 60% 42%)"/>
         <stop offset="1" stop-color="hsl(${hue + 40} 55% 16%)"/>
       </linearGradient></defs>
       <rect width="300" height="400" fill="url(#g)"/>
     </svg>`,
  );

const entry = (id: string, title: string): LibraryEntry =>
  ({ id, title, store: "steam", art: {} }) as LibraryEntry;

const TITLES = [
  "Hollow Knight", "Hades", "Celeste", "Disco Elysium", "Outer Wilds", "Return of the Obra Dinn",
  "Factorio", "Slay the Spire", "Tunic", "Inscryption", "Cocoon", "Pentiment",
];

const entries = TITLES.map((t, i) => entry(`steam:${100 + i}`, t));
const art = new Map(entries.map((e, i) => [e.id, cover(i * 31)] as const));

const stats = {
  origin: "https://192.168.1.25:47990",
  width: 2560, height: 1440, fps: 60, accessUnits: 18_432,
  decoded: 18_400, dropped: 12, uploadMs: 0.8, backend: "webgpu" as const,
  pointerCaptured: false,
  audio: { state: "playing" as const, frames: 91_204, lost: 3, errors: 0, underruns: 1 },
};

const SCREENS: Record<string, Screen> = {
  "home": {
    kind: "home",
    adding: false,
    hosts: [
      { origin: "https://192.168.1.25:47990", name: "living-room-pc", fingerprint: "ab", seen: Date.now() - 4 * 60_000, reach: "ok" },
      { origin: "https://192.168.1.31:47990", name: "deck", fingerprint: "cd", seen: Date.now() - 26 * 3600_000, reach: "unreachable" },
      { origin: "https://192.168.1.44:47990", name: "studio", seen: Date.now() - 3 * 60_000, reach: "ok" },
      { origin: "https://10.0.0.9:47990", seen: Date.now() - 9 * 24 * 3600_000, reach: "blocked" },
    ],
  },
  "home-first-run": { kind: "home", hosts: [], adding: true },
  "home-error": { kind: "home", hosts: [], adding: true, error: `"nope" is not an address — try something like 192.168.1.25` },
  "connecting": { kind: "connecting", origin: "https://192.168.1.25:47990", phase: "reaching" },
  "starting": { kind: "connecting", origin: "https://192.168.1.25:47990", phase: "starting" },
  "accept": { kind: "accept", origin: "https://192.168.1.25:47990", url: "https://192.168.1.25:47990/api/v1/health" },
  "pair": { kind: "pair", origin: "https://192.168.1.25:47990", mode: "first" },
  "pair-again": { kind: "pair", origin: "https://192.168.1.25:47990", mode: "again" },
  "pair-refused": { kind: "pair", origin: "https://192.168.1.25:47990", mode: "first", error: "That PIN was refused." },
  "trust": {
    kind: "trust",
    origin: "https://192.168.1.25:47990",
    reason: "this is not the host that was paired with",
  },
  "library": { kind: "library", origin: "https://192.168.1.25:47990", host: "living-room-pc", entries, art, running: "Hades" },
  "library-empty": { kind: "library", origin: "https://192.168.1.25:47990", host: "living-room-pc", entries: [], art: new Map() },
  "library-loading": { kind: "library", origin: "https://192.168.1.25:47990", host: "living-room-pc", entries: [], art: new Map(), busy: true },
  "streaming": { kind: "streaming", stats, diagnostics: false },
  "streaming-diagnostics": { kind: "streaming", stats, diagnostics: true },
  "streaming-captured": {
    kind: "streaming",
    stats: { ...stats, pointerCaptured: true },
    diagnostics: false,
  },
  "settings": { kind: "settings", values: DEFAULTS, streaming: false },
  "error": {
    kind: "error",
    head: "No answer",
    text: "Nothing responded at 192.168.1.99:47990. Check the address, and that the host is running.",
    retry: true,
  },
};

const noop: Actions = {
  connect() {}, pair() {}, retry() {}, back() {}, play() {}, forget() {}, disconnect() {},
  setAdding() {}, rename() {}, openSettings() {}, setSettings() {}, toggleCapture() {},
  showDiagnostics() {},
};

const shell = new WebShell(document.body);
let live: Screen = SCREENS["home"]!;
// Settings are the one screen with controls that must visibly respond, so the harness keeps a
// copy and re-renders. Everything else is static by design.
shell.mount({
  ...noop,
  setSettings(patch) {
    if (live.kind !== "settings") return;
    live = { ...live, values: { ...live.values, ...patch } };
    shell.render(live);
  },
});
const wanted = new URLSearchParams(location.search).get("s") ?? "home";
live = SCREENS[wanted] ?? SCREENS["home"]!;
shell.render(live);

// What the screenshot driver enumerates, and what a person opening the page with no query gets
// told is available.
Object.assign(window, {
  pfScreens: Object.keys(SCREENS),
  pfShow: (n: string) => {
    live = SCREENS[n]!;
    shell.render(live);
  },
});

// The app: an `Engine` from `@punktfunk/stream`, an interface to draw it, and the mapping
// between the two.
//
// The engine's state carries facts — `blocked`, `needs-pairing`, `forgotten` — and this file
// turns each into a `Screen` with words on it. That is the whole of what the app owns: the
// wording, the choice of interface, the library's titles and art, and the presentation state no
// engine fact covers — the sidebar tab, the shelf the Library tab shows, whether the add-a-host
// sheet is open, and what a reachability probe last said about each host. Everything about
// hosts, trust, pairing and the session lives in the library, which is what lets the same engine
// sit under a TV app without a line of this file.

import "./words.ts";
import {
  captureLog,
  Engine,
  type Host,
  type EngineState,
  gameEndNotice,
  gameGone,
  type HostTarget,
  hosts,
  initials,
  originOf,
  type LibraryEntry,
  type ListedProfile,
  linkFor,
  onPass,
  packaged,
  type PageLink,
  pageLog,
  pageShortcuts,
  parseLink,
  type Press,
  pickerDecision,
  pickOf,
  profileNote,
  type Reach,
  reach,
  reachTarget,
  type ScreenPick,
  type ScreenTargets,
  SEAT_POLL_MS,
  seatGate,
  serverFetch,
  type Settings,
  settings,
  type Shortcuts,
  statusOf,
  VersionSkew,
  wakeFailed,
  wakingLine,
} from "@punktfunk/stream";
import { type Configured, readConfig, type ServerConfig } from "./config.ts";
import { m } from "./paraglide/messages.js";
import { apiText } from "./words.ts";
import { ConsoleUi } from "./ui/console.ts";
import { noop, WebShell } from "./ui/shell.tsx";
import type { HostCard, HostTools, ProfileCard, Screen, Tab, Ui } from "./ui/types.ts";

/** How long a reachability probe is believed. Long enough that returning to the home screen
 *  does not re-probe every host, short enough that a machine woken in the meantime shows up. */
const REACH_TTL_MS = 30_000;

/**
 * How long the window must sit still before the stream is resized to match it.
 *
 * Long, and deliberately so: the host rebuilds its capture pipeline to answer a `Reconfigure`,
 * and on the wlroots reference host that recreates the output. A drag across the screen must
 * cost one renegotiation at the end, not one per frame.
 */
const RESIZE_DEBOUNCE_MS = 700;

/** Where the Library tab opens: the shelf last looked at, per browser. */
const SHELF_KEY = "pf.shelf";

/** A shelf's titles are read again when the tab comes back to it after this long. */
const LIBRARY_TTL_MS = 60_000;

/** How long the host's refusal of End game stays over the picture. */
const STREAM_NOTICE_MS = 6_000;

/** A frame loop that skips this long in a packaged page means the set slept: standby freezes
 *  the page without a `visibilitychange`, and a stream into a dark panel must end. */
const STANDBY_GAP_MS = 5_000;

/** The engine's states on the way to a host. Leaving the tab they sit under cancels them. */
const FLOWS = new Set<EngineState["kind"]>([
  "bad-address", "reaching", "blocked", "unreachable", "untrusted", "connecting", "needs-pairing",
  "awaiting-approval", "pairing", "paired", "pair-refused", "forgotten", "starting", "error",
]);

type Ready = Extract<EngineState, { kind: "ready" }>;

class App {
  private screen: Screen = { kind: "home", hosts: [], adding: true };
  /** The sidebar's tab. Settings is `settingsOpen` instead: it also opens over a live stream. */
  private tab: "hosts" | "library" = "hosts";
  /** The Library tab's host, kept across visits so the tab opens where it was left. */
  private shelf: string | null = readShelf();
  /** The connection under way is the library loading its shelf, not a stream starting: its waits
   *  draw as the library's own, not as a connecting sheet. */
  private quiet = false;
  /** A host added by address opens its library once it is ready; until then its pairing is the
   *  Hosts tab's. */
  private browseOnReady = false;
  /** The shelf's titles as last read, with object URLs for art as it arrives. Kept while its host
   *  is not connected, so the tab never opens blank on a shelf it has shown before. */
  private entries: LibraryEntry[] = [];
  private readonly art = new Map<string, string>();
  /** Data URLs of the profile pictures read so far, by their path on the host. */
  private readonly pictures = new Map<string, string>();
  private libraryFor: string | null = null;
  private libraryLoading = false;
  /** When the titles were last read. Not the same as "is the list empty": a host with nothing in
   *  it answers at once with an empty list, which must not read as still loading. */
  private libraryAt = 0;
  private libraryError: string | undefined;
  private tools: HostTools | null = null;
  private running: string | undefined;
  /** The running title's library id, which is what `Resume` launches. */
  private runningId: string | undefined;
  /** The running title is this device's launch, which End game may end. */
  private runningEndable = false;
  /** What the host said when End game last ran from the library, until the next stream. */
  private endNotice: string | undefined;
  /** The title this device launched that the live stream plays, asked for when the menu opens. */
  private streamGame: { appId: string; title: string } | null = null;
  /** What the host said when End game was refused mid-stream, for a few seconds. */
  private streamNotice: string | undefined;
  /** When the live stream began, while its exit hint is up; `0` once the hint is gone. */
  private hintSince = 0;
  private hintTimer = 0;
  /** The engine state the last render drew: each edge below is against it. */
  private lastKind: EngineState["kind"] = "idle";
  private streamNoticeTimer = 0;
  /** The origin whose running title is being polled. */
  private pollingFor: string | null = null;
  /** What the last stream played (`entry` unset: the desktop), and what to start again once the
   *  host is ready after a stream that dropped. */
  private lastPlay: Play | null = null;
  private resumeOnReady: Play | null = null;
  /** The stream that dropped into the error on screen, which "Try again" brings back. */
  private dropped: Play | null = null;
  private statusTimer = 0;
  /** Is the add-a-host sheet open? Forced on when there is no card to click instead. */
  private adding = false;
  /** What a probe last said about each known host, and when. */
  private readonly reachCache = new Map<string, { reach: Reach; at: number }>();
  /** Hosts a wake went to that have not answered yet. */
  private readonly waking = new Set<string>();
  private probing = false;
  /** Each host's Screen section as last read, with the management API that writes its pick:
   *  the device token comes from a connection, so only hosts reached this visit have one. */
  private readonly screens = new Map<string, { host: Host; targets: ScreenTargets | null }>();
  /** A connect link the page opened with, until it is answered, and the title it asked for. */
  private link: { target: string | HostTarget; fp?: string; launch?: string } | null = null;
  private launchOnReady: string | null = null;
  /** The fingerprint a followed link pinned its host to. Every reconnect to that host carries it
   *  until the page is idle again. */
  private pin: { origin: string; fp: string } | null = null;
  /** The settings page, or its dialog over a live stream. */
  private settingsOpen = false;
  /** The quick menu over a live picture; closed whenever the stream is not. */
  private menuOpen = false;
  private prefs: Settings = settings.get();
  private resizeTimer = 0;
  /** This page went fullscreen for a stream, and goes back when the stream's page returns. */
  private fullscreened = false;
  /** A stream held at the profile gate, or a Switch profile in progress. Cleared to cancel: every
   *  await in the gate checks it is still this one. */
  private gate: Gate | null = null;
  /** A Switch profile asked for a host that was not connected: it opens once the host is ready. */
  private switchOnReady: string | null = null;
  /** The hosts the page's own server proxies, by the API origin the engine keys them under. */
  private readonly configured: Map<string, Configured>;
  /** Whether that server also proxies a host typed here by its IP address. */
  private viaServer: boolean;
  /** When the server's list may be asked for again after it turned the read away; `0`: not owed. */
  private configAgainAt = 0;

  constructor(
    private readonly engine: Engine,
    private readonly ui: Ui,
    /** The web shell, rather than the gamepad console: only it has tabs to keep. */
    private readonly web: boolean,
    private readonly uiCanvas: HTMLCanvasElement,
    server: ServerConfig,
  ) {
    this.configured = server.listed;
    this.viaServer = server.viaServer;
    // A login's pass covers another host: the server now tells this browser its address and wake.
    onPass(() => void this.refreshConfigured());
    ui.mount({
      connect: (address) => {
        this.adding = false;
        this.quiet = false;
        this.browseOnReady = true;
        this.settingsOpen = false;
        void engine.connect(this.targetOf(address));
      },
      streamDesktop: (origin) => this.play(undefined, origin),
      browse: (origin) => this.openShelf(origin),
      navigate: (tab) => this.navigate(tab),
      pair: (pin) => engine.pair(pin),
      requestAccess: () => engine.requestAccess(this.streamOptions()),
      cancelRequest: () => engine.cancelRequest(),
      retry: () => {
        const s = engine.current;
        // After a dropped stream, try again means that stream: the same title, not the library.
        // Otherwise a stream a card asked for is still what the retry is for.
        if (this.dropped) this.resumeOnReady = this.dropped;
        this.dropped = null;
        if ("origin" in s && s.origin) this.reconnect(s.origin);
      },
      // Leaving the profile gate goes back to the host, not away from it.
      back: () => (this.gate ? this.cancelGate() : engine.disconnect()),
      play: (entry, profile) => this.play(entry, undefined, profile),
      pickProfile: (id) => this.pickProfile(id),
      switchProfile: (origin) => this.switchProfile(origin),
      forget: (origin) => this.forget(origin),
      followLink: (yes) => this.followLink(yes),
      copyLink: (origin) => void this.copyLink(origin),
      openTools: (on) => void this.openTools(on),
      hostAction: (id) => void this.hostAction(id),
      endGame: () => void this.endGame(),
      sendLog: () => void this.sendLog(),
      wake: (origin) => this.wake(origin),
      disconnect: (quit) => {
        this.menuOpen = false;
        engine.leave(quit);
      },
      openMenu: (on) => {
        this.menuOpen = on;
        if (on) void this.findStreamGame();
        this.render(engine.current);
      },
      fullscreen: () => engine.fullscreen(),
      cycleStats: () => engine.cycleStats(),
      toggleMic: () => engine.toggleMic(),
      consoleMode: (on) => {
        const url = new URL(location.href);
        if (on) url.searchParams.set("ui", "console");
        else url.searchParams.delete("ui");
        location.assign(url);
      },
      setAdding: (on) => {
        this.adding = on;
        if (this.screen.kind === "home") this.home();
      },
      rename: (origin, label) => {
        hosts.rename(origin, label);
        this.render(engine.current);
      },
      setScreen: (origin, pick) => void this.setScreen(origin, pick),
      openSettings: (on) => {
        this.settingsOpen = on;
        this.render(engine.current);
      },
      setSettings: (patch) => {
        this.prefs = settings.set(patch);
        this.applyPrefs(patch);
        this.render(engine.current);
      },
      toggleCapture: () => {
        const s = engine.current;
        engine.capturePointer(s.kind === "streaming" ? !s.stats.pointerCaptured : true);
      },
      // The dot opens the overlay at the tier settings start from, or Normal when that is off.
      showDiagnostics: (on) => {
        const start = this.prefs.statsTier;
        engine.setStatsTier(on ? (start === "off" ? "normal" : start) : "off");
      },
    });
    // The server turned its list away: say so, and ask again on a later redraw of the hosts.
    if (server.wait) {
      this.configAgainAt = Date.now() + server.wait * 1000;
      ui.notify(m.browser_too_many(), "error");
    }
    this.applyPrefs();
    this.watchSize();
    if (packaged()) this.watchSleep();
    engine.onMenu(() => {
      this.menuOpen = !this.menuOpen;
      if (this.menuOpen) void this.findStreamGame();
      this.render(engine.current);
    });
    engine.onState((s) => this.render(s));
    this.openLink();
  }

  private show(screen: Screen): void {
    this.screen = { ...screen, tab: this.settingsOpen ? "settings" : screen.kind === "library" ? "library" : this.tab };
    this.ui.render(this.screen);
  }

  /** Facts in, words out. */
  private render(s: EngineState): void {
    const was = this.lastKind;
    this.lastKind = s.kind;
    // A host card's screens, read once per connection. The console reads its own.
    if (this.web && s.kind === "ready" && this.screens.get(s.origin)?.host !== s.host) void this.readScreens(s.origin, s.host);
    // The gate waits on its host's `ready`; anything else ends the wait, and a connect that
    // ended short of it drops the Switch profile it was for.
    if (this.gate && (s.kind !== "ready" || s.origin !== this.gate.origin)) this.gate = null;
    if (s.kind === "idle" || s.kind === "error" || s.kind === "unreachable") this.switchOnReady = null;
    if (s.kind !== "streaming") {
      this.menuOpen = false;
      this.streamGame = null;
    }
    // The exit hint: armed on the edge into a stream, dropped by its timer or the stream's end.
    const streaming = s.kind === "streaming";
    if (streaming && was !== "streaming" && this.prefs.exitHint) {
      this.hintSince = Date.now();
      clearTimeout(this.hintTimer);
      this.hintTimer = window.setTimeout(() => {
        this.hintSince = 0;
        this.render(this.engine.current);
      }, EXIT_HINT_MS);
    } else if (!streaming) {
      this.hintSince = 0;
      clearTimeout(this.hintTimer);
    }
    // A stream that ends takes the settings dialog over it along: how it ended is what to show.
    // One that drops is what "Try again" brings back.
    if (live(was) && !live(s.kind)) {
      this.settingsOpen = false;
      if (s.kind === "error") this.dropped = this.lastPlay;
    }
    if (this.settingsOpen) {
      return this.show({ kind: "settings", values: this.prefs, streaming: s.kind === "streaming" });
    }
    // The library reaching its shelf's host is the library loading, not a sheet in its way.
    if (this.quiet && (s.kind === "reaching" || s.kind === "connecting")) return this.showLibrary();
    this.quiet = false;
    switch (s.kind) {
      case "idle":
        this.windowed();
        this.browseOnReady = false;
        this.stopPolling();
        this.launchOnReady = null;
        this.resumeOnReady = null;
        this.dropped = null;
        this.pin = null;
        return this.web && this.tab === "library" ? this.showLibrary() : this.home();
      case "bad-address":
        // The field stays in front: what was typed is wrong and this is where it is fixed.
        this.adding = true;
        this.tab = "hosts";
        return this.home();
      case "reaching":
        return this.show({ kind: "connecting", origin: s.origin, phase: "reaching" });
      case "blocked": {
        // Back here for the host just sent here: accepting its certificate was not the fix.
        const again = this.screen.kind === "accept" && this.screen.origin === s.origin;
        return this.show({ kind: "accept", origin: s.origin, url: s.acceptUrl, ...(again ? { again } : {}) });
      }
      case "unreachable":
        return this.show({
          kind: "error",
          head: m.browser_no_answer_title(),
          text: m.error_host_timeout(),
          retry: true,
        });
      case "untrusted":
        return this.show({ kind: "trust", origin: s.origin, reason: sentence(s.reason) });
      case "connecting":
        return this.show({ kind: "connecting", origin: s.origin, phase: "connecting" });
      case "needs-pairing":
        return this.show({ kind: "pair", origin: s.origin, mode: "first", ...this.pinOnly(s.origin) });
      case "pairing":
        return this.show({ kind: "pair", origin: s.origin, mode: "first", busy: true, ...this.pinOnly(s.origin) });
      case "awaiting-approval":
        return this.show({ kind: "waiting", origin: s.origin, name: s.name, ...(s.code ? { code: s.code } : {}) });
      case "paired": {
        // A request for access was for the desktop stream; one the host had no seat for yet goes
        // on through the profile gate once the connect is ready. The console drives its own.
        if (this.web && this.screen.kind === "waiting") this.resumeOnReady ??= {};
        const pinOnly = this.screen.kind === "pair" && this.screen.pinOnly;
        this.show({ kind: "pair", origin: s.origin, mode: "first", busy: true, ...(pinOnly ? { pinOnly } : {}) });
        // The host closes after the ceremony, as it does for native clients; streaming is a
        // fresh connection.
        const origin = s.origin;
        setTimeout(() => this.reconnect(origin), 300);
        return;
      }
      case "pair-refused":
        return this.show({
          kind: "pair",
          origin: s.origin,
          mode: "first",
          error: s.reason ? sentence(s.reason) : m.pair_wrong_pin(),
          ...this.pinOnly(s.origin),
        });
      case "forgotten":
        return this.show({ kind: "pair", origin: s.origin, mode: "again", ...this.pinOnly(s.origin) });
      case "ready": {
        if (this.gate) return this.show(this.gate.screen);
        if (this.switchOnReady === s.origin) {
          this.switchOnReady = null;
          queueMicrotask(() => void this.askProfile(s.origin, s.host, null));
          return;
        }
        const launch = this.launchOnReady;
        if (launch) {
          // The title a link asked for. Not from inside this listener: starting a stream sets the
          // engine's state again.
          this.launchOnReady = null;
          queueMicrotask(() => this.start({ id: launch, title: launch } as LibraryEntry));
          return;
        }
        const resume = this.resumeOnReady;
        if (resume) {
          // Not from inside this listener: starting the stream sets the engine's state again. The
          // connecting screen stays up until it does.
          this.resumeOnReady = null;
          queueMicrotask(() => this.start(resume.entry, resume.profile));
          return;
        }
        this.windowed();
        if (this.browseOnReady) {
          this.browseOnReady = false;
          this.tab = "library";
        }
        // The console has no tabs: a host it reaches is a library it shows.
        if (this.web && this.tab === "hosts") return this.home();
        this.setShelf(s.origin);
        if (this.libraryFor !== s.origin || (!this.libraryLoading && Date.now() - this.libraryAt > LIBRARY_TTL_MS)) {
          void this.openLibrary(s);
        }
        this.watchRunning(s);
        return this.showLibrary();
      }
      case "starting":
        return this.show({ kind: "connecting", origin: s.origin, phase: "starting" });
      case "streaming": {
        const live = pageShortcuts(this.prefs.shortcuts);
        const menuHint = this.menuOpen ? menuHintText(live) : undefined;
        return this.show({
          kind: "streaming",
          stats: { origin: s.origin, ...s.stats },
          diagnostics: s.stats.statsTier !== "off",
          menu: this.menuOpen,
          corner: this.prefs.hudPlacement,
          scale: this.prefs.statsScalePct / 100,
          ...(this.hintSince ? { exitHint: exitHintText(live) } : {}),
          ...(menuHint ? { menuHint } : {}),
          ...(this.streamGame ? { endGame: this.streamGame.title } : {}),
          ...(this.streamNotice ? { notice: this.streamNotice } : {}),
        });
      }
      case "error": {
        this.windowed();
        return this.show({
          kind: "error",
          head: s.skew
            ? m.browser_skew_title()
            : this.dropped
              ? "The stream stopped"
              : m.browser_error_title(),
          text: s.skew ? `${sentence(s.message)} ${m.browser_skew_hint()}` : sentence(s.message),
          retry: !s.skew,
        });
      }
    }
  }

  // --- the tabs --------------------------------------------------------------------------
  /** A sidebar entry. A flow left half-way — a PIN, a certificate, an error, the profile gate —
   *  is cancelled; the library's own connection is kept, since it is what the Library tab shows. */
  private navigate(tab: Tab): void {
    const s = this.engine.current;
    if (tab === "settings") {
      this.settingsOpen = true;
      return this.render(s);
    }
    this.settingsOpen = false;
    this.tab = tab;
    this.link = null;
    this.gate = null;
    if (FLOWS.has(s.kind) && !(this.quiet && tab === "library")) {
      this.quiet = false;
      this.engine.disconnect();
    }
    if (tab === "library") return this.openShelf();
    this.render(this.engine.current);
  }

  /** Show a shelf, connecting to its host in the background when it is not the one connected.
   *  Its titles as last read stay on screen meanwhile. */
  private openShelf(origin = this.currentShelf()): void {
    this.tab = "library";
    this.settingsOpen = false;
    if (origin) this.setShelf(origin);
    const s = this.engine.current;
    if (!origin || ("origin" in s && s.origin === origin && s.kind !== "error")) {
      return this.render(s);
    }
    this.quiet = true;
    void this.engine.connect(this.targetOf(origin));
  }

  private setShelf(origin: string): void {
    if (this.shelf === origin) return;
    this.shelf = origin;
    try {
      localStorage.setItem(SHELF_KEY, origin);
    } catch {
      // Storage blocked: the tab opens on the first paired host next visit.
    }
  }

  /** The shelf to show: the one last looked at while it is still paired, else the first paired. */
  private currentShelf(): string | null {
    const paired = this.paired();
    return paired.find((h) => h.origin === this.shelf)?.origin ?? paired[0]?.origin ?? null;
  }

  // --- the host list ---------------------------------------------------------------------
  private home(): void {
    // A link waiting for its answer stays in front of the probes that redraw this list.
    if (this.link) return;
    if (this.configAgainAt && Date.now() >= this.configAgainAt) void this.refreshConfigured();
    const cards = this.cards();
    // A mistyped address stays said while the engine holds it, whatever redraws the list.
    const s = this.engine.current;
    const error = s.kind === "bad-address" ? sentence(s.message) : undefined;
    this.show({
      kind: "home",
      hosts: cards,
      // Nothing to click means the field is the only way forward.
      adding: this.adding || cards.length === 0,
      ...(error ? { error } : {}),
    });
    void this.probe(cards.map((h) => h.origin));
  }

  /** The server's list again: as a pass holder sees it, or once a turned-away read may retry. */
  private async refreshConfigured(): Promise<void> {
    this.configAgainAt = 0;
    const again = await readConfig(serverFetch(), location.href);
    if (!again) return;
    if (again.wait) {
      this.configAgainAt = Date.now() + again.wait * 1000;
      return;
    }
    for (const [origin, c] of again.listed) this.configured.set(origin, c);
    this.viaServer = again.viaServer;
    this.redrawLists();
  }

  /** Every host this page knows: the server's first, under the name it gives them; then the ones
   *  typed here. Each with what a probe last said about it, and its screens once read. */
  private cards(): HostCard[] {
    const known = new Map(this.engine.knownHosts().map((h) => [h.origin, h]));
    const listed: HostCard[] = [
      ...[...this.configured].map(([origin, c]) => ({
        ...known.get(origin),
        origin,
        name: c.name,
        ...(c.plane ? { plane: c.plane } : {}),
        ...(c.wake ? { wake: c.wake, waking: this.waking.has(origin) } : {}),
      })),
      ...[...known.values()].filter((h) => !this.configured.has(h.origin)),
    ];
    return listed.map((h) => {
      const seen = this.reachCache.get(h.origin);
      const screens = this.screens.get(h.origin)?.targets;
      return { ...h, ...(seen ? { reach: seen.reach } : {}), ...(screens ? { screens } : {}) };
    });
  }

  /** Read a host's Screen section through `host`, keeping the last answer meanwhile, and
   *  redraw the list it shows on. A host without the route, or one that fails, shows none. */
  private async readScreens(origin: string, host: Host): Promise<void> {
    this.screens.set(origin, { host, targets: this.screens.get(origin)?.targets ?? null });
    const targets = await host.screens().catch(() => null);
    if (this.screens.get(origin)?.host !== host) return;
    this.screens.set(origin, { host, targets });
    this.redrawLists();
  }

  /** Write a Screen row's pick, say a refusal (`screen_choice_not_granted` among them), and
   *  read the rows back either way. */
  private async setScreen(origin: string, pick: ScreenPick): Promise<void> {
    const host = this.screens.get(origin)?.host;
    if (!host) return;
    try {
      await host.setScreen(pick);
    } catch (e) {
      this.ui.notify(sentence(e instanceof Error ? e.message : String(e)), "error");
    }
    await this.readScreens(origin, host);
  }

  /** The hosts with a pairing here: the shelves. */
  private paired(): HostCard[] {
    return this.cards().filter((h) => h.fingerprint);
  }

  /** A host added by its address pairs by PIN: nothing names the fingerprint it must show, and a
   *  request proves only this device. One the page's server lists, a link pinned or this browser
   *  paired with has one. */
  private pinOnly(origin: string): { pinOnly?: boolean } {
    const known =
      this.configured.has(origin) ||
      this.pin?.origin === origin ||
      !!this.engine.knownHosts().find((h) => h.origin === origin)?.fingerprint;
    return known ? {} : { pinOnly: true };
  }

  /** What a host is called on screen. */
  private nameOf(origin: string): string {
    const h = this.cards().find((c) => c.origin === origin);
    return h?.label ?? h?.name ?? bare(origin);
  }

  /**
   * How to reach what a card or the address field names. A packaged page has one way, the
   * plane's tunnel. Otherwise a host the server lists, or one reached through it before, keeps
   * its route and its bridge; a typed IP address goes through the server when it offers that;
   * anything else is dialled directly.
   */
  private targetOf(address: string): string | HostTarget {
    if (packaged()) return tunnelTarget(address);
    const listed = this.configured.get(address);
    if (listed) return listed;
    // Already a route through the server (a retry, a card): the address names its own plane.
    const route = routeOf(address);
    if (route) return route;
    const known = this.engine.knownHosts().find((h) => h.origin === address);
    if (known?.plane) return { api: address, plane: known.plane };
    const routed = this.viaServer ? throughServer(address) : null;
    if (!routed) return address;
    // A host tried directly before moves to the server route, name and pairing included.
    if (known) {
      const { origin: _old, ...record } = known;
      hosts.forget(address);
      hosts.remember(routed.api, { ...record, ...(routed.plane ? { plane: routed.plane } : {}) });
    }
    return routed;
  }

  /**
   * Ask each known host whether it is there, then redraw. Cheap and stale-tolerant: a probe is
   * one `/health` fetch, its answer is believed for `REACH_TTL_MS`, and the page is already on
   * screen and clickable before any of them answer.
   */
  private async probe(origins: string[]): Promise<void> {
    if (this.probing) return;
    const now = Date.now();
    const stale = origins.filter((o) => now - (this.reachCache.get(o)?.at ?? 0) > REACH_TTL_MS);
    if (stale.length === 0) return;
    this.probing = true;
    try {
      await Promise.all(
        stale.map(async (origin) => {
          this.reachCache.set(origin, { reach: await reachTarget(this.targetOf(origin)), at: Date.now() });
          // Redraw per answer rather than once at the end: the first host to reply should not
          // wait on the slowest, which is the one that will take the full timeout.
          this.redrawLists();
        }),
      );
    } finally {
      this.probing = false;
    }
  }

  /** Redraw whichever list is showing: a probe or a wake changed a host's state on it. */
  private redrawLists(): void {
    if (this.screen.kind === "home") this.home();
    else if (this.screen.kind === "library") this.showLibrary();
  }

  /**
   * The link the page was opened with, if any: resolved against the hosts this page knows, and
   * shown for a yes. Taken off the address bar at once, so a reload does not ask again.
   */
  private openLink(): void {
    const parsed = parseLink(location.search);
    if (parsed === null) return;
    history.replaceState(null, "", location.pathname + location.hash);
    if (typeof parsed === "string") {
      return this.show({ kind: "error", head: m.link_refused_title(), text: LINK_ERRORS[parsed]() });
    }
    const found = this.resolveLink(parsed);
    if (typeof found === "string") return this.show({ kind: "error", head: m.link_refused_title(), text: found });
    const { target, name, address } = found;
    this.link = { target, ...(parsed.fp ? { fp: parsed.fp } : {}), ...(parsed.launch ? { launch: parsed.launch } : {}) };
    this.show({ kind: "link", name, address, ...(parsed.launch ? { launch: parsed.launch } : {}) });
  }

  /** A link's host as this page reaches it: a host it lists or knows by origin or name, else the
   *  address itself. A name two hosts share is refused rather than guessed. */
  private resolveLink(link: PageLink): { target: string | HostTarget; name: string; address: string } | string {
    const known = this.engine.knownHosts();
    const listed = [...this.configured].map(([origin, c]) => ({ origin, name: c.name as string | undefined }));
    const all = [...listed, ...known.filter((h) => !this.configured.has(h.origin)).map((h) => ({ origin: h.origin, name: h.label ?? h.name }))];
    let origin: string | undefined;
    try {
      origin = originOf(link.host);
    } catch {
      origin = undefined;
    }
    const byOrigin = all.find((h) => h.origin === origin || h.origin === link.host.replace(/\/+$/, ""));
    const byName = all.filter((h) => h.name?.toLowerCase() === link.host.toLowerCase());
    if (!byOrigin && byName.length > 1) return m.link_ambiguous_host({ name: link.host });
    const hit = byOrigin ?? byName[0];
    if (hit) return { target: this.targetOf(hit.origin), name: hit.name ?? bare(hit.origin), address: bare(hit.origin) };
    if (!origin) return m.link_unknown_host({ name: link.host });
    return { target: this.targetOf(link.host), name: link.name ?? bare(origin), address: bare(origin) };
  }

  private followLink(yes: boolean): void {
    const link = this.link;
    this.link = null;
    if (!yes || !link) return this.home();
    this.launchOnReady = link.launch ?? null;
    const origin = typeof link.target === "string" ? originOf(link.target) : link.target.api.replace(/\/+$/, "");
    this.pin = link.fp ? { origin, fp: link.fp } : null;
    void this.engine.connect(link.target, this.pinned(origin));
  }

  /** Reach `origin` again: a retry, or the connection after a pairing. */
  private reconnect(origin: string): void {
    void this.engine.connect(this.targetOf(origin), this.pinned(origin));
  }

  /** What a connect to `origin` must check: the fingerprint a link pinned it to, if any. */
  private pinned(origin: string): { expectFingerprint?: string } {
    return this.pin?.origin === origin ? { expectFingerprint: this.pin.fp } : {};
  }

  /** A link to this host, pinned to its fingerprint when this browser has paired with it. The
   *  clipboard gives nothing back to look at, so the interface says what happened. */
  private async copyLink(origin: string): Promise<void> {
    const fingerprint = this.engine.knownHosts().find((h) => h.origin === origin)?.fingerprint;
    try {
      await navigator.clipboard.writeText(linkFor(location.href, origin, fingerprint));
      this.ui.notify(m.hostcard_link_copied());
    } catch (e) {
      console.warn("punktfunk: copy link", e);
      this.ui.notify(m.hostcard_link_copy_failed(), "error");
    }
  }

  /**
   * Wake a host through the page's server, which sits on its network where a browser cannot send
   * a magic packet. Then ask after it every few seconds, as it boots, until it answers or a minute
   * has gone. `false` when no packet went out: refused or failed, which the page has said.
   */
  private async wake(origin: string): Promise<boolean> {
    const url = this.configured.get(origin)?.wake;
    if (!url) return false;
    if (this.waking.has(origin)) return true;
    this.waking.add(origin);
    this.redrawLists();
    try {
      const r = await serverFetch()(url, { method: "POST" });
      if (r.status === 403 || r.status === 429) {
        const why = r.status === 429 ? m.browser_too_many() : m.browser_wake_unpaired({ host: this.nameOf(origin) });
        this.ui.notify(why, "error");
        return false;
      }
      if (!r.ok) throw new Error(`wake refused (${r.status})`);
      let up = false;
      for (let tries = 0; tries < 20 && !up; tries++) {
        await new Promise((done) => setTimeout(done, 3000));
        const now = await reach(origin);
        this.reachCache.set(origin, { reach: now, at: Date.now() });
        up = now === "ok";
      }
      if (!up) this.ui.notify(m.browser_wake_timeout({ host: this.nameOf(origin) }), "error");
      return true;
    } catch (e) {
      console.warn("punktfunk: wake", e);
      this.ui.notify(m.browser_wake_failed({ host: this.nameOf(origin) }), "error");
      return false;
    } finally {
      this.waking.delete(origin);
      this.redrawLists();
    }
  }

  /** Forget a host. From the trust screen this is "forget and pair again", so the reconnect
   *  follows — with the stored fingerprint gone, the next connection is a first one, held to
   *  the fingerprint of a link that brought it here. */
  private forget(origin: string): void {
    const reconnect = this.screen.kind === "trust" && this.screen.origin === origin;
    this.reachCache.delete(origin);
    this.screens.delete(origin);
    if (this.libraryFor === origin) this.clearLibrary();
    const pin = this.pin;
    this.engine.forget(origin);
    if (!reconnect) return this.redrawLists();
    // Forgetting disconnects, which drops a link's pin; pairing again is still held to it.
    this.pin = pin;
    this.reconnect(origin);
  }

  // --- the library ---------------------------------------------------------------------
  private async openLibrary(s: Ready): Promise<void> {
    if (this.libraryFor !== s.origin) this.clearLibrary();
    this.libraryFor = s.origin;
    this.libraryLoading = true;
    this.redrawLibrary();
    try {
      const entries = [...(await s.host.library())];
      if (this.libraryFor !== s.origin) return;
      this.entries = entries;
      this.libraryError = undefined;
      this.libraryAt = Date.now();
    } catch (e) {
      if (this.libraryFor !== s.origin) return;
      // A failure keeps no clock: opening the host again asks again.
      this.libraryAt = 0;
      if (e instanceof VersionSkew) {
        return this.show({
          kind: "error",
          head: m.browser_skew_title(),
          text: `${sentence(e.message)} ${m.browser_skew_hint()}`,
        });
      }
      // The stream still works without a library, so this is a line on the page rather than a
      // dead end.
      this.libraryError = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.libraryFor === s.origin) this.libraryLoading = false;
    }
    this.redrawLibrary();
    // Art after the grid, per entry: the grid should appear before its covers do.
    for (const entry of this.entries) {
      const art = entry.art.portrait ?? entry.art.header;
      if (!art || this.art.has(entry.id)) continue;
      void s.host
        .art(art)
        .then((url) => {
          if (!url || this.libraryFor !== s.origin) return;
          this.art.set(entry.id, url);
          this.redrawLibrary();
        })
        // A cover that cannot load leaves its tile's placeholder.
        .catch(() => {});
    }
  }

  /** What the host is running, polled while its library is connected: the event stream is not
   *  on this browser's lane, and five seconds is plenty for a grid someone is looking at. */
  private watchRunning(s: Ready): void {
    if (this.pollingFor === s.origin) return;
    clearTimeout(this.statusTimer);
    this.pollingFor = s.origin;
    const poll = async () => {
      const now = this.engine.current;
      if (now.kind !== "ready" || now.origin !== s.origin) {
        if (this.pollingFor === s.origin) this.pollingFor = null;
        return;
      }
      try {
        const st = await now.host.status();
        // Another shelf took the poll while this one was out: its answer is not news here.
        if (this.pollingFor !== s.origin) return;
        // Anything not exited is up, as on every client; this device's own launch leads.
        const up = st.games.filter((g) => g.state !== "exited");
        const live = up.find((g) => g.endable && g.app_id) ?? up[0];
        this.running = live?.title;
        this.runningId = live?.app_id ?? undefined;
        this.runningEndable = !!live?.endable && !!live.app_id;
        this.redrawLibrary();
      } catch {
        // A failed poll is not news; the next one will say.
      }
      this.statusTimer = window.setTimeout(() => void poll(), 5000);
    };
    void poll();
  }

  private stopPolling(): void {
    clearTimeout(this.statusTimer);
    this.pollingFor = null;
  }

  private showLibrary(): void {
    const origin = this.currentShelf();
    const s = this.engine.current;
    const connected = s.kind === "ready" && s.origin === origin;
    const mine = origin !== null && this.libraryFor === origin;
    const shelves = this.paired();
    this.show({
      kind: "library",
      origin,
      shelves,
      entries: mine ? this.entries : [],
      art: this.art,
      busy: this.quiet || (connected && (!mine || this.libraryLoading)),
      ...(origin ? { host: this.nameOf(origin) } : {}),
      ...(!connected && !this.quiet ? { offline: true } : {}),
      ...(mine && this.running ? { running: this.running } : {}),
      ...(connected && this.tools ? { tools: this.tools } : {}),
      ...(mine ? this.resumable() : {}),
      ...(mine && connected && this.running && this.runningEndable ? { endable: true } : {}),
      ...(mine && this.endNotice ? { notice: this.endNotice } : {}),
      ...(mine && this.libraryError ? { error: m.browser_lib_load_failed_desktop({ why: sentence(this.libraryError) }) } : {}),
    });
    void this.probe(shelves.map((h) => h.origin));
  }

  private redrawLibrary(): void {
    if (this.screen.kind === "library") this.showLibrary();
  }

  // --- the host sheet ---------------------------------------------------------------------
  /** The shelf's host, when the library is connected to it. */
  private shelfHost(): Host | null {
    const s = this.engine.current;
    return s.kind === "ready" && s.origin === this.currentShelf() ? s.host : null;
  }

  /** Open the sheet and ask the host what this device may do to it. */
  private async openTools(on: boolean): Promise<void> {
    this.tools = on ? { actions: [], busy: true } : null;
    this.redrawLibrary();
    const host = this.shelfHost();
    if (!on || !host) return;
    try {
      // `display.next` moves a live stream to another monitor: nothing to offer from the library.
      const actions = (await host.actions()).filter((a) => a.id !== "display.next");
      this.setTools({
        busy: false,
        actions: actions.map((a) => ({
          id: a.id,
          title: a.title,
          danger: a.danger,
          enabled: a.available && a.permitted,
          ...(a.available && a.permitted
            ? {}
            : { reason: a.available ? "This device's access does not include it" : (apiText(a["unavailable_code"] as string | undefined, a["unavailable_params"] as Record<string, string> | undefined, a.unavailable_reason) ?? "Not on this host") }),
        })),
      });
    } catch (e) {
      this.setTools({ busy: false, note: sentence(e instanceof Error ? e.message : String(e)) });
    }
  }

  private async hostAction(id: string): Promise<void> {
    const host = this.shelfHost();
    if (!host || !this.tools) return;
    this.setTools({ busy: true });
    try {
      await host.invoke(id);
      this.setTools({ busy: false, note: "Done. The host is doing it now, and ends every stream first." });
    } catch (e) {
      this.setTools({ busy: false, note: sentence(e instanceof Error ? e.message : String(e)) });
    }
  }

  private async sendLog(): Promise<void> {
    const host = this.shelfHost();
    if (!host || !this.tools) return;
    this.setTools({ busy: true });
    try {
      const id = await host.uploadLog(pageLog());
      this.setTools({ busy: false, note: `Sent. The host's console lists it under this device as ${id}.` });
    } catch (e) {
      this.setTools({ busy: false, note: sentence(e instanceof Error ? e.message : String(e)) });
    }
  }

  private setTools(patch: Partial<HostTools>): void {
    if (!this.tools) return;
    this.tools = { ...this.tools, ...patch };
    this.redrawLibrary();
  }

  /** End the title this device launched: the stream's own over a live picture, else the shelf's
   *  running one. A game that is gone ends the stream as End stream does; a refusal says why. */
  private async endGame(): Promise<void> {
    const s = this.engine.current;
    if (s.kind === "streaming") {
      const host = this.engine.hostApi();
      const game = this.streamGame;
      if (!host || !game) return;
      this.menuOpen = false;
      const outcome = await host.endGame(game.appId);
      if (gameGone(outcome)) return this.engine.leave(true);
      clearTimeout(this.streamNoticeTimer);
      this.streamNotice = gameEndNotice(outcome, game.title);
      this.streamNoticeTimer = window.setTimeout(() => {
        this.streamNotice = undefined;
        this.render(this.engine.current);
      }, STREAM_NOTICE_MS);
      return this.render(this.engine.current);
    }
    const host = this.shelfHost();
    const shelf = this.libraryFor;
    const [id, title] = [this.runningId, this.running];
    if (!host || !id || !title) return;
    const outcome = await host.endGame(id);
    // Another shelf opened meanwhile: the answer is not about its titles.
    if (this.libraryFor !== shelf) return;
    this.endNotice = gameEndNotice(outcome, title);
    if (gameGone(outcome)) {
      this.running = undefined;
      this.runningId = undefined;
      this.runningEndable = false;
    }
    this.redrawLibrary();
  }

  /** Ask the host what this stream plays: a row this device may end with a live session. */
  private async findStreamGame(): Promise<void> {
    const host = this.engine.hostApi();
    if (!host || this.engine.current.kind !== "streaming") return;
    try {
      const st = await host.status();
      const g = st.games.find((r) => r.endable && r.session_id !== undefined && r.app_id);
      this.streamGame = g?.app_id ? { appId: g.app_id, title: g.title } : null;
    } catch {
      // Unanswered, the menu keeps what it last knew.
    }
    this.render(this.engine.current);
  }

  /** The running title's entry, by library id where the host gave one, else by title. */
  private resumable(): { resume?: LibraryEntry } {
    if (!this.running) return {};
    const entry =
      this.entries.find((e) => this.runningId !== undefined && e.id === this.runningId) ??
      this.entries.find((e) => e.title === this.running);
    return entry ? { resume: entry } : {};
  }

  private clearLibrary(): void {
    this.stopPolling();
    this.tools = null;
    this.libraryFor = null;
    this.libraryLoading = false;
    this.libraryAt = 0;
    this.libraryError = undefined;
    this.running = undefined;
    this.runningId = undefined;
    this.runningEndable = false;
    this.endNotice = undefined;
    this.entries = [];
    for (const url of this.art.values()) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
    this.art.clear();
  }

  // --- settings and the window ------------------------------------------------------------
  /** Push the tunable half of the settings at the engine, or only the keys `changed` names: a
   *  setting pushed again would undo what a shortcut switched mid-stream. The rest — size, rate,
   *  bitrate — is read when a stream starts, because it is `StreamOptions` and not an engine
   *  property. */
  private applyPrefs(changed?: Partial<Settings>): void {
    const all: Parameters<Engine["configure"]>[0] = {
      videoBackend: this.prefs.videoBackend,
      audio: this.prefs.audio,
      captureInput: this.prefs.captureInput,
      pointer: this.prefs.pointer,
      deadzone: this.prefs.deadzone,
      statsTier: this.prefs.statsTier,
      advancedStats: this.prefs.advancedStats,
      codec: this.prefs.codec,
      hdr: this.prefs.hdr,
      invertScroll: this.prefs.invertScroll,
      shortcuts: this.prefs.shortcuts,
    };
    this.engine.configure(changed ? Object.fromEntries(Object.entries(all).filter(([k]) => k in changed)) : all);
  }

  /**
   * Follow the window, when asked to. Debounced hard, and no-op sizes are dropped before the
   * timer is even armed: a `Reconfigure` costs the host a pipeline rebuild, so the only ones
   * worth sending are the ones that change something.
   */
  private watchSize(): void {
    const observer = new ResizeObserver(() => {
      // A fixed resolution hides the toggle, and so must turn it off.
      if (!this.prefs.resizeStream || this.prefs.width !== 0) return;
      const now = this.engine.current;
      if (now.kind !== "streaming") return;
      const [width, height] = size(this.uiCanvas);
      if (width === now.stats.width && height === now.stats.height) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        // Re-checked after the wait: the window may have gone back to where it started, and
        // the session may have ended while the timer ran.
        const then = this.engine.current;
        if (then.kind !== "streaming") return;
        const [w, h] = size(this.uiCanvas);
        if (w === then.stats.width && h === then.stats.height) return;
        this.engine.reconfigure(w, h, this.prefs.fps);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(this.uiCanvas);
  }

  /** Stream `entry`, or the desktop, from `origin` — the open shelf unless named. A host that is
   *  not the one connected is reached first, and the stream starts once it is ready. Called from
   *  a click, which is the one moment the browser allows fullscreen. */
  private play(entry?: LibraryEntry, origin = this.currentShelf(), profile?: string): void {
    if (!origin) return;
    if (this.web && this.prefs.fullscreen && !document.fullscreenElement) {
      this.fullscreened = true;
      this.engine.fullscreen(true);
    }
    const s = this.engine.current;
    if (s.kind === "ready" && s.origin === origin) return this.start(entry, profile);
    this.quiet = false;
    this.resumeOnReady = { ...(entry ? { entry } : {}), ...(profile !== undefined ? { profile } : {}) };
    void this.engine.connect(this.targetOf(origin));
  }

  /**
   * A packaged page is an app the set puts behind Home or into standby, and a stream into a
   * panel nobody sees must end: the host keeps the game, and the library offers Resume. Home
   * fires `visibilitychange`; standby fires nothing and freezes the page, so a frame loop that
   * skips `STANDBY_GAP_MS` is read as the set having slept.
   */
  private watchSleep(): void {
    const asleep = () => {
      const s = this.engine.current;
      if (s.kind === "streaming" || s.kind === "starting") this.engine.leave();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") asleep();
    });
    let last = performance.now();
    const tick = (now: number) => {
      if (now - last > STANDBY_GAP_MS) asleep();
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Back to a window, if this page went fullscreen for the stream that just ended. */
  private windowed(): void {
    if (!this.fullscreened) return;
    this.fullscreened = false;
    this.engine.fullscreen(false);
  }

  /** Start a stream on the host that is ready. The web shell passes the profile gate first; the
   *  console runs its own and hands the pick in as `profile`, empty for none. */
  private start(entry?: LibraryEntry, profile?: string): void {
    const s = this.engine.current;
    if (!this.web || s.kind !== "ready") return this.dial(entry, profile || undefined);
    void this.askProfile(s.origin, s.host, entry ? { entry } : {});
  }

  private dial(entry?: LibraryEntry, profile?: string): void {
    this.gate = null;
    this.endNotice = undefined;
    this.lastPlay = { ...(entry ? { entry } : {}), ...(profile ? { profile } : {}) };
    this.engine.startStream({ ...this.streamOptions(), ...(entry ? { launch: entry } : {}), ...(profile ? { profile } : {}) });
  }

  // --- the profile gate ----------------------------------------------------------------
  // On a box with profiles a stream names one, and the seat it plays on must be up before the
  // dial: the host refuses a seat that isn't. Asked, woken and waited on as the native clients
  // do it (`profiles.ts`).

  /**
   * Who plays on `origin`, then its seat. `play` is the stream waiting on the answer; `null` is
   * the host card's Switch profile, which only saves the pick. A list that fails or is late
   * dials as before, with the saved pick.
   */
  private async askProfile(origin: string, host: Host, play: { entry?: LibraryEntry } | null): Promise<void> {
    const gate: Gate = { origin, host, play, rows: [], screen: { kind: "connecting", origin, phase: play ? "starting" : "connecting" } };
    this.gate = gate;
    this.render(this.engine.current);
    const saved = hosts.all()[origin]?.profile ?? null;
    let listed: ReadonlyArray<ListedProfile> | null | undefined;
    try {
      listed = await within(host.profiles(), PROFILES_WAIT_MS);
    } catch {
      listed = undefined;
    }
    if (this.gate !== gate) return;
    if (listed === undefined && play) return this.dial(play.entry, saved?.id);
    gate.rows = listed ?? [];
    const decision = play ? pickerDecision(listed ?? null, saved) : null;
    if (decision && !decision.picker) {
      hosts.setProfile(origin, decision.remember);
      return void this.settleSeat(gate, decision.send);
    }
    const picker: Extract<Screen, { kind: "profiles" }> = {
      kind: "profiles",
      origin,
      host: this.nameOf(origin),
      cards: gate.rows.map((p) => cardOf(p, this.pictures)),
      ...(saved ? { saved: saved.id } : {}),
      ...(decision?.gone ? { gone: decision.gone } : {}),
      ...(listed === undefined ? { error: m.profile_load_failed() } : {}),
    };
    this.gateShow(gate, picker);
    void this.readPictures(gate, picker);
  }

  /** Reads the pictures `gate`'s picker lacks, then shows them. One that won't load stays initials. */
  private async readPictures(gate: Gate, picker: Extract<Screen, { kind: "profiles" }>): Promise<void> {
    const missing = gate.rows.flatMap((p) => (p.avatar?.startsWith("/") && !this.pictures.has(p.avatar) ? [p.avatar] : []));
    const read = await Promise.all(missing.map((url) => gate.host.art(url).catch(() => null)));
    read.forEach((shown, i) => shown && this.pictures.set(missing[i]!, shown));
    if (gate.screen === picker && read.some(Boolean)) {
      this.gateShow(gate, { ...picker, cards: gate.rows.map((p) => cardOf(p, this.pictures)) });
    }
  }

  private pickProfile(id: string): void {
    const gate = this.gate;
    const row = gate?.rows.find((p) => p.id === id);
    if (!gate || !row) return;
    hosts.setProfile(gate.origin, pickOf(row));
    if (!gate.play) return this.cancelGate();
    void this.settleSeat(gate, id);
  }

  /** Dial as `id` once its seat can take the stream: now for a profile without a seat or one
   *  that is up, after a wake and a wait for one that is stopped, never for one that can't. */
  private async settleSeat(gate: Gate, id: string | undefined): Promise<void> {
    const row = id ? gate.rows.find((p) => p.id === id) : undefined;
    let next = row ? seatGate(row) : ({ kind: "dial" } as const);
    if (!row || next.kind === "dial") return this.dial(gate.play?.entry, id);
    const name = row.display_name;
    if (next.kind === "wake") {
      this.gateShow(gate, { kind: "seat", origin: gate.origin, title: wakingLine(name) });
      try {
        await gate.host.wakeProfile(row.id);
      } catch (e) {
        if (this.gate === gate) this.gateFailed(gate, wakeFailed(name, statusOf(e), e instanceof Error ? e.message : String(e)));
        return;
      }
    }
    // No timeout, as on every client: the sheet's Cancel is the way out.
    for (;;) {
      if (next.kind === "refuse") return this.gateFailed(gate, next.line);
      if (this.gate !== gate) return;
      this.gateShow(gate, {
        kind: "seat",
        origin: gate.origin,
        title: wakingLine(name),
        ...(next.kind === "wait" && next.detail ? { detail: next.detail } : {}),
      });
      await new Promise((done) => setTimeout(done, SEAT_POLL_MS));
      let rows: ReadonlyArray<ListedProfile> | null;
      try {
        rows = await gate.host.profiles();
      } catch {
        // A failed read keeps waiting.
        continue;
      }
      if (this.gate !== gate) return;
      const now = rows?.find((p) => p.id === row.id);
      // A profile the list dropped is the host's to refuse.
      next = now ? seatGate(now) : { kind: "dial" };
      if (next.kind === "dial") return this.dial(gate.play?.entry, row.id);
    }
  }

  private gateShow(gate: Gate, screen: Screen): void {
    if (this.gate !== gate) return;
    gate.screen = screen;
    this.render(this.engine.current);
  }

  private gateFailed(gate: Gate, line: string): void {
    this.gateShow(gate, { kind: "error", head: m.browser_gate_failed_title(), text: sentence(line) });
  }

  private cancelGate(): void {
    this.gate = null;
    this.render(this.engine.current);
  }

  /** The host card's Switch profile: the picker, after a connect when the host is not ready. */
  private switchProfile(origin: string): void {
    const s = this.engine.current;
    if (s.kind === "ready" && s.origin === origin) return void this.askProfile(origin, s.host, null);
    this.switchOnReady = origin;
    void this.engine.connect(this.targetOf(origin));
  }

  /** The desktop stream the settings and the window ask for. */
  private streamOptions(): { width: number; height: number; fps: number; bitrateKbps: number } {
    const [fit, fitHeight] = size(this.uiCanvas);
    return {
      width: this.prefs.width || fit,
      height: this.prefs.height || fitHeight,
      fps: this.prefs.fps,
      bitrateKbps: this.prefs.bitrateKbps,
    };
  }
}

/** A stream live or on its way: what a settings dialog sits over, and what a drop ends. */
const live = (kind: EngineState["kind"]): boolean => kind === "streaming" || kind === "starting";

/** A stream asked for: the title (unset: the desktop), and the profile the console picked. */
interface Play {
  entry?: LibraryEntry;
  profile?: string;
}

/** How long the profile list may take before a stream dials with the saved pick instead. */
const PROFILES_WAIT_MS = 5000;

/** A stream held at the profile gate: its host and what it plays (`null`: only a pick to save),
 *  the box's list, and the screen it shows meanwhile. */
interface Gate {
  origin: string;
  host: Host;
  play: { entry?: LibraryEntry } | null;
  rows: ReadonlyArray<ListedProfile>;
  screen: Screen;
}

/** `p`, or a rejection once `ms` have passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** A picker card for `p`, with its picture if `pictures` has it. An accent that isn't `#RRGGBB`
 *  falls back to the brand's. */
function cardOf(p: ListedProfile, pictures: ReadonlyMap<string, string>): ProfileCard {
  const note = profileNote(p);
  const picture = p.avatar ? pictures.get(p.avatar) : undefined;
  return {
    id: p.id,
    name: p.display_name,
    initials: initials(p.display_name),
    ...(picture ? { picture } : {}),
    ...(p.accent && /^#[0-9a-f]{6}$/i.test(p.accent) ? { accent: p.accent } : {}),
    ...(note ? { note } : {}),
  };
}

/** The shelf a previous visit left open, if storage allows. */
function readShelf(): string | null {
  try {
    return localStorage.getItem(SHELF_KEY);
  } catch {
    return null;
  }
}

/** Why a link was refused, as a sentence. */
const LINK_ERRORS: Record<Exclude<ReturnType<typeof parseLink>, PageLink | null>, () => string> = {
  "missing-host": () => m.link_error_missing_host_ref(),
  "too-long": () => m.link_error_too_long(),
  "control-char": () => m.link_error_malformed(),
  "bad-fingerprint": () => m.link_error_bad_fingerprint(),
  "bad-launch": () => m.link_error_bad_launch_id(),
};

/** The engine speaks in lowercase fragments, as logs do; a screen speaks in sentences. */
function sentence(message: string): string {
  const m = message.trim();
  if (!m) return m;
  const s = m[0]!.toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** An origin without its scheme. Every screen shows a host this way; nothing gains from the
 *  `https://` that `originOf` put there. */
const bare = (origin: string): string => origin.replace(/^https:\/\//, "");

/** The stream mode from the canvas's box: device pixels capped at 2×, and always even.
 *
 * H.264/HEVC are 4:2:0 — one chroma sample per 2×2 luma block — so a codec has no valid chroma
 * grid for an odd width or height, and the host refuses one. The window is whatever size it is,
 * so round each dimension down to even here rather than send the host something it must reject.
 * Measured only: the console sizes the canvas's buffer itself, and a write here would clear the
 * frame it just drew. */
function size(canvas: HTMLCanvasElement): [number, number] {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const even = (px: number) => Math.max(2, Math.floor(px) & ~1);
  return [even(canvas.clientWidth * dpr), even(canvas.clientHeight * dpr)];
}

/**
 * Which interface to wear.
 *
 * `?ui=console` asks for the gamepad shell — the same `pf-console-ui` every other client draws,
 * which is what a TV or a controller wants, and what a packaged page is: an app on a TV, held by
 * a remote, with no address bar to ask. Anything else gets the web-native one on React, because
 * a browser is usually held by a mouse and a keyboard and the console cannot offer a text field.
 */
function pickUi(engine: Engine, uiCanvas: HTMLCanvasElement): Ui {
  const shell = new WebShell(document.body);
  const wanted = new URLSearchParams(location.search).get("ui");
  return wanted === "console" || packaged() ? new ConsoleUi(engine, uiCanvas, shell) : shell;
}

/** A host as a packaged page reaches it: the API over the plane's tunnel, the plane at the
 *  address typed. An address that is not one stays a string, so the engine says so. */
function tunnelTarget(address: string): string | HostTarget {
  try {
    const api = originOf(address);
    return { api, plane: new URL(api).hostname, tunnel: true };
  } catch {
    return address;
  }
}

/** A typed IP address as the page's server reaches it (`/a/<ip:port>/`, the bridge at
 *  `/wa/<ip:port>`). Names stay direct: the server proxies private IP addresses only. */
function throughServer(address: string): HostTarget | null {
  let url: URL;
  try {
    url = new URL(originOf(address));
  } catch {
    return null;
  }
  const ip = url.hostname;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !/^\[[0-9a-f:.]+\]$/i.test(ip)) return null;
  // The page's own server is not a host; routing it through itself only finds the page again.
  if (url.host === location.host) return null;
  return { api: new URL(`a/${ip}:${url.port}`, location.href).href, plane: ip, bridge: `wa/${ip}:${url.port}` };
}

/** The target a server route (`…/a/<ip:port>`) stands for, or `null` for any other address. */
function routeOf(address: string): HostTarget | null {
  const base = new URL("a/", location.href).href;
  if (!address.startsWith(base)) return null;
  const ipPort = address.slice(base.length).split("/")[0] ?? "";
  const plane = ipPort.replace(/:\d+$/, "");
  return plane ? { api: address.replace(/\/+$/, ""), plane, bridge: `wa/${ipPort}` } : null;
}

/** Set by `vite.config.ts` when the dev server proxies a host; absent in a build. */
declare const __PF_TRANSPORT_HOST__: string | undefined;

// Before anything logs, so a log sent to a host has the whole visit in it.
captureLog();

const uiCanvas = document.getElementById("pf-ui") as HTMLCanvasElement;
const videoCanvas = document.getElementById("pf-video") as HTMLCanvasElement;

try {
  const engine = await Engine.create({
    videoCanvas,
    uiCanvas,
    ...(__PF_TRANSPORT_HOST__ ? { transportHost: __PF_TRANSPORT_HOST__ } : {}),
  });
  const server = (await readConfig(serverFetch(), location.href)) ?? { listed: new Map(), viaServer: false };
  const ui = pickUi(engine, uiCanvas);
  new App(engine, ui, ui instanceof WebShell, uiCanvas, server);
} catch (e) {
  // Before there is an engine there is no interface to say this on; the one sheet the page
  // carries for exactly this case does.
  const shell = new WebShell(document.body);
  shell.mount({ ...noop, back: () => history.back(), retry: () => location.reload() });
  shell.render({
    kind: "error",
    head: "This browser can't run the client",
    text: sentence(e instanceof Error ? e.message : String(e)),
    retry: true,
  });
}

/** How long the exit hint stays up; the page's keyframes fade it out over the last tenth. */
const EXIT_HINT_MS = 6000;

/** The quick menu's last line, from its live bindings: the remote's Back and the pad on a TV,
 *  the keys and the pad elsewhere. None when one of those is unbound. */
function menuHintText(s: Shortcuts): string | undefined {
  const line = (p: Press | undefined) => p && (p.hold ? m.controls_hold({ keys: p.keys }) : p.keys);
  const pad = line(s.hint("ring", "pad"));
  const keys = line(s.hint("ring", "key"));
  if (!pad) return undefined;
  if (packaged()) return m.browser_ring_menu_hint_tv({ remote: "Back", pad });
  return keys && m.browser_ring_menu_hint({ keys, pad });
}

/** How to leave with the input in hand: End stream's pad trigger with a controller connected,
 *  the menu on a touchscreen, its key otherwise, the menu when nothing is bound. */
function exitHintText(s: Shortcuts): string {
  const pad = s.hint("end_stream", "pad");
  if (pad && navigator.getGamepads?.().some((g) => g?.mapping === "standard")) {
    return pad.hold ? m.notice_exit_hold({ keys: pad.keys }) : m.notice_exit_keys({ keys: pad.keys });
  }
  const key = s.hint("end_stream", "key");
  if (!key || matchMedia("(pointer: coarse)").matches) return m.browser_exit_menu();
  return m.notice_exit_keys({ keys: key.keys });
}

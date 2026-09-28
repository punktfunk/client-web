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

import {
  captureLog,
  Engine,
  type Host,
  type EngineState,
  gameEndNotice,
  gameGone,
  type HostTarget,
  hosts,
  originOf,
  type LibraryEntry,
  linkFor,
  type PageLink,
  pageLog,
  parseLink,
  type Reach,
  reach,
  type Settings,
  settings,
  VersionSkew,
} from "@punktfunk/stream";
import { ConsoleUi } from "./ui/console.ts";
import { noop, WebShell } from "./ui/shell.tsx";
import type { HostCard, HostTools, Screen, Tab, Ui } from "./ui/types.ts";

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
  /** What the host said when End game last ran from the library. */
  private endNotice: string | undefined;
  /** The title this device launched that the live stream plays, asked for when the menu opens. */
  private streamGame: { appId: string; title: string } | null = null;
  /** What the host said when End game was refused mid-stream, for a few seconds. */
  private streamNotice: string | undefined;
  /** When the live stream began, while its exit hint is up; `0` once the hint is gone. */
  private hintSince = 0;
  private hintTimer = 0;
  private wasStreaming = false;
  private streamNoticeTimer = 0;
  /** The origin whose running title is being polled. */
  private pollingFor: string | null = null;
  /** What the last stream played (`entry` unset: the desktop), and what to start again once the
   *  host is ready after a stream that dropped. */
  private lastPlay: { entry?: LibraryEntry } | null = null;
  private resumeOnReady: { entry?: LibraryEntry } | null = null;
  /** The stream that dropped into the error on screen, which "Try again" brings back. */
  private dropped: { entry?: LibraryEntry } | null = null;
  private statusTimer = 0;
  /** Is the add-a-host sheet open? Forced on when there is no card to click instead. */
  private adding = false;
  /** What a probe last said about each known host, and when. */
  private readonly reachCache = new Map<string, { reach: Reach; at: number }>();
  /** Hosts a wake went to that have not answered yet. */
  private readonly waking = new Set<string>();
  private probing = false;
  /** A connect link the page opened with, until it is answered, and the title it asked for. */
  private link: { target: string | HostTarget; fp?: string; launch?: string } | null = null;
  private launchOnReady: string | null = null;
  /** The settings page, or its dialog over a live stream. */
  private settingsOpen = false;
  /** The quick menu over a live picture; closed whenever the stream is not. */
  private menuOpen = false;
  private prefs: Settings = settings.get();
  private resizeTimer = 0;
  /** This page went fullscreen for a stream, and goes back when the stream's page returns. */
  private fullscreened = false;

  constructor(
    private readonly engine: Engine,
    private readonly ui: Ui,
    /** The web shell, rather than the gamepad console: only it has tabs to keep. */
    private readonly web: boolean,
    private readonly uiCanvas: HTMLCanvasElement,
    /** The hosts the page's own server proxies, by the API origin the engine keys them under. */
    private readonly configured: Map<string, Configured>,
    /** Whether that server also proxies a host typed here by its IP address. */
    private readonly viaServer: boolean,
  ) {
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
        if ("origin" in s && s.origin) void engine.connect(this.targetOf(s.origin));
      },
      back: () => engine.disconnect(),
      play: (entry) => this.play(entry),
      forget: (origin) => this.forget(origin),
      followLink: (yes) => this.followLink(yes),
      copyLink: (origin) => void this.copyLink(origin),
      openTools: (on) => void this.openTools(on),
      hostAction: (id) => void this.hostAction(id),
      endGame: () => void this.endGame(),
      sendLog: () => void this.sendLog(),
      wake: (origin) => void this.wake(origin),
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
      openSettings: (on) => {
        this.settingsOpen = on;
        this.render(engine.current);
      },
      setSettings: (patch) => {
        this.prefs = settings.set(patch);
        this.applyPrefs();
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
    this.applyPrefs();
    this.watchSize();
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
    if (s.kind !== "streaming") {
      this.menuOpen = false;
      this.streamGame = null;
    }
    // The exit hint: armed on the edge into a stream, dropped by its timer or the stream's end.
    const streaming = s.kind === "streaming";
    if (streaming && !this.wasStreaming && this.prefs.exitHint) {
      this.hintSince = Date.now();
      clearTimeout(this.hintTimer);
      this.hintTimer = window.setTimeout(() => {
        this.hintSince = 0;
        this.render(this.engine.current);
      }, EXIT_HINT_MS);
    } else if (!streaming) {
      this.hintSince = 0;
    }
    this.wasStreaming = streaming;
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
        return this.web && this.tab === "library" ? this.showLibrary() : this.home();
      case "bad-address":
        // The field stays in front: what was typed is wrong and this is where it is fixed.
        this.adding = true;
        this.tab = "hosts";
        return this.home(sentence(s.message));
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
          head: "No answer",
          text: `Nothing responded at ${bare(s.origin)}. Check the address, and that the host is running.`,
          retry: true,
        });
      case "untrusted":
        return this.show({ kind: "trust", origin: s.origin, reason: sentence(s.reason) });
      case "connecting":
        return this.show({ kind: "connecting", origin: s.origin, phase: "connecting" });
      case "needs-pairing":
        return this.show({ kind: "pair", origin: s.origin, mode: "first" });
      case "pairing":
        return this.show({ kind: "pair", origin: s.origin, mode: "first", busy: true });
      case "awaiting-approval":
        return this.show({ kind: "waiting", origin: s.origin, name: s.name });
      case "paired": {
        this.show({ kind: "pair", origin: s.origin, mode: "first", busy: true });
        // The host closes after the ceremony, as it does for native clients; streaming is a
        // fresh connection.
        const origin = s.origin;
        setTimeout(() => void this.engine.connect(this.targetOf(origin)), 300);
        return;
      }
      case "pair-refused":
        return this.show({
          kind: "pair",
          origin: s.origin,
          mode: "first",
          error: s.reason ? sentence(s.reason) : "That PIN was refused.",
        });
      case "forgotten":
        return this.show({ kind: "pair", origin: s.origin, mode: "again" });
      case "ready": {
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
          queueMicrotask(() => this.start(resume.entry));
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
      case "streaming":
        return this.show({
          kind: "streaming",
          stats: { origin: s.origin, ...s.stats },
          diagnostics: s.stats.statsTier !== "off",
          menu: this.menuOpen,
          corner: this.prefs.hudPlacement,
          scale: this.prefs.statsScalePct / 100,
          ...(this.hintSince ? { exitHint: exitHintText() } : {}),
          ...(this.streamGame ? { endGame: this.streamGame.title } : {}),
          ...(this.streamNotice ? { notice: this.streamNotice } : {}),
        });
      case "error": {
        this.windowed();
        // Was a stream live, or starting, when this happened? Then trying again resumes it.
        const was = this.screen;
        const streamed = was.kind === "streaming" || (was.kind === "connecting" && was.phase === "starting");
        if (streamed) this.dropped = this.lastPlay;
        return this.show({
          kind: "error",
          head: s.skew
            ? "This host speaks a different version"
            : streamed
              ? "The stream stopped"
              : "Something went wrong",
          text: s.skew
            ? `${sentence(s.message)} Update the host, or this page, so the two agree.`
            : sentence(s.message),
          retry: !s.skew,
        });
      }
    }
  }

  // --- the tabs --------------------------------------------------------------------------
  /** A sidebar entry. A flow left half-way — a PIN, a certificate, an error — is cancelled; the
   *  library's own connection is kept, since it is what the Library tab shows. */
  private navigate(tab: Tab): void {
    const s = this.engine.current;
    if (tab === "settings") {
      this.settingsOpen = true;
      return this.render(s);
    }
    this.settingsOpen = false;
    this.tab = tab;
    this.link = null;
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
  private home(error?: string): void {
    // A link waiting for its answer stays in front of the probes that redraw this list.
    if (this.link) return;
    const cards = this.cards();
    this.show({
      kind: "home",
      hosts: cards,
      // Nothing to click means the field is the only way forward.
      adding: this.adding || cards.length === 0,
      ...(error ? { error } : {}),
    });
    void this.probe(cards.map((h) => h.origin));
  }

  /** Every host this page knows: the server's first, under the name it gives them; then the ones
   *  typed here. Each with what a probe last said about it. */
  private cards(): HostCard[] {
    const known = new Map(this.engine.knownHosts().map((h) => [h.origin, h]));
    const listed: HostCard[] = [
      ...[...this.configured].map(([origin, c]) => ({
        ...known.get(origin),
        origin,
        name: c.name,
        plane: c.plane,
        ...(c.wake ? { wake: c.wake, waking: this.waking.has(origin) } : {}),
      })),
      ...[...known.values()].filter((h) => !this.configured.has(h.origin)),
    ];
    return listed.map((h) => {
      const seen = this.reachCache.get(h.origin);
      return seen ? { ...h, reach: seen.reach } : h;
    });
  }

  /** The hosts with a pairing here: the shelves. */
  private paired(): HostCard[] {
    return this.cards().filter((h) => h.fingerprint);
  }

  /** What a host is called on screen. */
  private nameOf(origin: string): string {
    const h = this.cards().find((c) => c.origin === origin);
    return h?.label ?? h?.name ?? bare(origin);
  }

  /**
   * How to reach what a card or the address field names. A host the server lists, or one reached
   * through it before, keeps its route; a typed IP address goes through the server when it
   * offers that; anything else is dialled directly.
   */
  private targetOf(address: string): string | HostTarget {
    const listed = this.configured.get(address);
    if (listed) return listed;
    const known = this.engine.knownHosts().find((h) => h.origin === address);
    if (known?.plane) return { api: address, plane: known.plane };
    // Already a route through the server (a retry, a card): the address names its own plane.
    const route = routeOf(address);
    if (route) return route;
    const routed = this.viaServer ? throughServer(address) : null;
    if (!routed) return address;
    // A host tried directly before moves to the server route, name and pairing included.
    if (known) {
      const { origin: _old, ...record } = known;
      hosts.forget(address);
      hosts.remember(routed.api, { ...record, plane: routed.plane });
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
          this.reachCache.set(origin, { reach: await reach(origin), at: Date.now() });
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
      return this.show({ kind: "error", head: "That link can't be used", text: LINK_ERRORS[parsed] });
    }
    const found = this.resolveLink(parsed);
    if (typeof found === "string") return this.show({ kind: "error", head: "That link can't be used", text: found });
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
    if (!byOrigin && byName.length > 1) return `More than one host here is called “${link.host}”.`;
    const hit = byOrigin ?? byName[0];
    if (hit) return { target: this.targetOf(hit.origin), name: hit.name ?? bare(hit.origin), address: bare(hit.origin) };
    if (!origin) return `“${link.host}” is not an address or a host this page knows.`;
    return { target: this.targetOf(link.host), name: link.name ?? bare(origin), address: bare(origin) };
  }

  private followLink(yes: boolean): void {
    const link = this.link;
    this.link = null;
    if (!yes || !link) return this.home();
    this.launchOnReady = link.launch ?? null;
    void this.engine.connect(link.target, link.fp ? { expectFingerprint: link.fp } : {});
  }

  /** A link to this host, pinned to its fingerprint when this browser has paired with it. */
  private async copyLink(origin: string): Promise<void> {
    const fingerprint = this.engine.knownHosts().find((h) => h.origin === origin)?.fingerprint;
    try {
      await navigator.clipboard.writeText(linkFor(location.href, origin, fingerprint));
    } catch (e) {
      console.warn("punktfunk: copy link", e);
    }
  }

  /**
   * Wake a host through the page's server, which sits on its network where a browser cannot send
   * a magic packet. Then ask after it every few seconds, as it boots, until it answers or a minute
   * has gone.
   */
  private async wake(origin: string): Promise<void> {
    const url = this.configured.get(origin)?.wake;
    if (!url || this.waking.has(origin)) return;
    this.waking.add(origin);
    this.redrawLists();
    try {
      const r = await fetch(url, { method: "POST" });
      if (!r.ok) throw new Error(`wake refused (${r.status})`);
      for (let tries = 0; tries < 20; tries++) {
        await new Promise((done) => setTimeout(done, 3000));
        const now = await reach(origin);
        this.reachCache.set(origin, { reach: now, at: Date.now() });
        if (now === "ok") break;
      }
    } catch (e) {
      console.warn("punktfunk: wake", e);
    } finally {
      this.waking.delete(origin);
      this.redrawLists();
    }
  }

  /** Forget a host. From the trust screen this is "forget and pair again", so the reconnect
   *  follows — with the stored fingerprint gone, the next connection is a first one. */
  private forget(origin: string): void {
    const reconnect = this.screen.kind === "trust" && this.screen.origin === origin;
    this.reachCache.delete(origin);
    if (this.libraryFor === origin) this.clearLibrary();
    this.engine.forget(origin);
    if (reconnect) void this.engine.connect(this.targetOf(origin));
    else this.redrawLists();
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
    } catch (e) {
      if (this.libraryFor !== s.origin) return;
      if (e instanceof VersionSkew) {
        this.libraryLoading = false;
        return this.show({
          kind: "error",
          head: "This host speaks a different version",
          text: `${sentence(e.message)} Update the host, or this page, so the two agree.`,
        });
      }
      // The stream still works without a library, so this is a line on the page rather than a
      // dead end.
      this.libraryError = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.libraryFor === s.origin) {
        this.libraryLoading = false;
        this.libraryAt = Date.now();
      }
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
      ...(mine && this.libraryError ? { error: `${sentence(this.libraryError)} You can still stream the desktop.` } : {}),
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
            : { reason: a.available ? "This device's access does not include it" : (a.unavailable_reason ?? "Not on this host") }),
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
    const [id, title] = [this.runningId, this.running];
    if (!host || !id || !title) return;
    const outcome = await host.endGame(id);
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
  /** Push the tunable half of the settings at the engine. The rest — size, rate, bitrate — is
   *  read when a stream starts, because it is `StreamOptions` and not an engine property. */
  private applyPrefs(): void {
    this.engine.configure({
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
    });
  }

  /**
   * Follow the window, when asked to. Debounced hard, and no-op sizes are dropped before the
   * timer is even armed: a `Reconfigure` costs the host a pipeline rebuild, so the only ones
   * worth sending are the ones that change something.
   */
  private watchSize(): void {
    const observer = new ResizeObserver(() => {
      if (!this.prefs.resizeStream) return;
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
  private play(entry?: LibraryEntry, origin = this.currentShelf()): void {
    if (!origin) return;
    if (this.web && this.prefs.fullscreen && !document.fullscreenElement) {
      this.fullscreened = true;
      this.engine.fullscreen(true);
    }
    const s = this.engine.current;
    if (s.kind === "ready" && s.origin === origin) return this.start(entry);
    this.quiet = false;
    this.resumeOnReady = entry ? { entry } : {};
    void this.engine.connect(this.targetOf(origin));
  }

  /** Back to a window, if this page went fullscreen for the stream that just ended. */
  private windowed(): void {
    if (!this.fullscreened) return;
    this.fullscreened = false;
    this.engine.fullscreen(false);
  }

  /** Start a stream on the host that is ready. */
  private start(entry?: LibraryEntry): void {
    this.lastPlay = entry ? { entry } : {};
    this.engine.startStream({ ...this.streamOptions(), ...(entry ? { launch: entry } : {}) });
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

/** The shelf a previous visit left open, if storage allows. */
function readShelf(): string | null {
  try {
    return localStorage.getItem(SHELF_KEY);
  } catch {
    return null;
  }
}

/** Why a link was refused, as a sentence. */
const LINK_ERRORS: Record<Exclude<ReturnType<typeof parseLink>, PageLink | null>, string> = {
  "missing-host": "It does not say which host to connect to.",
  "too-long": "One of its parts is longer than a real link's.",
  "control-char": "It carries characters no real link does.",
  "bad-fingerprint": "Its host fingerprint is not one.",
  "bad-launch": "Its game id is not a valid one.",
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

/** The stream mode from the canvas: device pixels capped at 2×, and always even.
 *
 * H.264/HEVC are 4:2:0 — one chroma sample per 2×2 luma block — so a codec has no valid chroma
 * grid for an odd width or height, and the host refuses one. The window is whatever size it is,
 * so round each dimension down to even here rather than send the host something it must reject. */
function size(canvas: HTMLCanvasElement): [number, number] {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const even = (px: number) => Math.max(2, Math.floor(px) & ~1);
  const w = even(canvas.clientWidth * dpr);
  const h = even(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return [w, h];
}

/**
 * Which interface to wear.
 *
 * `?ui=console` asks for the gamepad shell — the same `pf-console-ui` every other client draws,
 * which is what a TV or a controller wants. Anything else gets the web-native one on React,
 * because a browser is usually held by a mouse and a keyboard and the console cannot offer a
 * text field.
 */
function pickUi(engine: Engine, uiCanvas: HTMLCanvasElement): Ui {
  const shell = new WebShell(document.body);
  const wanted = new URLSearchParams(location.search).get("ui");
  return wanted === "console" ? new ConsoleUi(engine, uiCanvas, shell) : shell;
}

/** A typed IP address as the page's server reaches it (`/a/<ip:port>/`). Names stay direct: the
 *  server proxies private IP addresses only. */
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
  return { api: new URL(`a/${ip}:${url.port}`, location.href).href, plane: ip };
}

/** The target a server route (`…/a/<ip:port>`) stands for, or `null` for any other address. */
function routeOf(address: string): HostTarget | null {
  const base = new URL("a/", location.href).href;
  if (!address.startsWith(base)) return null;
  const ipPort = address.slice(base.length).split("/")[0] ?? "";
  const plane = ipPort.replace(/:\d+$/, "");
  return plane ? { api: address.replace(/\/+$/, ""), plane } : null;
}

/** A host from the page server's `config.json`. `wake` is its wake URL when the server can. */
interface Configured extends HostTarget {
  name: string;
  wake?: string;
}

/**
 * The hosts `punktfunk-client-web-server` proxies, from its `config.json`. Any other server has
 * none (a dev server answers `index.html`, which does not parse), and the page falls back to
 * addresses typed here.
 */
async function configuredHosts(): Promise<{ listed: Map<string, Configured>; viaServer: boolean }> {
  try {
    const r = await fetch("./config.json", { cache: "no-store" });
    const c = (await r.json()) as {
      hosts?: Array<{ name: string; api: string; plane: string; wake?: string }>;
      add?: boolean;
    };
    const listed = new Map(
      (c.hosts ?? []).map((h): [string, Configured] => {
        const api = new URL(h.api, location.href).href.replace(/\/+$/, "");
        const wake = h.wake ? new URL(h.wake, location.href).href : undefined;
        return [api, { api, plane: h.plane, name: h.name, ...(wake ? { wake } : {}) }];
      }),
    );
    return { listed, viaServer: c.add === true };
  } catch {
    return { listed: new Map(), viaServer: false };
  }
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
  const server = await configuredHosts();
  const ui = pickUi(engine, uiCanvas);
  new App(engine, ui, ui instanceof WebShell, uiCanvas, server.listed, server.viaServer);
} catch (e) {
  // Before there is an engine there is no interface to say this on; the one sheet the page
  // carries for exactly this case does.
  const shell = new WebShell(document.body);
  shell.mount(noop);
  shell.render({
    kind: "error",
    head: "This browser cannot run the client",
    text: sentence(e instanceof Error ? e.message : String(e)),
  });
}

/** How long the exit hint stays up; the page's keyframes fade it out over the last tenth. */
const EXIT_HINT_MS = 6000;

/** How to leave with the input in hand: the pad chord with a controller connected, the dial's
 *  End stream on a touchscreen, the key otherwise. */
function exitHintText(): string {
  if (navigator.getGamepads?.().some((g) => g?.mapping === "standard")) return "Hold L1 + R1 + Start + Select to leave";
  if (matchMedia("(pointer: coarse)").matches) return "Menu, then End stream, to leave";
  return "Ctrl+Alt+Shift+D to leave";
}

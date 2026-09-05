// The web-native interface, on Solid.
//
// The alternative to `console.ts`, which is the gamepad shell every punktfunk client shares.
// That one is built for a D-pad across a room and cannot offer a text field at all; this one
// is built for the thing actually holding the browser — a mouse, a trackpad, a phone. Same
// `Screen` values, same `Actions`, no state of its own beyond what is on screen.
//
// Solid because the whole interface is one reactive value: `render(screen)` sets a signal and
// the DOM follows, with no reconciliation pass sitting in the way of the frame loop underneath.
// Every string here comes from `app.ts` or from the network, and none of it goes through
// `innerHTML`.
//
// The look is `../styles/`, which is `pf-console-ui`'s palette transcribed to CSS. Nothing in
// this file names a colour: a screen picks a class and the tokens decide what it means.

import { createEffect, createMemo, createSignal, For, Show, Switch, Match, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import type { LibraryEntry } from "@punktfunk/stream";
import type { Actions, HostCard, Screen, SessionStats, Ui } from "./types.ts";
import "../styles/shell.css";

export class SolidShell implements Ui {
  private readonly setScreen: (s: Screen) => void;
  private readonly dispose: () => void;
  private actions: Actions = noop;

  constructor(container: HTMLElement) {
    const [screen, setScreen] = createSignal<Screen>({ kind: "home", hosts: [], adding: true });
    this.setScreen = setScreen;
    const root = document.createElement("div");
    root.className = "pf-shell";
    container.append(root);
    this.dispose = render(
      () => <Shell screen={screen()} actions={() => this.actions} root={root} />,
      root,
    );
  }

  mount(actions: Actions): void {
    this.actions = actions;
  }

  render(screen: Screen): void {
    this.setScreen(screen);
  }

  destroy(): void {
    this.dispose();
  }
}

const noop: Actions = {
  connect() {}, pair() {}, retry() {}, back() {}, play() {}, forget() {}, disconnect() {},
  setAdding() {},
};

// --- the root ---------------------------------------------------------------------------

function Shell(props: { screen: Screen; actions: () => Actions; root: HTMLElement }): JSX.Element {
  // `data-screen` is what the stylesheet keys layout on — chiefly whether the shell covers the
  // picture or gets out of its way.
  createEffect(() => {
    props.root.dataset["screen"] = props.screen.kind;
  });
  return (
    <>
      {/* One live region for the whole interface: state changes are announced without any
          screen having to remember to. */}
      <div class="sr-only" role="status" aria-live="polite">{announce(props.screen)}</div>
      <Switch>
        <Match when={props.screen.kind === "home"}>
          <Home screen={props.screen as Extract<Screen, { kind: "home" }>} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "accept"}>
          <Accept screen={props.screen as Extract<Screen, { kind: "accept" }>} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "connecting"}>
          <Connecting screen={props.screen as Extract<Screen, { kind: "connecting" }>} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "pair"}>
          <Pair screen={props.screen as Extract<Screen, { kind: "pair" }>} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "trust"}>
          <Trust screen={props.screen as Extract<Screen, { kind: "trust" }>} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "library"}>
          <Library screen={props.screen as Extract<Screen, { kind: "library" }>} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "streaming"}>
          <Hud stats={(props.screen as Extract<Screen, { kind: "streaming" }>).stats} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "error"}>
          <ErrorCard screen={props.screen as Extract<Screen, { kind: "error" }>} actions={props.actions()} />
        </Match>
      </Switch>
    </>
  );
}

/** What a screen reader hears when the screen changes. Short, and only the part that is new. */
function announce(s: Screen): string {
  switch (s.kind) {
    case "home": return s.error ? s.error : s.busy ? "Connecting" : `${s.hosts.length} known hosts`;
    case "accept": return "This host's certificate must be accepted once";
    case "connecting": return `Connecting to ${s.origin}`;
    case "pair": return s.error ?? "Enter the PIN this host is showing";
    case "trust": return "This is not the host that was paired with";
    case "library": return s.busy ? "Loading the library" : `${s.entries.length} titles`;
    case "streaming": return "Streaming";
    case "error": return `${s.head}. ${s.text}`;
  }
}

// --- pieces -----------------------------------------------------------------------------

/** The punktfunk mark. The file carries its own dark-scheme colours, so it is an `<img>`
 *  rather than inlined SVG — nothing here needs to restyle it. */
function Mark(props: { class?: string }): JSX.Element {
  return (
    <div class={`mark ${props.class ?? ""}`}>
      <img src="/punktfunk-logo.svg" alt="punktfunk" />
    </div>
  );
}

/** One centred glass panel: the shape every screen that is a question rather than a list. */
function Sheet(props: { title: string; mark?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <section class="panel sheet" aria-labelledby="pf-sheet-title">
      <Show when={props.mark}><Mark class="sheet-mark" /></Show>
      <h1 id="pf-sheet-title">{props.title}</h1>
      {props.children}
    </section>
  );
}

function Spinner(props: { centred?: boolean }): JSX.Element {
  return <div class={props.centred ? "spinner centred" : "spinner"} role="progressbar" aria-label="Working" />;
}

function ErrorLine(props: { text: string }): JSX.Element {
  return <p class="err" role="alert">{props.text}</p>;
}

/** Focus the field a screen is about, once it exists. */
const autofocus = (el: HTMLElement): void => {
  onMount(() => el.focus());
};

/** How long ago, in the roughest unit that is still true. A host seen four days ago does not
 *  need the hour. */
function ago(at?: number): string {
  if (!at) return "never connected";
  const mins = (Date.now() - at) / 60000;
  if (mins < 2) return "just now";
  if (mins < 60) return `${Math.floor(mins)} min ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} h ago`;
  if (mins < 60 * 24 * 7) return `${Math.floor(mins / 1440)} d ago`;
  return new Date(at).toLocaleDateString();
}

/** A host's state as a dot class and a word. Reachability and pairing are separate facts and
 *  the card shows whichever is the one standing in the way. */
function status(h: HostCard): { dot: string; text: string } {
  if (h.reach === undefined) return { dot: "", text: "checking…" };
  if (h.reach === "unreachable") return { dot: "", text: "offline" };
  if (h.reach === "blocked") return { dot: "warn", text: "certificate not accepted" };
  return h.fingerprint ? { dot: "online", text: "online" } : { dot: "warn", text: "not paired" };
}

// --- screen: home -------------------------------------------------------------------------

// The way in. A machine someone has already streamed from is the common case and gets a card
// with its state on it; a new one gets the field, which is what `adding` puts in front.
function Home(props: { screen: Extract<Screen, { kind: "home" }>; actions: Actions }): JSX.Element {
  return (
    <Show when={!props.screen.adding} fallback={<AddHost screen={props.screen} actions={props.actions} />}>
      <div class="home">
        <header class="masthead" style={{ padding: "var(--pf-inset) 0 0" }}>
          <Mark />
          <span class="spacer" />
          <button class="btn small" onClick={() => props.actions.setAdding(true)}>Add a host</button>
        </header>
        <h2>Your hosts</h2>
        <ul class="hosts">
          <For each={props.screen.hosts}>
            {(host) => <HostTile host={host} actions={props.actions} busy={!!props.screen.busy} />}
          </For>
          <li class="host-slot">
            <button
              class="panel dashed host-card add"
              onClick={() => props.actions.setAdding(true)}
              disabled={!!props.screen.busy}
            >
              <span class="plus" aria-hidden="true">+</span>
              <span>Add a host</span>
            </button>
          </li>
        </ul>
        <Show when={props.screen.error}>{(err) => <ErrorLine text={err()} />}</Show>
      </div>
    </Show>
  );
}

function HostTile(props: { host: HostCard; actions: Actions; busy: boolean }): JSX.Element {
  const state = createMemo(() => status(props.host));
  const label = () => props.host.name ?? props.host.origin.replace(/^https:\/\//, "");
  return (
    <li class="host-slot">
      <button
        class="panel host-card"
        disabled={props.busy}
        onClick={() => props.actions.connect(props.host.origin)}
        aria-label={`Connect to ${label()}, ${state().text}`}
      >
        <span class="top">
          <span class={`dot ${state().dot}`} aria-hidden="true" />
          <span class="name">{label()}</span>
        </span>
        <Show when={props.host.name}>
          <span class="addr">{props.host.origin.replace(/^https:\/\//, "")}</span>
        </Show>
        <span class="foot">
          <span>{state().text}</span>
          <span aria-hidden="true">·</span>
          <span>{ago(props.host.seen)}</span>
        </span>
      </button>
      <span class="controls">
        <button
          class="btn quiet small danger"
          aria-label={`Forget ${label()}`}
          title="Forget this host"
          onClick={() => props.actions.forget(props.host.origin)}
        >
          ✕
        </button>
      </span>
    </li>
  );
}

function AddHost(props: { screen: Extract<Screen, { kind: "home" }>; actions: Actions }): JSX.Element {
  let field!: HTMLInputElement;
  const submit = () => props.actions.connect(field.value);
  return (
    <div class="centre-fill">
      <Sheet title="Connect to a host" mark>
        <p class="sub">The address of a machine running punktfunk on your network.</p>
        <input
          ref={(el) => { field = el; autofocus(el); }}
          class="field" type="text" placeholder="192.168.1.25" autocomplete="off" spellcheck={false}
          aria-label="Host address" disabled={!!props.screen.busy}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <Show when={props.screen.error}>{(err) => <ErrorLine text={err()} />}</Show>
        <div class="actions">
          <Show when={props.screen.hosts.length > 0}>
            <button class="btn" onClick={() => props.actions.setAdding(false)}>Back</button>
          </Show>
          <button class="btn primary" disabled={!!props.screen.busy} onClick={submit}>
            {props.screen.busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </Sheet>
    </div>
  );
}

// --- screen: waiting, trust, errors --------------------------------------------------------

function Connecting(props: { screen: Extract<Screen, { kind: "connecting" }>; actions: Actions }): JSX.Element {
  const title = () =>
    props.screen.phase === "reaching" ? "Looking for the host"
      : props.screen.phase === "starting" ? "Starting the stream"
      : "Connecting";
  return (
    <div class="centre-fill">
      <Sheet title={title()}>
        <p class="sub">{props.screen.origin.replace(/^https:\/\//, "")}</p>
        <Spinner centred />
        <div class="actions">
          <button class="btn" onClick={() => props.actions.back()}>Cancel</button>
        </div>
      </Sheet>
    </div>
  );
}

function Accept(props: { screen: Extract<Screen, { kind: "accept" }>; actions: Actions }): JSX.Element {
  return (
    <div class="centre-fill">
      <Sheet title="Accept this host's certificate">
        <p class="sub">
          A punktfunk host signs its own certificate, so your browser will not talk to it until
          you say so once. Open this, accept the warning, then come back.
        </p>
        <a class="link" href={props.screen.url} target="_blank" rel="noopener" ref={autofocus}>
          {props.screen.url}
        </a>
        <div class="actions">
          <button class="btn" onClick={() => props.actions.back()}>Back</button>
          <button class="btn primary" onClick={() => props.actions.retry()}>I have accepted it</button>
        </div>
      </Sheet>
    </div>
  );
}

function Pair(props: { screen: Extract<Screen, { kind: "pair" }>; actions: Actions }): JSX.Element {
  let pin!: HTMLInputElement;
  const submit = () => { const v = pin.value.trim(); if (v) props.actions.pair(v); };
  const title = () => (props.screen.mode === "again" ? "Pair with this host again" : "Pair with this host");
  const sub = () =>
    props.screen.mode === "again"
      ? "This host no longer knows this browser — it was unpaired there. Enter the PIN it is showing to pair again."
      : "Enter the PIN this host is showing. It is on the host's own screen, and it expires after a couple of minutes.";
  return (
    <div class="centre-fill">
      <Sheet title={title()}>
        <p class="sub">{sub()}</p>
        <input
          ref={(el) => { pin = el; autofocus(el); }}
          class="field pin" type="text" inputmode="numeric" maxlength={8} autocomplete="one-time-code"
          aria-label="Pairing PIN" disabled={!!props.screen.busy}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <Show when={props.screen.error}>{(err) => <ErrorLine text={err()} />}</Show>
        <div class="actions">
          <button class="btn" onClick={() => props.actions.back()}>Back</button>
          <button class="btn primary" disabled={!!props.screen.busy} onClick={submit}>
            {props.screen.busy ? "Pairing…" : "Pair"}
          </button>
        </div>
      </Sheet>
    </div>
  );
}

// A trust moment, not an error. The host is answering but cannot prove it is the one this
// browser paired with, and the two explanations — a reinstalled machine, or something standing
// in the way of it — need different things from the person reading it.
function Trust(props: { screen: Extract<Screen, { kind: "trust" }>; actions: Actions }): JSX.Element {
  return (
    <div class="centre-fill">
      <Sheet title="This is not the same host">
        <p class="sub">
          Something is answering at {props.screen.origin.replace(/^https:\/\//, "")}, but it cannot
          prove it is the machine this browser paired with.
        </p>
        <p class="sub">
          If you reinstalled punktfunk on it, or reset its configuration, that is expected — forget
          this host and pair again. If you did not, stop here: something else is answering at that
          address.
        </p>
        <p class="badge">{props.screen.reason}</p>
        <div class="actions">
          <button class="btn" ref={autofocus} onClick={() => props.actions.back()}>Back</button>
          <button class="btn danger" onClick={() => props.actions.forget(props.screen.origin)}>
            Forget and pair again
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function ErrorCard(props: { screen: Extract<Screen, { kind: "error" }>; actions: Actions }): JSX.Element {
  return (
    <div class="centre-fill">
      <Sheet title={props.screen.head}>
        <p class="sub">{props.screen.text}</p>
        <div class="actions">
          <button class="btn" ref={autofocus} onClick={() => props.actions.back()}>Back</button>
          <Show when={props.screen.retry}>
            <button class="btn primary" onClick={() => props.actions.retry()}>Try again</button>
          </Show>
        </div>
      </Sheet>
    </div>
  );
}

// --- screen: library ------------------------------------------------------------------------

// A launcher: cover art, a search that filters as it is typed, and arrow keys between tiles —
// a grid someone can only tab through one tile at a time is not really a grid.
function Library(props: { screen: Extract<Screen, { kind: "library" }>; actions: Actions }): JSX.Element {
  let grid!: HTMLDivElement;
  const [query, setQuery] = createSignal("");
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? props.screen.entries.filter((e) => e.title.toLowerCase().includes(q)) : props.screen.entries;
  });
  const onKey = (e: KeyboardEvent) => {
    const tiles = [...grid.querySelectorAll<HTMLButtonElement>("button.tile")];
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const cols = Math.max(1, Math.round(grid.clientWidth / (tiles[0]?.offsetWidth ?? 1)));
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: tiles.length - 1 }[e.key];
    if (next === undefined || !tiles[next]) return;
    e.preventDefault();
    tiles[next].focus();
  };
  return (
    <>
      <header class="bar">
        <Mark />
        <h1>{props.screen.host ?? props.screen.origin.replace(/^https:\/\//, "")}</h1>
        <span class="spacer" />
        <Show when={props.screen.entries.length > 0}>
          <input
            class="field search" type="search" placeholder="Search" aria-label="Search the library"
            value={query()} onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </Show>
        <button class="btn primary small" ref={autofocus} onClick={() => props.actions.play()}>
          Stream the desktop
        </button>
        <button class="btn quiet small" onClick={() => props.actions.disconnect()}>Disconnect</button>
      </header>
      <Show when={props.screen.error}>{(err) => <ErrorLine text={err()} />}</Show>
      <Switch>
        <Match when={props.screen.busy && props.screen.entries.length === 0}>
          <Spinner centred />
        </Match>
        <Match when={props.screen.entries.length === 0}>
          <p class="empty">This host's library is empty, or nothing has been added to it yet.</p>
        </Match>
        <Match when={shown().length === 0}>
          <p class="empty">Nothing here matches “{query()}”.</p>
        </Match>
        <Match when={true}>
          <div class="grid" role="grid" aria-label="Library" ref={grid} onKeyDown={onKey}>
            <For each={shown()}>
              {(entry) => (
                <Tile
                  entry={entry}
                  art={props.screen.art.get(entry.id)}
                  running={props.screen.running === entry.title}
                  onPlay={() => props.actions.play(entry)}
                />
              )}
            </For>
          </div>
        </Match>
      </Switch>
    </>
  );
}

function Tile(props: { entry: LibraryEntry; art: string | undefined; running: boolean; onPlay: () => void }): JSX.Element {
  return (
    <button class="tile" role="gridcell" aria-label={props.entry.title} onClick={props.onPlay}>
      <div class="cover">
        <Show
          when={props.art}
          fallback={<span class="initial" aria-hidden="true">{props.entry.title.slice(0, 1).toUpperCase()}</span>}
        >
          {(art) => <img src={art()} alt="" loading="lazy" />}
        </Show>
        <Show when={props.running}>
          <span class="running">Running</span>
        </Show>
      </div>
      <span class="title">{props.entry.title}</span>
    </button>
  );
}

// --- screen: streaming ----------------------------------------------------------------------

/** Connection quality, from what the decoder saw.
 *
 * Drops alone, because drops are the only loss signal the engine reports today; jitter and
 * packet loss are on `SessionStats` but not yet filled in, and a dot that lies is worse than a
 * coarse one. The thresholds are what reads as "smooth" and "visibly hitching" at 60 fps. */
function quality(s: SessionStats): { dot: string; text: string } {
  if (!s.decoded) return { dot: "", text: "starting" };
  const lost = s.dropped / Math.max(1, s.decoded + s.dropped);
  if (lost < 0.005) return { dot: "online", text: "good" };
  if (lost < 0.03) return { dot: "warn", text: "fair" };
  return { dot: "error", text: "poor" };
}

// The overlay over a live picture. Out of the way by default — this is the screen someone came
// for — and brought back by a pointer, a key or a tap, then hidden again.
function Hud(props: { stats: SessionStats; actions: Actions }): JSX.Element {
  const [idle, setIdle] = createSignal(false);
  let timer = 0;
  const wake = () => {
    setIdle(false);
    clearTimeout(timer);
    timer = window.setTimeout(() => setIdle(true), 2600);
  };
  onMount(() => {
    for (const type of ["pointermove", "pointerdown", "keydown"] as const) {
      window.addEventListener(type, wake, { passive: true });
    }
    wake();
  });
  const q = createMemo(() => quality(props.stats));
  const line = () => [
    props.stats.width ? `${props.stats.width}×${props.stats.height}` : "",
    props.stats.fps ? `${props.stats.fps} fps` : "",
    props.stats.backend ?? "",
  ].filter(Boolean).join(" · ");
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };
  return (
    <div class="hud" classList={{ idle: idle() }} role="toolbar" aria-label="Stream">
      <span class={`dot ${q().dot}`} aria-hidden="true" />
      <span class="host">{props.stats.origin.replace(/^https:\/\//, "")}</span>
      <span class="stat">{line()}</span>
      <span class="sep" aria-hidden="true" />
      <button class="btn quiet small" onClick={fullscreen}>Fullscreen</button>
      <button class="btn quiet small" onClick={() => props.actions.disconnect()}>Disconnect</button>
    </div>
  );
}

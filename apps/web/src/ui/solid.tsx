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

import { createEffect, createSignal, For, Show, Switch, Match, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import type { LibraryEntry } from "@punktfunk/stream";
import type { Actions, Screen, SessionStats, Ui } from "./types.ts";

export class SolidShell implements Ui {
  private readonly setScreen: (s: Screen) => void;
  private readonly dispose: () => void;
  private actions: Actions = noop;

  constructor(container: HTMLElement) {
    const [screen, setScreen] = createSignal<Screen>({ kind: "picker", hosts: [] });
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
};

// --- the root ---------------------------------------------------------------------------

function Shell(props: { screen: Screen; actions: () => Actions; root: HTMLElement }): JSX.Element {
  // `data-screen` is what the stylesheet keys layout on, and what the test harness reads.
  createEffect(() => {
    props.root.dataset["screen"] = props.screen.kind;
  });
  return (
    <>
      {/* One live region for the whole interface: state changes are announced without any
          screen having to remember to. */}
      <div class="sr-only" role="status" aria-live="polite">{announce(props.screen)}</div>
      <Switch>
        <Match when={props.screen.kind === "picker"}>
          <Picker screen={props.screen as Extract<Screen, { kind: "picker" }>} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "accept"}>
          <Accept screen={props.screen as Extract<Screen, { kind: "accept" }>} actions={props.actions()} />
        </Match>
        <Match when={props.screen.kind === "connecting"}>
          <Card title="Connecting">
            <p class="sub">{(props.screen as Extract<Screen, { kind: "connecting" }>).origin}</p>
            <Spinner />
          </Card>
        </Match>
        <Match when={props.screen.kind === "pair"}>
          <Pair screen={props.screen as Extract<Screen, { kind: "pair" }>} actions={props.actions()} />
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
    case "picker": return s.busy ? "Connecting" : s.error ? s.error : "Connect to a host";
    case "accept": return "This host's certificate must be accepted once";
    case "connecting": return `Connecting to ${s.origin}`;
    case "pair": return s.error ?? s.message;
    case "library": return s.busy ? "Loading the library" : `${s.entries.length} titles`;
    case "streaming": return "Streaming";
    case "error": return `${s.head}. ${s.text}`;
  }
}

// --- pieces -----------------------------------------------------------------------------

function Card(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="card" aria-labelledby="pf-card-title">
      <h1 id="pf-card-title">{props.title}</h1>
      {props.children}
    </section>
  );
}

function Spinner(): JSX.Element {
  return <div class="spinner" role="progressbar" aria-label="Working" />;
}

function ErrorLine(props: { text: string }): JSX.Element {
  return <p class="err" role="alert">{props.text}</p>;
}

/** Focus the field a screen is about, once it exists. */
const autofocus = (el: HTMLElement): void => {
  onMount(() => el.focus());
};

function Picker(props: { screen: Extract<Screen, { kind: "picker" }>; actions: Actions }): JSX.Element {
  let field!: HTMLInputElement;
  const submit = () => props.actions.connect(field.value);
  return (
    <Card title="Connect to a host">
      <p class="sub">The address of a machine running punktfunk on your network.</p>
      <input
        ref={(el) => { field = el; autofocus(el); }}
        class="addr" type="text" placeholder="192.168.1.25" autocomplete="off" spellcheck={false}
        aria-label="Host address" disabled={!!props.screen.busy}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <Show when={props.screen.error}>{(err) => <ErrorLine text={err()} />}</Show>
      <button class="primary" disabled={!!props.screen.busy} onClick={submit}>
        {props.screen.busy ? "Connecting…" : "Connect"}
      </button>
      <Show when={props.screen.hosts.length > 0}>
        <div class="known">
          <p class="label" id="pf-known-label">Known hosts</p>
          <ul class="rows" aria-labelledby="pf-known-label">
            <For each={props.screen.hosts}>
              {(host) => (
                <li class="row">
                  <button class="ghost" onClick={() => props.actions.connect(host.origin)}>
                    <span class="name">{host.name ?? host.origin.replace(/^https:\/\//, "")}</span>
                    <span class="meta">{host.fingerprint ? "paired" : "not paired"}</span>
                  </button>
                  <button class="icon" aria-label={`Forget ${host.origin}`} onClick={() => props.actions.forget(host.origin)}>✕</button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </Card>
  );
}

function Accept(props: { screen: Extract<Screen, { kind: "accept" }>; actions: Actions }): JSX.Element {
  return (
    <Card title="Accept this host's certificate">
      <p class="sub">
        A punktfunk host signs its own certificate, so your browser will not talk to it until you
        say so once. Open this, accept the warning, then come back.
      </p>
      <a class="link" href={props.screen.url} target="_blank" rel="noopener" ref={autofocus}>{props.screen.url}</a>
      <button class="primary" onClick={() => props.actions.retry()}>I have accepted it</button>
      <button class="ghost" onClick={() => props.actions.back()}>Back</button>
    </Card>
  );
}

function Pair(props: { screen: Extract<Screen, { kind: "pair" }>; actions: Actions }): JSX.Element {
  let pin!: HTMLInputElement;
  const submit = () => { const v = pin.value.trim(); if (v) props.actions.pair(v); };
  return (
    <Card title="Pair with this host">
      <p class="sub">{props.screen.message}</p>
      <input
        ref={(el) => { pin = el; autofocus(el); }}
        class="pin" type="text" inputmode="numeric" maxlength={8} autocomplete="one-time-code"
        aria-label="Pairing PIN" disabled={!!props.screen.busy}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <Show when={props.screen.error}>{(err) => <ErrorLine text={err()} />}</Show>
      <button class="primary" disabled={!!props.screen.busy} onClick={submit}>
        {props.screen.busy ? "Pairing…" : "Pair"}
      </button>
      <button class="ghost" onClick={() => props.actions.back()}>Back</button>
    </Card>
  );
}

function ErrorCard(props: { screen: Extract<Screen, { kind: "error" }>; actions: Actions }): JSX.Element {
  return (
    <Card title={props.screen.head}>
      <p class="sub">{props.screen.text}</p>
      <button class="primary" ref={autofocus} onClick={() => props.actions.back()}>Back</button>
    </Card>
  );
}

// The library. A grid of what the host offers — the screen a browser could not draw at all until
// it could authenticate to the management API. Arrow keys move between tiles, because a grid
// someone can only tab through one tile at a time is not really a grid.
function Library(props: { screen: Extract<Screen, { kind: "library" }>; actions: Actions }): JSX.Element {
  let grid!: HTMLDivElement;
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
        <h1>{props.screen.host ?? props.screen.origin.replace(/^https:\/\//, "")}</h1>
        <Show when={props.screen.running}>{(title) => <span class="running">Running: {title()}</span>}</Show>
        <button class="primary small" ref={autofocus} onClick={() => props.actions.play()}>Stream the desktop</button>
        <button class="ghost small" onClick={() => props.actions.disconnect()}>Disconnect</button>
      </header>
      <Show when={props.screen.error}>{(err) => <ErrorLine text={err()} />}</Show>
      <Switch>
        <Match when={props.screen.busy && props.screen.entries.length === 0}><Spinner /></Match>
        <Match when={props.screen.entries.length === 0}>
          <p class="sub empty">This host's library is empty, or nothing has been added to it yet.</p>
        </Match>
        <Match when={true}>
          <div class="grid" role="grid" aria-label="Library" ref={grid} onKeyDown={onKey}>
            <For each={props.screen.entries}>
              {(entry) => <Tile entry={entry} art={props.screen.art.get(entry.id)} onPlay={() => props.actions.play(entry)} />}
            </For>
          </div>
        </Match>
      </Switch>
    </>
  );
}

function Tile(props: { entry: LibraryEntry; art: string | undefined; onPlay: () => void }): JSX.Element {
  return (
    <button class="tile" role="gridcell" aria-label={props.entry.title} onClick={props.onPlay}>
      <div class="cover">
        <Show when={props.art} fallback={<span class="initial" aria-hidden="true">{props.entry.title.slice(0, 1).toUpperCase()}</span>}>
          {(art) => <img src={art()} alt="" loading="lazy" />}
        </Show>
      </div>
      <span class="title">{props.entry.title}</span>
    </button>
  );
}

// The streaming overlay. Out of the way by default — this is the screen someone came for — and
// brought back by a pointer, a key or a tap, then hidden again.
function Hud(props: { stats: SessionStats; actions: Actions }): JSX.Element {
  const [idle, setIdle] = createSignal(false);
  let timer = 0;
  const wake = () => { setIdle(false); clearTimeout(timer); timer = window.setTimeout(() => setIdle(true), 2600); };
  onMount(() => {
    for (const type of ["pointermove", "pointerdown", "keydown"] as const) window.addEventListener(type, wake, { passive: true });
    wake();
  });
  const line = () => [
    props.stats.width ? `${props.stats.width}×${props.stats.height}` : "",
    props.stats.fps ? `${props.stats.fps} fps` : "",
    props.stats.backend ?? "",
    props.stats.dropped ? `${props.stats.dropped} dropped` : "",
  ].filter(Boolean).join(" · ");
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };
  return (
    <div class="hud" classList={{ idle: idle() }} role="toolbar" aria-label="Stream">
      <span class="dot" aria-hidden="true" />
      <span class="host">{props.stats.origin.replace(/^https:\/\//, "")}</span>
      <span class="stat">{line()}</span>
      <button class="ghost small" onClick={fullscreen}>Fullscreen</button>
      <button class="ghost small" onClick={() => props.actions.disconnect()}>Disconnect</button>
    </div>
  );
}

// The web-native interface, on React.
//
// The alternative to `console.ts`, which is the gamepad shell every punktfunk client shares.
// That one is built for a D-pad across a room and cannot offer a text field at all; this one
// is built for the thing actually holding the browser — a mouse, a trackpad, a phone. Same
// `Screen` values, same `Actions`, no state of its own beyond what is on screen.
//
// The same stack as the host's management console: React, @unom/ui for every control, Tailwind
// on the shared brand tokens in `../styles.css`. Nothing here names a colour, and every string
// comes from `app.ts` or from the network — none of it goes through `innerHTML`.
//
// `render(screen)` is one external store the tree subscribes to. The DOM follows a value, as it
// did on Solid, and the frame loop underneath never waits on it: React commits on its own tick.

import { cn } from "@unom/ui/lib/utils";
import { MotionConfig } from "motion/react";
import { type JSX, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../styles.css";
import { Home } from "./home.tsx";
import { Hud } from "./hud.tsx";
import { Library } from "./library.tsx";
import { SettingsDialog } from "./settings.tsx";
import { Accept, Connecting, ErrorCard, Pair, Trust } from "./sheets.tsx";
import type { Actions, Screen, Ui } from "./types.ts";

export class WebShell implements Ui {
  private screen: Screen = { kind: "home", hosts: [], adding: true };
  private actions: Actions = noop;
  private readonly listeners = new Set<() => void>();
  private readonly root: Root;

  constructor(container: HTMLElement) {
    const el = document.createElement("div");
    container.append(el);
    this.root = createRoot(el);
    this.root.render(<Shell shell={this} />);
  }

  /** `useSyncExternalStore`'s two halves. Arrow properties, so they can be passed bare. */
  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly snapshot = (): Screen => this.screen;
  get act(): Actions {
    return this.actions;
  }

  mount(actions: Actions): void {
    this.actions = actions;
  }

  render(screen: Screen): void {
    this.screen = screen;
    for (const fn of this.listeners) fn();
  }

  destroy(): void {
    this.root.unmount();
  }
}

const noop: Actions = {
  connect() {}, pair() {}, retry() {}, back() {}, play() {}, forget() {}, disconnect() {},
  setAdding() {}, rename() {}, openSettings() {}, setSettings() {}, toggleCapture() {},
  showDiagnostics() {},
};

// --- the root ---------------------------------------------------------------------------

function Shell({ shell }: { shell: WebShell }): JSX.Element {
  const screen = useSyncExternalStore(shell.subscribe, shell.snapshot);
  return <ShellFrame screen={screen} actions={shell.act} />;
}

/** The whole interface for one `Screen`: the layout, the live region, the screen itself.
 *  Exported so Storybook can draw a screen exactly as the page does, with no `WebShell` behind it. */
export function ShellFrame({ screen, actions }: { screen: Screen; actions: Actions }): JSX.Element {
  const kind = screen.kind;
  // Streaming is the one screen that must not cover the picture: no centring, and transparent
  // to the pointer except where the HUD itself is. The lists own the full viewport rather than
  // sitting in the middle of it, because both can outgrow the screen.
  const layout =
    kind === "streaming"
      ? "pointer-events-none items-start justify-items-center overflow-hidden"
      : kind === "home" || kind === "library"
        ? "items-start justify-items-stretch content-start overflow-x-hidden overflow-y-auto"
        : "place-items-center overflow-x-hidden overflow-y-auto";
  return (
    <MotionConfig reducedMotion="user">
      {/* `overscroll-contain`: Safari's rubber-band scroll on a fixed overlay drags the whole
          shell without it. `data-screen` is for the harness driver and devtools, not styling. */}
      <div className={cn("fixed inset-0 z-2 grid overscroll-contain", layout)} data-screen={kind}>
        {kind !== "streaming" && <div className="pf-aurora" aria-hidden="true" />}
        {/* One live region for the whole interface: state changes are announced without any
            screen having to remember to. */}
        <div className="sr-only" role="status" aria-live="polite">{announce(screen)}</div>
        <Screens screen={screen} actions={actions} />
      </div>
    </MotionConfig>
  );
}

function Screens({ screen, actions }: { screen: Screen; actions: Actions }): JSX.Element {
  switch (screen.kind) {
    case "home": return <Home screen={screen} actions={actions} />;
    case "accept": return <Accept screen={screen} actions={actions} />;
    case "connecting": return <Connecting screen={screen} actions={actions} />;
    case "pair": return <Pair screen={screen} actions={actions} />;
    case "trust": return <Trust screen={screen} actions={actions} />;
    case "library": return <Library screen={screen} actions={actions} />;
    case "streaming": return <Hud screen={screen} actions={actions} />;
    case "settings": return <SettingsDialog screen={screen} actions={actions} />;
    case "error": return <ErrorCard screen={screen} actions={actions} />;
  }
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
    case "settings": return "Settings";
    case "error": return `${s.head}. ${s.text}`;
  }
}

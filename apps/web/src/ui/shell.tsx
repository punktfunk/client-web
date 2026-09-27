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
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { type JSX, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../styles.css";
import { Home } from "./home.tsx";
import { Hud } from "./hud.tsx";
import { Library } from "./library.tsx";
import { SettingsDialog } from "./settings.tsx";
import { Accept, Connecting, ErrorCard, LinkSheet, Pair, Trust, Waiting } from "./sheets.tsx";
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
  connect() {}, pair() {}, requestAccess() {}, cancelRequest() {}, retry() {}, back() {}, play() {},
  forget() {}, wake() {}, disconnect() {},
  openTools() {}, hostAction() {}, sendLog() {},
  followLink() {}, copyLink() {},
  setAdding() {}, rename() {}, openSettings() {}, setSettings() {}, toggleCapture() {},
  showDiagnostics() {}, openMenu() {}, fullscreen() {}, cycleStats() {}, toggleMic() {},
  consoleMode() {},
};

// --- the root ---------------------------------------------------------------------------

function Shell({ shell }: { shell: WebShell }): JSX.Element {
  const screen = useSyncExternalStore(shell.subscribe, shell.snapshot);
  return <ShellFrame screen={screen} actions={shell.act} />;
}

/** The whole interface for one `Screen`: the layout, the live region, the screen itself.
 *  Exported so Storybook can draw a screen exactly as the page does, with no `WebShell` behind it. */
export function ShellFrame({ screen, actions }: { screen: Screen; actions: Actions }): JSX.Element | null {
  const kind = screen.kind;
  // The console's own canvas is the interface: nothing here may cover it or take its pointer.
  if (kind === "console") return null;
  const live = kind === "streaming";
  // One screen gives way to the next with a short fade; each then brings its own parts in. The
  // address field is its own screen for this, though it shares `home`'s kind.
  const scene = kind === "home" && screen.adding ? "home-add" : kind;
  return (
    <MotionConfig reducedMotion="user">
      {/* `overscroll-contain`: Safari's rubber-band scroll on a fixed overlay drags the whole
          shell without it. `data-screen` is for the harness driver and devtools, not styling.
          Streaming must not cover the picture: transparent to the pointer except where the HUD
          itself is. */}
      <div
        className={cn(
          "fixed inset-0 z-2 overscroll-contain",
          live ? "pointer-events-none overflow-hidden" : "overflow-x-hidden overflow-y-auto",
        )}
        data-screen={kind}
      >
        {!live && <div className="pf-aurora" aria-hidden="true" />}
        {/* One live region for the whole interface: state changes are announced without any
            screen having to remember to. */}
        <div className="sr-only" role="status" aria-live="polite">{announce(screen)}</div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={scene}
            className={cn("min-h-full", live && "grid items-start justify-items-center")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <Screens screen={screen} actions={actions} />
          </motion.div>
        </AnimatePresence>
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
    case "waiting": return <Waiting screen={screen} actions={actions} />;
    case "trust": return <Trust screen={screen} actions={actions} />;
    case "link": return <LinkSheet screen={screen} actions={actions} />;
    case "library": return <Library screen={screen} actions={actions} />;
    case "streaming": return <Hud screen={screen} actions={actions} />;
    case "settings": return <SettingsDialog screen={screen} actions={actions} />;
    case "error": return <ErrorCard screen={screen} actions={actions} />;
    case "console": return <></>;
  }
}

/** What a screen reader hears when the screen changes. Short, and only the part that is new. */
function announce(s: Screen): string {
  switch (s.kind) {
    case "home": return s.error ? s.error : s.busy ? "Connecting" : `${s.hosts.length} known hosts`;
    case "accept": return "This host's certificate must be accepted once";
    case "connecting": return `Connecting to ${s.origin}`;
    case "pair": return s.error ?? "Enter the PIN this host is showing";
    case "waiting": return `Waiting for approval of ${s.name} in the host's console`;
    case "trust": return "This is not the host that was paired with";
    case "link": return `A link asks to connect to ${s.name}`;
    case "library": return s.busy ? "Loading the library" : `${s.entries.length} titles`;
    case "streaming": return "Streaming";
    case "settings": return "Settings";
    case "error": return `${s.head}. ${s.text}`;
    case "console": return "";
  }
}

// The web-native interface, on React.
//
// The alternative to `console.ts`, which is the gamepad shell every punktfunk client shares.
// That one is built for a D-pad across a room and cannot offer a text field at all; this one
// is built for the thing actually holding the browser — a mouse, a trackpad, a phone. Same
// `Screen` values, same `Actions`, no state of its own beyond what is on screen.
//
// The layout is the macOS client's in the host console's clothes: a sidebar with Hosts, Library
// and Settings, the page beside it, and nothing at all around a live stream. React, @unom/ui and
// Tailwind on the shared brand tokens in `../styles.css`; nothing here names a colour, and every
// string comes from `app.ts` or from the network — none of it goes through `innerHTML`.
//
// `render(screen)` is one external store the tree subscribes to. The DOM follows a value, and
// the frame loop underneath never waits on it: React commits on its own tick.

import { toast, Toaster } from "@unom/ui/toast";
import { MotionConfig } from "motion/react";
import { type JSX, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../styles.css";
import { Stagger } from "@/components/stagger";
import { Frame } from "./frame.tsx";
import { Home } from "./home.tsx";
import { Hud } from "./hud.tsx";
import { Library } from "./library.tsx";
import { SettingsDialog, SettingsPage } from "./settings.tsx";
import { Accept, Connecting, ErrorCard, LinkSheet, Pair, Trust, Waiting } from "./sheets.tsx";
import { type Actions, type Screen, tabOf, type Ui } from "./types.ts";

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

  /** The console's toaster: a line in the corner, gone by itself. */
  notify(text: string, tone?: "error"): void {
    if (tone === "error") toast.error(text);
    else toast(text);
  }

  destroy(): void {
    this.root.unmount();
  }
}

export const noop: Actions = {
  connect() {}, streamDesktop() {}, browse() {}, navigate() {},
  pair() {}, requestAccess() {}, cancelRequest() {}, retry() {}, back() {}, play() {},
  forget() {}, wake() {}, disconnect() {},
  openTools() {}, hostAction() {}, endGame() {}, sendLog() {},
  followLink() {}, copyLink() {},
  setAdding() {}, rename() {}, openSettings() {}, setSettings() {}, toggleCapture() {},
  showDiagnostics() {}, openMenu() {}, fullscreen() {}, cycleStats() {}, toggleMic() {},
  consoleMode() {},
};

// --- the root ---------------------------------------------------------------------------

function Shell({ shell }: { shell: WebShell }): JSX.Element {
  const screen = useSyncExternalStore(shell.subscribe, shell.snapshot);
  return (
    <>
      <ShellFrame screen={screen} actions={shell.act} />
      {/* Outside the frame, so a toast shows over a live picture and over the gamepad console
          alike, and never comes and goes with a page. */}
      <Toaster />
    </>
  );
}

/** The whole interface for one `Screen`. Exported so Storybook draws a screen exactly as the
 *  page does, with no `WebShell` behind it. */
export function ShellFrame({ screen, actions }: { screen: Screen; actions: Actions }): JSX.Element | null {
  const kind = screen.kind;
  // The console's own canvas is the interface: nothing here may cover it or take its pointer.
  if (kind === "console") return null;
  // Over a live picture: the overlay, or settings in a dialog. Transparent to the pointer except
  // where they draw, and no ground: the picture is the page.
  if (kind === "streaming" || (kind === "settings" && screen.streaming)) {
    return (
      <MotionConfig reducedMotion="user">
        <div className="pointer-events-none fixed inset-0 z-2 grid items-start justify-items-center overflow-hidden" data-screen={kind}>
          <Announce screen={screen} />
          {kind === "streaming" ? <Hud screen={screen} actions={actions} /> : <SettingsDialog screen={screen} actions={actions} />}
        </div>
      </MotionConfig>
    );
  }
  return (
    <MotionConfig reducedMotion="user">
      {/* `data-screen` is for the harness driver and devtools, not styling. */}
      <div className="fixed inset-0 z-2" data-screen={kind}>
        <div className="pf-aurora" aria-hidden="true" />
        <Announce screen={screen} />
        <Frame tab={tabOf(screen)} host={kind === "library" ? screen.host : undefined} actions={actions}>
          {/* A new page fades in; the old one does not wait to fade out first. The page is the
              root of its own cascade, as the console's `<Section>` is: the cards on it arrive
              one after another, from the moment the page does. */}
          <Stagger root key={kind} className="flex min-h-full flex-col animate-in fade-in duration-150">
            <Page screen={screen} actions={actions} />
          </Stagger>
        </Frame>
      </div>
    </MotionConfig>
  );
}

function Page({ screen, actions }: { screen: Screen; actions: Actions }): JSX.Element {
  switch (screen.kind) {
    case "home": return <Home screen={screen} actions={actions} />;
    case "accept": return <Accept screen={screen} actions={actions} />;
    case "connecting": return <Connecting screen={screen} actions={actions} />;
    case "pair": return <Pair screen={screen} actions={actions} />;
    case "waiting": return <Waiting screen={screen} actions={actions} />;
    case "trust": return <Trust screen={screen} actions={actions} />;
    case "link": return <LinkSheet screen={screen} actions={actions} />;
    case "library": return <Library screen={screen} actions={actions} />;
    case "settings": return <SettingsPage screen={screen} actions={actions} />;
    case "error": return <ErrorCard screen={screen} actions={actions} />;
    case "streaming":
    case "console": return <></>;
  }
}

/** One live region for the whole interface: state changes are announced without any screen
 *  having to remember to. Short, and only the part that is new. */
function Announce({ screen }: { screen: Screen }): JSX.Element {
  return <div className="sr-only" role="status" aria-live="polite">{announce(screen)}</div>;
}

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

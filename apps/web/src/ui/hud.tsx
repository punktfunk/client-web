// The overlay over a live picture. Out of the way by default — this is the screen someone came
// for — and brought back by a pointer, a key or a tap, then hidden again.

import type { HudCorner, HudLine } from "@punktfunk/stream";
import { cn } from "@unom/ui/lib/utils";
import { Maximize, Menu, MousePointer2, Settings } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { bare } from "./pieces.tsx";
import type { Actions, Screen, SessionStats } from "./types.ts";

/** How long the pointer must rest before the toolbar hides. */
const HIDE_AFTER_MS = 2600;

/** Connection quality, from what the decoder saw.
 *
 * Drops alone, because drops are the only loss signal the engine reports today; jitter and
 * packet loss are on `SessionStats` but not yet filled in, and a dot that lies is worse than a
 * coarse one. The thresholds are what reads as "smooth" and "visibly hitching" at 60 fps. */
function quality(s: SessionStats): { variant: BadgeVariant; text: string } {
  if (!s.decoded) return { variant: "outline", text: "starting" };
  const lost = s.dropped / Math.max(1, s.decoded + s.dropped);
  if (lost < 0.005) return { variant: "success", text: "good" };
  if (lost < 0.03) return { variant: "warning", text: "fair" };
  return { variant: "destructive", text: "poor" };
}

export function Hud({ screen, actions }: { screen: Extract<Screen, { kind: "streaming" }>; actions: Actions }): JSX.Element {
  const [idle, setIdle] = useState(false);
  const stats = screen.stats;
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), HIDE_AFTER_MS);
    };
    const types = ["pointermove", "pointerdown", "keydown"] as const;
    for (const type of types) window.addEventListener(type, wake, { passive: true });
    wake();
    return () => {
      clearTimeout(timer);
      for (const type of types) window.removeEventListener(type, wake);
    };
  }, []);
  const q = quality(stats);
  const line = [
    stats.width ? `${stats.width}×${stats.height}` : "",
    stats.fps ? `${stats.fps} fps` : "",
    stats.backend ?? "",
  ].filter(Boolean).join(" · ");
  return (
    <>
      {/* Hidden means gone, not transparent: a 0-opacity toolbar still takes the pointer, and
          this one sits over a game. */}
      <div
        role="toolbar"
        aria-label="Stream"
        className={cn(
          "pointer-events-auto m-3 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-full border border-border bg-card/95 py-1.5 pr-2 pl-3 shadow-lg transition-[opacity,transform] duration-400 *:shrink-0",
          idle && !screen.diagnostics && "pointer-events-none -translate-y-2 opacity-0",
        )}
      >
        {/* The quality dot doubles as the diagnostics toggle. */}
        <button
          type="button"
          className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-pressed={screen.diagnostics}
          title="Connection quality"
          onClick={() => actions.showDiagnostics(!screen.diagnostics)}
        >
          <Badge variant={q.variant}>{q.text}</Badge>
        </button>
        {/* The one part that gives way on a phone. */}
        <span className="min-w-0 shrink! truncate font-semibold">{bare(stats.origin)}</span>
        {stats.access && <Badge variant="outline">{stats.access}</Badge>}
        <span className="hidden text-muted-foreground tabular-nums sm:inline">{line}</span>
        <span className="h-4 w-px bg-border" aria-hidden="true" />
        <Button
          size="icon"
          variant="ghost"
          aria-pressed={stats.pointerCaptured}
          aria-label={stats.pointerCaptured ? "Release mouse" : "Capture mouse"}
          title={stats.pointerCaptured ? "Release mouse" : "Capture mouse"}
          onClick={() => actions.toggleCapture()}
        >
          <MousePointer2 className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Settings" title="Settings" onClick={() => actions.openSettings(true)}>
          <Settings className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Fullscreen" title="Fullscreen" onClick={() => actions.fullscreen()}>
          <Maximize className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={screen.menu} onClick={() => actions.openMenu(!screen.menu)}>
          <Menu className="size-4" />
          <span className="hidden sm:inline">Menu</span>
        </Button>
      </div>
      {screen.menu && <QuickMenu screen={screen} actions={actions} />}
      {screen.diagnostics && <Diagnostics stats={stats} corner={screen.corner} scale={screen.scale} />}
      {/* How to leave, once, as the stream starts; the captured-pointer line below says it then. */}
      {screen.exitHint && !stats.pointerCaptured && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[6%] flex justify-center px-inset animate-[pf-exit-hint_6s_forwards]">
          <span className="rounded-full bg-card/95 px-4 py-2 text-sm">{screen.exitHint}</span>
        </div>
      )}
      {/* The host's word on a launch that did not give the player their game, or on this
          device's access changing or about to end. */}
      {(screen.notice ?? stats.launchNotice ?? stats.accessNotice) && (
        <div role="status" className="pointer-events-none fixed inset-x-0 bottom-[20%] flex justify-center px-inset animate-in fade-in slide-in-from-bottom-2">
          <span className="max-w-[40rem] rounded-full bg-card/95 px-4 py-2 text-center text-sm">
            {screen.notice ?? stats.launchNotice ?? stats.accessNotice}
          </span>
        </div>
      )}
      {/* A captured pointer has no cursor, so the way out has to be on screen. The browser
          releases on Escape itself; this only says so. */}
      {stats.pointerCaptured && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[12%] flex justify-center animate-in fade-in slide-in-from-bottom-2">
          <span className="rounded-full bg-card/95 px-4 py-2 text-sm">
            Mouse captured — press <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">Esc</kbd> to release
          </span>
        </div>
      )}
    </>
  );
}

/**
 * The quick actions every client offers mid-stream, named and ordered as the native dial has them
 * (`overlay_actions.rs`). End stream and End game ask twice, as there.
 * `data-pf-keys` keeps the menu's keys on the page rather than the host.
 */
function QuickMenu({ screen, actions }: { screen: Extract<Screen, { kind: "streaming" }>; actions: Actions }): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [endArmed, setEndArmed] = useState(false);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") actions.openMenu(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [actions]);
  const item = "w-full justify-start";
  return (
    <Card
      role="menu"
      aria-label="Quick actions"
      data-pf-keys="local"
      className="pointer-events-auto fixed top-[calc(3.5rem+var(--pf-inset))] left-1/2 flex bg-card/95 backdrop-blur-none w-[min(22rem,calc(100vw-2*var(--pf-inset)))] -translate-x-1/2 flex-col gap-1 p-2 animate-in fade-in slide-in-from-top-2"
    >
      <Button
        role="menuitem"
        autoFocus
        variant={armed ? "destructive" : "ghost"}
        className={item}
        onClick={() => (armed ? actions.disconnect(true) : setArmed(true))}
      >
        {armed ? "End stream? Press again" : "End stream"}
      </Button>
      {/* Only while this device's launch is on the stream: it closes the game, then the stream. */}
      {screen.endGame && (
        <Button
          role="menuitem"
          variant={endArmed ? "destructive" : "ghost"}
          className={item}
          onClick={() => (endArmed ? actions.endGame() : setEndArmed(true))}
        >
          {endArmed ? "End game? Press again" : "End game"}
        </Button>
      )}
      <Button role="menuitem" variant="ghost" className={item} onClick={() => actions.disconnect(false)}>
        Disconnect, keep the game running
      </Button>
      <Button role="menuitem" variant="ghost" className={item} onClick={() => actions.cycleStats()}>
        Statistics
        <span className="ml-auto text-muted-foreground">{screen.diagnostics ? "On" : "Off"}</span>
      </Button>
      <Button
        role="menuitem"
        variant="ghost"
        className={item}
        disabled={screen.stats.mic === "unsupported"}
        onClick={() => actions.toggleMic()}
      >
        Microphone
        <span className="ml-auto text-muted-foreground">{MIC_STATE[screen.stats.mic ?? "off"]}</span>
      </Button>
      <Button role="menuitem" variant="ghost" className={item} onClick={() => actions.fullscreen()}>
        Fullscreen
      </Button>
      <Button role="menuitem" variant="ghost" className={item} onClick={() => actions.toggleCapture()}>
        {screen.stats.pointerCaptured ? "Release mouse" : "Capture mouse"}
      </Button>
      <p className="px-3 pt-1 pb-0.5 text-xs text-muted-foreground">
        Ctrl+Alt+Shift+O, or Back+A on a controller
      </p>
    </Card>
  );
}

/** The microphone item's state, as the player reads it. */
const MIC_STATE: Record<NonNullable<SessionStats["mic"]>, string> = {
  off: "Off",
  starting: "Asking…",
  on: "On",
  denied: "Blocked by the browser",
  unsupported: "Not in this browser",
};

/** How each overlay role reads: headline, breakdown, aside, warning. */
const ROLE_CLASS: Record<HudLine["role"], string> = {
  primary: "text-foreground",
  detail: "text-foreground/80",
  muted: "text-muted-foreground",
  warn: "text-amber-500",
};

/** Where each corner puts the panel. The top ones clear the toolbar. */
const CORNER_CLASS: Record<HudCorner, string> = {
  topLeading: "top-[calc(3.5rem+var(--pf-inset))] left-inset",
  topTrailing: "top-[calc(3.5rem+var(--pf-inset))] right-inset",
  bottomLeading: "bottom-inset left-inset",
  bottomTrailing: "bottom-inset right-inset",
};

/** The stats overlay every client draws, in this session's tier and vocabulary, then what only a
 *  browser measures. Lines come from the engine formatted; this panel only paints them, in
 *  `corner` and at `scale` times its size. */
function Diagnostics({ stats: s, corner, scale }: { stats: SessionStats; corner: HudCorner; scale: number }): JSX.Element {
  const lines = s.hud ?? [];
  const browser = [
    s.backend ?? "",
    s.uploadMs ? `upload ${s.uploadMs.toFixed(2)} ms` : "",
    `audio ${s.audio.state}`,
    s.audio.underruns ? `${s.audio.underruns.toLocaleString()} underruns` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card
      aria-label="Statistics"
      className={cn(
        "pointer-events-auto fixed bg-card/95 backdrop-blur-none max-h-[60dvh] overflow-y-auto px-5 py-4 font-mono leading-relaxed",
        CORNER_CLASS[corner],
      )}
      style={{
        fontSize: `${0.875 * scale}rem`,
        width: `min(${34 * scale}rem, calc(100vw - 2 * var(--pf-inset)))`,
      }}
    >
      {lines.map((l, i) => (
        // Lines have no identity beyond their place in the list.
        <div key={i} className={cn("break-words", ROLE_CLASS[l.role])}>
          {l.text}
        </div>
      ))}
      <div className="mt-2 text-xs text-muted-foreground">{browser}</div>
    </Card>
  );
}

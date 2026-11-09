// The overlay over a live picture. Out of the way by default — this is the screen someone came
// for — and brought back by a pointer, a key or a tap, then hidden again.

import { type HudCorner, type HudLine, packaged, tvBack } from "@punktfunk/stream";
import { cn } from "@unom/ui/lib/utils";
import { Maximize, Menu, MousePointer2, Settings } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type JSX, type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { m } from "../paraglide/messages.js";
import { bare } from "./pieces.tsx";
import type { Actions, Screen, SessionStats } from "./types.ts";

/** How long the pointer must rest before the toolbar hides. */
const HIDE_AFTER_MS = 2600;

/** What appears over the picture comes and goes the same way: a short fade, nudged from where
 *  it sits, and out again the way it came. Objects rather than variant labels, so the card
 *  inside is not handed an entrance of its own to play on top. Short: a stream is live under it. */
const FADE = { duration: 0.18, ease: "easeOut" } as const;
const DROP = { initial: { opacity: 0, y: -8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: FADE };
const RISE = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 8 }, transition: FADE };

/** The connection dot is the wire's verdict, rated in core (`hud::quality`) from loss, repairs
 *  and round trip. Presentation skips are the page's own pacing, not loss: they stay in the
 *  overlay's skipped line. */
const QUALITY: Record<SessionStats["quality"], { variant: BadgeVariant; text: () => string }> = {
  starting: { variant: "outline", text: () => m.browser_quality_starting() },
  good: { variant: "success", text: () => m.browser_quality_good() },
  fair: { variant: "warning", text: () => m.browser_quality_fair() },
  poor: { variant: "destructive", text: () => m.browser_quality_poor() },
};

/** Stands where the key cap goes while the message is split around it. */
const KEY_SLOT = "\uE000";

export function Hud({ screen, actions }: { screen: Extract<Screen, { kind: "streaming" }>; actions: Actions }): JSX.Element {
  const [idle, setIdle] = useState(false);
  const stats = screen.stats;
  useEffect(() => {
    let timer = 0;
    // Only a pointer that can reach it shows the toolbar: keys go to the game, and a locked
    // pointer has no cursor to click with. Either would keep it over the picture all game.
    const wake = () => {
      if (document.pointerLockElement) return;
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), HIDE_AFTER_MS);
    };
    const types = ["pointermove", "pointerdown"] as const;
    for (const type of types) window.addEventListener(type, wake, { passive: true });
    wake();
    return () => {
      clearTimeout(timer);
      for (const type of types) window.removeEventListener(type, wake);
    };
  }, []);
  const q = QUALITY[stats.quality];
  const notice = screen.notice ?? stats.launchNotice ?? stats.accessNotice;
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
        aria-label={m.browser_hud_toolbar_a11y()}
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
          title={m.browser_hud_quality_title()}
          onClick={() => actions.showDiagnostics(!screen.diagnostics)}
        >
          <Badge variant={q.variant}>{q.text()}</Badge>
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
          aria-label={stats.pointerCaptured ? m.browser_release_mouse() : m.browser_capture_mouse()}
          title={stats.pointerCaptured ? m.browser_release_mouse() : m.browser_capture_mouse()}
          onClick={() => actions.toggleCapture()}
        >
          <MousePointer2 className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label={m.browser_hud_settings_a11y()} title={m.browser_hud_settings_a11y()} onClick={() => actions.openSettings(true)}>
          <Settings className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label={m.browser_hud_fullscreen_a11y()} title={m.browser_hud_fullscreen_a11y()} onClick={() => actions.fullscreen()}>
          <Maximize className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={screen.menu} onClick={() => actions.openMenu(!screen.menu)}>
          <Menu className="size-4" />
          <span className="hidden sm:inline">{m.browser_hud_menu()}</span>
        </Button>
      </div>
      <AnimatePresence>
        {screen.menu && (
          <motion.div
            key="menu"
            {...DROP}
            className="pointer-events-auto fixed top-[calc(3.5rem+var(--pf-inset))] left-1/2 w-[min(22rem,calc(100vw-2*var(--pf-inset)))] -translate-x-1/2"
          >
            <QuickMenu screen={screen} actions={actions} />
          </motion.div>
        )}
        {screen.diagnostics && (
          <motion.div
            key="statistics"
            {...DROP}
            className={cn("pointer-events-auto fixed", CORNER_CLASS[screen.corner])}
            style={{ width: `min(${34 * screen.scale}rem, calc(100vw - 2 * var(--pf-inset)))` }}
          >
            <Diagnostics stats={stats} scale={screen.scale} />
          </motion.div>
        )}
        {/* How to leave, once, as the stream starts; the captured-pointer line below says it then. */}
        {screen.exitHint && !stats.pointerCaptured && (
          <motion.div key="exit-hint" {...RISE} className="pointer-events-none fixed inset-x-0 bottom-[6%] flex justify-center px-inset">
            <span className="animate-[pf-exit-hint_6s_forwards] rounded-full bg-card/95 px-4 py-2 text-sm">{screen.exitHint}</span>
          </motion.div>
        )}
        {/* The host's word on a launch that did not give the player their game, or on this
            device's access changing or about to end. */}
        {notice && (
          <motion.div key="notice" {...RISE} role="status" className="pointer-events-none fixed inset-x-0 bottom-[20%] flex justify-center px-inset">
            <span className="max-w-[40rem] rounded-full bg-card/95 px-4 py-2 text-center text-sm">{notice}</span>
          </motion.div>
        )}
        {/* A captured pointer has no cursor, so the way out goes on screen each time capture
            starts, for as long as the exit hint stays. The browser releases on Escape itself;
            this only says so. */}
        {stats.pointerCaptured && (
          <motion.div key="captured" {...RISE} className="pointer-events-none fixed inset-x-0 bottom-[12%] flex justify-center">
            <span className="animate-[pf-exit-hint_6s_forwards] rounded-full bg-card/95 px-4 py-2 text-sm">
              <Keyed text={m.browser_mouse_captured({ keys: KEY_SLOT })} cap="Esc" />
            </span>
          </motion.div>
        )}
        {/* A browser plays sound only after a click or a key, and a controller is neither: until
            one, the stream is silent, and this says so. */}
        {stats.audio.state === "suspended" && !stats.pointerCaptured && (
          <motion.div key="sound" {...RISE} role="status" className="pointer-events-none fixed inset-x-0 bottom-[12%] flex justify-center px-inset">
            <span className="rounded-full bg-card/95 px-4 py-2 text-sm">{m.browser_sound_suspended()}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * The quick actions every client offers mid-stream, named and ordered as the native dial has them
 * (`overlay_actions.rs`). End stream and End game ask twice, as there.
 * `data-pf-keys` keeps the menu's keys on the page rather than the host.
 *
 * By remote: Back opened it and Back closes it, the arrows move between the rows, Enter picks.
 * On a TV the row focused first is Disconnect, which keeps the game: a Back-then-Enter by
 * reflex must not end what someone is playing.
 */
function QuickMenu({ screen, actions }: { screen: Extract<Screen, { kind: "streaming" }>; actions: Actions }): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [endArmed, setEndArmed] = useState(false);
  const tv = packaged();
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape" || tvBack(e)) {
        e.preventDefault();
        actions.openMenu(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [actions]);
  const rows = (e: ReactKeyboardEvent<HTMLElement>) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  };
  const item = "w-full justify-start";
  return (
    <Card
      role="menu"
      aria-label={m.browser_ring_menu_a11y()}
      data-pf-keys="local"
      className="flex flex-col gap-1 bg-card/95 p-2"
      onKeyDown={rows}
    >
      <Button
        role="menuitem"
        autoFocus={!tv}
        variant={armed ? "destructive" : "ghost"}
        className={item}
        onClick={() => (armed ? actions.disconnect(true) : setArmed(true))}
      >
        {armed ? m.ring_end_stream_confirm() : m.ring_end_stream()}
      </Button>
      {/* Only while this device's launch is on the stream: it closes the game, then the stream. */}
      {screen.endGame && (
        <Button
          role="menuitem"
          variant={endArmed ? "destructive" : "ghost"}
          className={item}
          onClick={() => (endArmed ? actions.endGame() : setEndArmed(true))}
        >
          {endArmed ? m.ring_end_game_confirm() : m.ring_end_game()}
        </Button>
      )}
      <Button role="menuitem" autoFocus={tv} variant="ghost" className={item} onClick={() => actions.disconnect(false)}>
        {m.ring_disconnect_linger()}
      </Button>
      <Button role="menuitem" variant="ghost" className={item} onClick={() => actions.cycleStats()}>
        {m.ring_stats()}
        <span className="ml-auto text-muted-foreground">{screen.diagnostics ? m.browser_ring_stats_on() : m.browser_ring_stats_off()}</span>
      </Button>
      <Button
        role="menuitem"
        variant="ghost"
        className={item}
        disabled={screen.stats.mic === "unsupported"}
        onClick={() => actions.toggleMic()}
      >
        {m.ring_mic()}
        <span className="ml-auto text-muted-foreground">{MIC_STATE[screen.stats.mic ?? "off"]()}</span>
      </Button>
      <Button role="menuitem" variant="ghost" className={item} onClick={() => actions.fullscreen()}>
        {m.browser_ring_fullscreen()}
      </Button>
      <Button role="menuitem" variant="ghost" className={item} onClick={() => actions.toggleCapture()}>
        {screen.stats.pointerCaptured ? m.browser_ring_release_mouse() : m.browser_ring_capture_mouse()}
      </Button>
      {screen.menuHint && <p className="px-3 pt-1 pb-0.5 text-xs text-muted-foreground">{screen.menuHint}</p>}
    </Card>
  );
}

/** The microphone item's state, as the player reads it. */
const MIC_STATE: Record<NonNullable<SessionStats["mic"]>, () => string> = {
  off: () => m.browser_ring_mic_off(),
  starting: () => m.browser_ring_mic_asking(),
  on: () => m.ring_mic_on(),
  denied: () => m.browser_ring_mic_blocked(),
  unsupported: () => m.browser_ring_mic_unsupported(),
};

/** How each overlay role reads: headline, breakdown, aside, warning. */
const ROLE_CLASS: Record<HudLine["role"], string> = {
  primary: "text-foreground",
  detail: "text-foreground/80",
  muted: "text-muted-foreground",
  warn: "text-amber-500",
};

/** Where each corner puts the statistics. The top ones clear the toolbar; the sides, a notch. */
const CORNER_CLASS: Record<HudCorner, string> = {
  topLeading: "top-[calc(3.5rem+var(--pf-inset))] left-[var(--pf-inset-left)]",
  topTrailing: "top-[calc(3.5rem+var(--pf-inset))] right-[var(--pf-inset-right)]",
  bottomLeading: "bottom-inset left-[var(--pf-inset-left)]",
  bottomTrailing: "bottom-inset right-[var(--pf-inset-right)]",
};

/** The stats overlay every client draws, in this session's tier and vocabulary, then what only a
 *  browser measures. Lines come from the engine formatted; this panel only paints them, at
 *  `scale` times its size. */
function Diagnostics({ stats: s, scale }: { stats: SessionStats; scale: number }): JSX.Element {
  const lines = s.hud ?? [];
  const browser = [
    s.backend ?? "",
    s.uploadMs ? m.browser_overlay_upload({ value: `${s.uploadMs.toFixed(2)} ms` }) : "",
    m.browser_overlay_audio({ state: s.audio.state }),
    s.audio.underruns ? m.browser_overlay_underruns({ count: s.audio.underruns }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card
      aria-label={m.browser_stats_a11y()}
      className="max-h-[60dvh] overflow-y-auto bg-card/95 px-5 py-4 font-mono leading-relaxed"
      style={{ fontSize: `${0.875 * scale}rem` }}
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

/** A message with a key cap in it: `text` was filled with `KEY_SLOT` where the cap goes, so a
 *  language can put the key anywhere in its sentence. */
function Keyed({ text, cap }: { text: string; cap: string }): JSX.Element {
  const [before = "", after = ""] = text.split(KEY_SLOT);
  return (
    <>
      {before}
      <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">{cap}</kbd>
      {after}
    </>
  );
}

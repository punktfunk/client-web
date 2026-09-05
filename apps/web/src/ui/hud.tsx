// The overlay over a live picture. Out of the way by default — this is the screen someone came
// for — and brought back by a pointer, a key or a tap, then hidden again.

import { Badge } from "@unom/ui/badge";
import { cn } from "@unom/ui/lib/utils";
import { type JSX, useEffect, useState } from "react";
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
function quality(s: SessionStats): { tint: "outline" | "success" | "warn" | "error"; text: string } {
  if (!s.decoded) return { tint: "outline", text: "starting" };
  const lost = s.dropped / Math.max(1, s.decoded + s.dropped);
  if (lost < 0.005) return { tint: "success", text: "good" };
  if (lost < 0.03) return { tint: "warn", text: "fair" };
  return { tint: "error", text: "poor" };
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
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };
  return (
    <>
      {/* Hidden means gone, not transparent: a 0-opacity toolbar still takes the pointer, and
          this one sits over a game. */}
      <div
        role="toolbar"
        aria-label="Stream"
        className={cn(
          "pointer-events-auto m-3 flex items-center gap-2 rounded-full border border-border bg-card/85 py-1.5 pr-2 pl-3 shadow-lg backdrop-blur-xl transition-[opacity,transform] duration-400",
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
          <Badge variant={q.tint} size="sm" dot>{q.text}</Badge>
        </button>
        <span className="font-semibold">{bare(stats.origin)}</span>
        <span className="hidden text-muted-foreground tabular-nums sm:inline">{line}</span>
        <span className="h-4 w-px bg-border" aria-hidden="true" />
        <Button size="sm" variant="ghost" aria-pressed={stats.pointerCaptured} onClick={() => actions.toggleCapture()}>
          {stats.pointerCaptured ? "Release mouse" : "Capture mouse"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => actions.openSettings(true)}>Settings</Button>
        <Button size="sm" variant="ghost" onClick={fullscreen}>Fullscreen</Button>
        <Button size="sm" variant="ghost" onClick={() => actions.disconnect()}>Disconnect</Button>
      </div>
      {screen.diagnostics && <Diagnostics stats={stats} />}
      {/* A captured pointer has no cursor, so the way out has to be on screen. The browser
          releases on Escape itself; this only says so. */}
      {stats.pointerCaptured && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[12%] flex justify-center animate-in fade-in slide-in-from-bottom-2">
          <span className="rounded-full bg-card/85 px-4 py-2 text-sm backdrop-blur-xl">
            Mouse captured — press <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">Esc</kbd> to release
          </span>
        </div>
      )}
    </>
  );
}

/** The numbers behind the dot, in a fixed two-column list so nothing jumps as the counters
 *  tick. Everything here is already counted by the engine; this is the panel that stops "it
 *  feels bad" from being the only report anyone can make. */
function Diagnostics({ stats: s }: { stats: SessionStats }): JSX.Element {
  const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(2)}%` : "—");
  const rows: [string, string][] = [
    ["Resolution", s.width ? `${s.width}×${s.height}` : "—"],
    ["Frame rate", `${s.fps} fps`],
    ["Video plane", s.backend ?? "—"],
    ["Upload", `${s.uploadMs.toFixed(2)} ms`],
    ["Access units", s.accessUnits.toLocaleString()],
    ["Decoded", s.decoded.toLocaleString()],
    ["Dropped", `${s.dropped.toLocaleString()} (${pct(s.dropped, s.decoded + s.dropped)})`],
    ["Audio", s.audio.state],
    ["Audio frames", s.audio.frames.toLocaleString()],
    ["Audio lost", s.audio.lost.toLocaleString()],
    ["Underruns", s.audio.underruns.toLocaleString()],
    ["Audio errors", s.audio.errors.toLocaleString()],
  ];
  return (
    <Card
      aria-label="Diagnostics"
      className="pointer-events-auto fixed top-[calc(3.5rem+var(--pf-inset))] right-inset max-h-[60dvh] w-[min(22rem,calc(100vw-2*var(--pf-inset)))] overflow-y-auto px-5 py-4"
    >
      <dl className="m-0 grid gap-x-4 gap-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[1fr_auto] items-baseline gap-4">
            <dt className="text-sm text-muted-foreground">{k}</dt>
            <dd className="m-0 text-right font-mono text-sm tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

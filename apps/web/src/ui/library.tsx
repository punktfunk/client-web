// The Library tab: one host's titles at a time — a shelf — as the macOS client lays them out.
// A row of every paired host's desktop first, then the shelf's posters with a search that filters
// as it is typed, and arrow keys between tiles: a grid someone can only tab through one tile at a
// time is not really a grid. The shelf's titles as last read stay up while its host reconnects.

import type { LibraryEntry } from "@punktfunk/stream";
import { cn } from "@unom/ui/lib/utils";
import { CircleX, Monitor, Play, Search, Server } from "lucide-react";
import { type JSX, type KeyboardEvent, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Body, PageHead } from "./frame.tsx";
import { Empty, ErrorLine, labelOf, Loading, status } from "./pieces.tsx";
import type { Actions, HostCard, Screen } from "./types.ts";

type LibraryScreen = Extract<Screen, { kind: "library" }>;

export function Library({ screen, actions }: { screen: LibraryScreen; actions: Actions }): JSX.Element {
  const [query, setQuery] = useState("");
  if (screen.origin === null) {
    return (
      <Body>
        <PageHead title="Library" />
        <Empty title="No library yet">
          <p>Pair a host, and its games show up here.</p>
          <Button size="sm" onClick={() => actions.navigate("hosts")}>Show hosts</Button>
        </Empty>
      </Body>
    );
  }
  const origin = screen.origin;
  const q = query.trim().toLowerCase();
  const shown = q ? screen.entries.filter((e) => e.title.toLowerCase().includes(q)) : screen.entries;
  const sub = screen.running
    ? `Running now: ${screen.running}`
    : screen.entries.length
      ? `${screen.entries.length} titles`
      : undefined;
  return (
    <Body>
      {screen.tools && <HostSheet host={screen.host ?? ""} tools={screen.tools} actions={actions} />}
      <PageHead
        title={
          <span className="flex items-center gap-3">
            {screen.host ?? "Library"}
            {screen.busy && screen.entries.length > 0 && <Spinner className="size-4" />}
          </span>
        }
        sub={sub}
      >
        {screen.resume && (
          <Button size="sm" onClick={() => actions.play(screen.resume)}>
            <Play className="size-4" />
            Resume {screen.resume.title}
          </Button>
        )}
        {screen.endable && screen.running && <EndGame title={screen.running} onEnd={() => actions.endGame()} />}
        {!screen.offline && (
          <Button size="icon" variant="ghost" aria-label="Host actions" title="Host actions" onClick={() => actions.openTools(true)}>
            <Server className="size-4" />
          </Button>
        )}
      </PageHead>

      {screen.notice && <p role="status" className="text-sm text-muted-foreground">{screen.notice}</p>}

      {screen.shelves.length > 1 && <ShelfSwitcher shelves={screen.shelves} current={origin} actions={actions} />}

      <section aria-label="Desktops" className="flex flex-col gap-3">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Desktops</h2>
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
          {screen.shelves.map((h) => (
            <DesktopTile key={h.origin} host={h} onPlay={() => actions.streamDesktop(h.origin)} />
          ))}
        </div>
      </section>

      <section aria-label="Games" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Games</h2>
          {screen.entries.length > 0 && (
            <label className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                placeholder="Search titles"
                aria-label="Search the library"
                className="pl-9"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
            </label>
          )}
        </div>
        {screen.error && <ErrorLine text={screen.error} />}
        {screen.entries.length === 0 ? (
          screen.busy ? (
            <Loading label="Loading the library" />
          ) : screen.offline ? (
            <Empty title={`Not connected to ${screen.host ?? "this host"}`}>
              <Button size="sm" onClick={() => actions.browse(origin)}>Connect</Button>
            </Empty>
          ) : (
            <Empty>This host's library is empty, or nothing has been added to it yet.</Empty>
          )
        ) : shown.length === 0 ? (
          <Empty>Nothing here matches “{query}”.</Empty>
        ) : (
          <Grid entries={shown} screen={screen} actions={actions} />
        )}
      </section>
    </Body>
  );
}

/** Which paired host's titles to show. Chips, as the macOS client's shelf filter. */
function ShelfSwitcher({ shelves, current, actions }: { shelves: HostCard[]; current: string; actions: Actions }): JSX.Element {
  return (
    <div role="tablist" aria-label="Host" className="flex flex-wrap gap-2">
      {shelves.map((h) => {
        const on = h.origin === current;
        return (
          <button
            key={h.origin}
            type="button"
            role="tab"
            aria-selected={on}
            className={cn(
              "flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              on ? "border-primary/60 bg-primary/15 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-primary/10 hover:text-foreground",
            )}
            onClick={() => !on && actions.browse(h.origin)}
          >
            <span className={cn("size-2 rounded-full", status(h).dot)} aria-hidden="true" />
            {labelOf(h)}
          </button>
        );
      })}
    </div>
  );
}

/** One host's desktop, streamed in a click. */
function DesktopTile({ host, onPlay }: { host: HostCard; onPlay: () => void }): JSX.Element {
  const state = status(host);
  return (
    <Card asChild interactive className="w-48! shrink-0 gap-3 p-4 text-left">
      <button type="button" onClick={onPlay} aria-label={`Stream the desktop of ${labelOf(host)}`}>
        <span className="flex items-center justify-between">
          <Monitor className="size-5 text-primary" aria-hidden="true" />
          <span className={cn("size-2 rounded-full", state.dot)} title={state.text} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{labelOf(host)}</span>
          <span className="block text-xs text-muted-foreground">Desktop</span>
        </span>
      </button>
    </Card>
  );
}

function Grid({ entries, screen, actions }: { entries: LibraryEntry[]; screen: LibraryScreen; actions: Actions }): JSX.Element {
  const grid = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = grid.current;
    if (!el) return;
    const tiles = [...el.querySelectorAll<HTMLButtonElement>("button[role=gridcell]")];
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const cols = Math.max(1, Math.round(el.clientWidth / (tiles[0]?.offsetWidth ?? 1)));
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: tiles.length - 1 }[e.key];
    if (next === undefined || !tiles[next]) return;
    e.preventDefault();
    tiles[next].focus();
  };
  return (
    <div
      ref={grid}
      role="grid"
      aria-label="Library"
      className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-5 gap-y-6"
      onKeyDown={onKey}
    >
      {entries.map((entry) => (
        <Tile
          key={entry.id}
          entry={entry}
          art={screen.art.get(entry.id)}
          running={screen.running === entry.title}
          onPlay={() => actions.play(entry)}
        />
      ))}
    </div>
  );
}

/** A poster: 2:3 art, the title under it. Until its cover arrives the title stands in the frame;
 *  the cover then fades in over it rather than popping. */
function Tile({ entry, art, running, onPlay }: { entry: LibraryEntry; art: string | undefined; running: boolean; onPlay: () => void }): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      type="button"
      role="gridcell"
      aria-label={entry.title}
      onClick={onPlay}
      className="group flex flex-col gap-2 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="relative block aspect-2/3 overflow-hidden rounded-[10px] bg-muted ring-1 ring-border transition-shadow group-hover:ring-accent group-hover:shadow-[0_8px_28px_var(--pf-glow)]">
        <span className="absolute inset-0 grid place-items-center p-3 text-center text-sm font-medium text-muted-foreground" aria-hidden="true">
          {entry.title}
        </span>
        {art && (
          <img
            src={art}
            alt=""
            loading="lazy"
            decoding="async"
            // A cover already in the cache can finish before React sees `load`.
            ref={(img) => { if (img?.complete) setLoaded(true); }}
            onLoad={() => setLoaded(true)}
            className={cn(
              "relative size-full object-cover transition-[opacity,transform] duration-300 group-hover:scale-[1.03]",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        )}
        {running && <Badge variant="success" className="absolute top-2 right-2 shadow-sm">Running</Badge>}
      </span>
      <span className="line-clamp-2 text-xs text-muted-foreground group-hover:text-foreground" title={entry.title}>
        {entry.title}
      </span>
    </button>
  );
}

/** End the running title this device launched. It asks twice, as the dial does: unsaved progress
 *  in the game is lost. */
function EndGame({ title, onEnd }: { title: string; onEnd: () => void }): JSX.Element {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      size="sm"
      variant={armed ? "destructive" : "secondary"}
      title="Unsaved progress in the game is lost."
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onEnd();
      }}
      onBlur={() => setArmed(false)}
    >
      <CircleX className="size-4" />
      {armed ? `End ${title}? Press again` : "End game"}
    </Button>
  );
}

/** The host's power actions as this device may run them, and sending this page's log. A
 *  destructive one asks twice, as the native clients' dial does. */
function HostSheet({ host, tools, actions }: { host: string; tools: NonNullable<LibraryScreen["tools"]>; actions: Actions }): JSX.Element {
  const [armed, setArmed] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) actions.openTools(false); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{host}</DialogTitle>
          <DialogDescription>What this device may do to the host.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {tools.busy && tools.actions.length === 0 && <Spinner className="mx-auto my-4 size-8" />}
          {tools.actions.map((a) => (
            <Button
              key={a.id}
              variant={armed === a.id ? "destructive" : "secondary"}
              disabled={!a.enabled || tools.busy}
              title={a.reason}
              onClick={() => {
                if (a.danger && armed !== a.id) return setArmed(a.id);
                setArmed(null);
                actions.hostAction(a.id);
              }}
            >
              {armed === a.id ? `${a.title}? Press again` : a.title}
            </Button>
          ))}
          <Button variant="ghost" disabled={tools.busy} onClick={() => actions.sendLog()}>
            Send this page's log to the host
          </Button>
        </div>
        {tools.note && <p className="text-sm text-muted-foreground">{tools.note}</p>}
      </DialogContent>
    </Dialog>
  );
}

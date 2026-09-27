// A launcher: cover art, a search that filters as it is typed, and arrow keys between tiles —
// a grid someone can only tab through one tile at a time is not really a grid.

import type { LibraryEntry } from "@punktfunk/stream";
import { cn } from "@unom/ui/lib/utils";
import { Gamepad2, LogOut, Play, Server, Settings } from "lucide-react";
import { type JSX, type KeyboardEvent, useRef, useState } from "react";
import { Stagger } from "@/components/stagger";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { bare, Empty, ErrorLine, Frame, Loading, Page, TopBar } from "./pieces.tsx";
import type { Actions, Screen } from "./types.ts";

type LibraryScreen = Extract<Screen, { kind: "library" }>;

/** Tiles past this many arrive together: a 500-title library must not take seconds to land. */
const STAGGERED_TILES = 24;
const TILE_GAP = 0.03;

export function Library({ screen, actions }: { screen: LibraryScreen; actions: Actions }): JSX.Element {
  const grid = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const host = screen.host ?? bare(screen.origin);
  const q = query.trim().toLowerCase();
  const shown = q ? screen.entries.filter((e) => e.title.toLowerCase().includes(q)) : screen.entries;
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
    <Frame
      bar={
        <TopBar title={host}>
          <Button size="icon" variant="ghost" aria-label="Console mode" title="Console mode — the controller interface" onClick={() => actions.consoleMode(true)}>
            <Gamepad2 className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Host" title="Host" onClick={() => actions.openTools(true)}>
            <Server className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Settings" title="Settings" onClick={() => actions.openSettings(true)}>
            <Settings className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.disconnect()}>
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Disconnect</span>
          </Button>
        </TopBar>
      }
    >
      {screen.tools && <HostSheet host={host} tools={screen.tools} actions={actions} />}
      <Page
        title="Library"
        sub={screen.running ? `Running now: ${screen.running}` : screen.entries.length ? `${screen.entries.length} titles on ${host}` : undefined}
        actions={
          <>
            {screen.resume && (
              <Button autoFocus size="sm" onClick={() => actions.play(screen.resume)}>
                <Play className="size-4" />
                Resume {screen.resume.title}
              </Button>
            )}
            <Button
              autoFocus={!screen.resume}
              size="sm"
              variant={screen.resume ? "secondary" : "default"}
              onClick={() => actions.play()}
            >
              Stream the desktop
            </Button>
          </>
        }
      >
        {screen.error && <ErrorLine text={screen.error} />}
        {screen.entries.length > 0 && (
          <Input
            type="search"
            placeholder="Search"
            aria-label="Search the library"
            className="max-w-sm"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        )}
        {screen.busy && screen.entries.length === 0 ? (
          <Loading label="Loading the library" />
        ) : screen.entries.length === 0 ? (
          <Empty>This host's library is empty, or nothing has been added to it yet.</Empty>
        ) : shown.length === 0 ? (
          <Empty>Nothing here matches “{query}”.</Empty>
        ) : (
          <div className="@container">
            {/* `root`: the grid mounts once the entries arrive, after the page's own entrance. */}
            <Stagger
              root
              ref={grid}
              role="grid"
              aria-label="Library"
              className="grid grid-cols-2 gap-card @lg:grid-cols-3 @2xl:grid-cols-4 @4xl:grid-cols-5 @6xl:grid-cols-6"
              transition={{ delayChildren: (i: number) => Math.min(i, STAGGERED_TILES) * TILE_GAP }}
              onKeyDown={onKey}
            >
              {shown.map((entry) => (
                <Tile
                  key={entry.id}
                  entry={entry}
                  art={screen.art.get(entry.id)}
                  running={screen.running === entry.title}
                  onPlay={() => actions.play(entry)}
                />
              ))}
            </Stagger>
          </div>
        )}
      </Page>
    </Frame>
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

/** A poster tile, as the console's library draws one. Until its cover arrives the title stands
 *  in the frame; the cover then fades in over it rather than popping. */
function Tile({ entry, art, running, onPlay }: { entry: LibraryEntry; art: string | undefined; running: boolean; onPlay: () => void }): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return (
    <Card className="group relative overflow-hidden transition-shadow hover:ring-accent focus-within:ring-accent">
      <button
        type="button"
        role="gridcell"
        aria-label={entry.title}
        onClick={onPlay}
        className="block w-full rounded-[inherit] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative block aspect-[2/3] overflow-hidden bg-muted">
          <span className="absolute inset-0 grid place-items-center p-3 text-center text-sm font-medium text-muted-foreground" aria-hidden="true">
            {entry.title}
          </span>
          {art && (
            <img
              src={art}
              alt=""
              loading="lazy"
              // A cover already in the cache can finish before React sees `load`.
              ref={(img) => { if (img?.complete) setLoaded(true); }}
              onLoad={() => setLoaded(true)}
              className={cn(
                "relative size-full object-cover transition-[opacity,transform] duration-500 group-hover:scale-[1.03]",
                loaded ? "opacity-100" : "opacity-0",
              )}
            />
          )}
          {/* The title the host is running now, marked on its own tile rather than only above. */}
          {running && <Badge className="absolute top-2 left-2 shadow-sm">Running</Badge>}
        </span>
        <span className="block truncate px-card pt-4 pb-card text-sm font-medium" title={entry.title}>
          {entry.title}
        </span>
      </button>
    </Card>
  );
}

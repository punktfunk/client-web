// A launcher: cover art, a search that filters as it is typed, and arrow keys between tiles —
// a grid someone can only tab through one tile at a time is not really a grid.

import { Badge } from "@unom/ui/badge";
import type { LibraryEntry } from "@punktfunk/stream";
import { Spinner } from "@unom/ui/spinner";
import { type JSX, type KeyboardEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bare, ErrorLine, Mark } from "./pieces.tsx";
import type { Actions, Screen } from "./types.ts";

type LibraryScreen = Extract<Screen, { kind: "library" }>;

export function Library({ screen, actions }: { screen: LibraryScreen; actions: Actions }): JSX.Element {
  const grid = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
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
    <>
      <header className="sticky top-0 z-2 flex items-center gap-3 border-b border-border bg-background/80 px-inset py-3.5 backdrop-blur-xl">
        <Mark className="h-9" />
        <h1 className="m-0 truncate text-base font-semibold">{screen.host ?? bare(screen.origin)}</h1>
        <span className="flex-1" />
        {screen.entries.length > 0 && (
          <Input
            type="search"
            placeholder="Search"
            aria-label="Search the library"
            className="h-9! w-[min(18rem,40vw)]"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        )}
        <Button autoFocus size="sm" onClick={() => actions.play()}>Stream the desktop</Button>
        <Button size="sm" variant="ghost" onClick={() => actions.openSettings(true)}>Settings</Button>
        <Button size="sm" variant="ghost" onClick={() => actions.disconnect()}>Disconnect</Button>
      </header>
      {screen.error && <div className="px-inset"><ErrorLine text={screen.error} /></div>}
      {screen.busy && screen.entries.length === 0 ? (
        <Spinner className="mx-auto my-10 block size-10" />
      ) : screen.entries.length === 0 ? (
        <Empty>This host's library is empty, or nothing has been added to it yet.</Empty>
      ) : shown.length === 0 ? (
        <Empty>Nothing here matches “{query}”.</Empty>
      ) : (
        <div
          ref={grid}
          role="grid"
          aria-label="Library"
          className="grid gap-4 px-inset pt-6 pb-16 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]"
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
        </div>
      )}
    </>
  );
}

function Empty({ children }: { children: JSX.Element | string | (string | JSX.Element)[] }): JSX.Element {
  return <p className="px-inset py-16 text-center text-muted-foreground">{children}</p>;
}

function Tile({ entry, art, running, onPlay }: { entry: LibraryEntry; art: string | undefined; running: boolean; onPlay: () => void }): JSX.Element {
  return (
    <button type="button" role="gridcell" aria-label={entry.title} onClick={onPlay} className="group grid gap-2 p-0 text-left outline-none">
      {/* No art: the console draws a face tinted toward the accent rather than a grey hole, and
          puts the title's initial on it. Same idea here. */}
      <span className="relative grid aspect-[3/4] place-items-center overflow-hidden rounded-lg border border-border bg-muted transition-[transform,border-color,box-shadow] duration-300 group-hover:-translate-y-1 group-hover:scale-[1.02] group-hover:border-accent/55 group-hover:shadow-lg group-focus-visible:-translate-y-1 group-focus-visible:border-accent/55 group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ring">
        {art ? (
          <img src={art} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <span className="text-4xl font-semibold text-foreground/40" aria-hidden="true">
            {entry.title.slice(0, 1).toUpperCase()}
          </span>
        )}
        {/* The title the host is running now, marked on its own tile rather than only in the
            bar. */}
        {running && (
          <Badge className="absolute inset-x-1.5 bottom-1.5 justify-center bg-brand text-accent-foreground" size="sm">
            Running
          </Badge>
        )}
      </span>
      <span className="truncate text-sm">{entry.title}</span>
    </button>
  );
}

// The Library tab: one host's titles at a time — a shelf — as the macOS client lays them out.
// A row of every paired host's desktop first, then the shelf's posters with a search that filters
// as it is typed, and arrow keys between tiles: a grid someone can only tab through one tile at a
// time is not really a grid. The shelf's titles as last read stay up while its host reconnects.

import type { LibraryEntry } from "@punktfunk/stream";
import { cn } from "@unom/ui/lib/utils";
import { CircleX, EyeOff, Monitor, Play, Search, Server } from "lucide-react";
import { motion } from "motion/react";
import { type JSX, type KeyboardEvent, useRef, useState } from "react";
import { ROW, ROW_GAP, Stagger, staggerProps } from "@/components/stagger";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { m } from "../paraglide/messages.js";
import { Body, PageHead } from "./frame.tsx";
import { Empty, ErrorLine, labelOf, Loading, status } from "./pieces.tsx";
import type { Actions, HostCard, Screen } from "./types.ts";

type LibraryScreen = Extract<Screen, { kind: "library" }>;

/** The stagger between posters, as the console's library has it: a shelf enters in under a
 *  second, not one tile a beat. */
const TILE_GAP = 0.012;
const TILE = { from: { opacity: 0, y: 12 }, enter: { opacity: 1, y: 0 } };
const TAP = { scale: 0.97 };

export function Library({ screen, actions }: { screen: LibraryScreen; actions: Actions }): JSX.Element {
  const [query, setQuery] = useState("");
  if (screen.origin === null) {
    return (
      <Body>
        <PageHead title={m.lib_title()} />
        <Empty title={m.lib_no_host_title()}>
          <p>{m.lib_no_host_body()}</p>
          <Button size="sm" onClick={() => actions.navigate("hosts")}>{m.lib_no_host_show_hosts()}</Button>
        </Empty>
      </Body>
    );
  }
  const origin = screen.origin;
  const q = query.trim().toLowerCase();
  const shown = q ? screen.entries.filter((e) => e.title.toLowerCase().includes(q)) : screen.entries;
  const sub = screen.running
    ? m.browser_lib_running_now({ title: screen.running })
    : screen.entries.length
      ? m.browser_lib_title_count({ count: screen.entries.length })
      : undefined;
  return (
    <Body>
      {screen.tools && <HostSheet host={screen.host ?? ""} tools={screen.tools} actions={actions} />}
      {screen.hidden && <HiddenSheet hidden={screen.hidden} actions={actions} />}
      <PageHead
        title={
          <span className="flex items-center gap-3">
            {screen.host ?? m.lib_title()}
            {screen.busy && screen.entries.length > 0 && <Spinner className="size-4" />}
          </span>
        }
        sub={sub}
      >
        {screen.resume && (
          <Button size="sm" onClick={() => actions.play(screen.resume)}>
            <Play className="size-4" />
            {m.lib_resume_title({ title: screen.resume.title })}
          </Button>
        )}
        {screen.endable && screen.running && <EndGame onEnd={() => actions.endGame()} />}
        {screen.hide && (
          <Button size="sm" variant="ghost" onClick={() => actions.openHidden(true)}>
            <EyeOff className="size-4" />
            {m.lib_hidden_for({ name: screen.hide.name })}
          </Button>
        )}
        {!screen.offline && (
          <Button size="icon" variant="ghost" aria-label="Host actions" title="Host actions" onClick={() => actions.openTools(true)}>
            <Server className="size-4" />
          </Button>
        )}
      </PageHead>

      {screen.notice && <p role="status" className="text-sm text-muted-foreground">{screen.notice}</p>}

      {screen.shelves.length > 1 && <ShelfSwitcher shelves={screen.shelves} current={origin} actions={actions} />}

      <section aria-label={m.lib_section_desktops()} className="flex flex-col gap-3">
        <h2 className="text-xs font-medium text-muted-foreground">{m.lib_section_desktops()}</h2>
        {/* A scroller clips everything past its box, rings and shadows included, so the row is
            padded out to the page's gutters and back in again: it bleeds to the page's edge, as
            the macOS shelf does, and nothing a card draws outside itself is cut off. */}
        <Stagger
          gap={ROW_GAP}
          className="-mx-4 -my-6 flex snap-x gap-3 overflow-x-auto px-4 py-6 sm:-mx-10 sm:px-10"
        >
          {screen.shelves.map((h) => (
            <DesktopTile key={h.origin} host={h} onPlay={() => actions.streamDesktop(h.origin)} />
          ))}
        </Stagger>
      </section>

      <section aria-label={m.lib_section_games()} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-medium text-muted-foreground">{m.lib_section_games()}</h2>
          {screen.entries.length > 0 && (
            <label className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                placeholder={m.lib_search_titles()}
                aria-label={m.browser_lib_search_a11y()}
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
            <Loading label={m.lib_loading()} />
          ) : screen.offline ? (
            <Empty title={screen.host ? m.browser_lib_not_connected({ host: screen.host }) : m.browser_lib_not_connected_this_host()}>
              <Button size="sm" onClick={() => actions.browse(origin)}>{m.browser_lib_connect()}</Button>
            </Empty>
          ) : screen.error ? null : (
            <Empty>{m.lib_empty()}</Empty>
          )
        ) : shown.length === 0 ? (
          <Empty>{m.lib_no_match_body({ query })}</Empty>
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
    <Stagger gap={0.04} role="tablist" aria-label="Host" className="flex flex-wrap gap-2">
      {shelves.map((h) => {
        const on = h.origin === current;
        return (
          <motion.button
            key={h.origin}
            type="button"
            role="tab"
            variants={ROW}
            whileTap={TAP}
            aria-selected={on}
            className={cn(
              "flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              on ? "border-primary/60 bg-primary/15 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-primary/10 hover:text-foreground",
            )}
            onClick={() => !on && actions.browse(h.origin)}
          >
            <span className={cn("size-2 rounded-full", status(h).dot)} aria-hidden="true" />
            {labelOf(h)}
          </motion.button>
        );
      })}
    </Stagger>
  );
}

/** One host's desktop, streamed in a click. */
function DesktopTile({ host, onPlay }: { host: HostCard; onPlay: () => void }): JSX.Element {
  const state = status(host);
  return (
    <Card asChild interactive className="w-48! shrink-0 snap-start gap-3 p-4 text-left">
      <button type="button" onClick={onPlay} aria-label={m.lib_desktop_stream_host({ host: labelOf(host) })}>
        <span className="flex items-center justify-between">
          <Monitor className="size-5 text-primary" aria-hidden="true" />
          <span className={cn("size-2 rounded-full", state.dot)} title={state.text} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{labelOf(host)}</span>
          <span className="block text-xs text-muted-foreground">{m.lib_desktop()}</span>
        </span>
      </button>
    </Card>
  );
}

/**
 * The posters. A list rather than an ARIA grid: a grid owes its cells rows, and a wrapping CSS
 * grid has no row to name. The arrow keys still walk it — across, and up and down by however
 * many columns the layout resolved to, read back from the grid itself so a gap or a stray pixel
 * cannot put Down on the wrong tile.
 */
function Grid({ entries, screen, actions }: { entries: LibraryEntry[]; screen: LibraryScreen; actions: Actions }): JSX.Element {
  const grid = useRef<HTMLUListElement>(null);
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const el = grid.current;
    if (!el) return;
    const tiles = [...el.querySelectorAll<HTMLButtonElement>("button[data-tile]")];
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const cols = Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").length);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: tiles.length - 1 }[e.key];
    if (next === undefined || !tiles[next]) return;
    e.preventDefault();
    tiles[next].focus();
  };
  return (
    <motion.ul
      ref={grid}
      role="list"
      aria-label={m.lib_title()}
      {...staggerProps(TILE_GAP)}
      className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-5 gap-y-6 p-0"
      onKeyDown={onKey}
    >
      {entries.map((entry) => (
        <Tile
          key={entry.id}
          entry={entry}
          art={screen.art.get(entry.id)}
          running={screen.running === entry.title}
          onPlay={() => actions.play(entry)}
          hide={screen.hide?.name}
          onHide={() => actions.setHidden(entry, true)}
        />
      ))}
    </motion.ul>
  );
}

/** A poster: 2:3 art, the title under it. Until its cover arrives the title stands in the frame;
 *  the cover then fades in over it rather than popping. `hide` names the profile the shelf plays
 *  as when this device may hide titles for it: the tile then offers that, in its corner. */
function Tile({
  entry,
  art,
  running,
  onPlay,
  hide,
  onHide,
}: {
  entry: LibraryEntry;
  art: string | undefined;
  running: boolean;
  onPlay: () => void;
  hide: string | undefined;
  onHide: () => Promise<{ done: boolean }>;
}): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return (
    <motion.li variants={TILE} className="group/tile relative min-w-0">
      {hide && (
        <Button
          size="icon"
          variant="secondary"
          aria-label={`${m.lib_hide_for({ name: hide })}: ${entry.title}`}
          title={m.lib_hide_for({ name: hide })}
          // Shown with the pointer on the tile, with focus, and always where nothing hovers.
          className="absolute top-2 left-2 z-1 size-8 opacity-0 shadow-sm transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={(e) => {
            // The tile leaves on a yes: its neighbour takes the focus, never the top.
            const li = e.currentTarget.closest("li");
            const next = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>("button[data-tile]");
            void onHide().then((r) => { if (r.done && li?.contains(document.activeElement)) next?.focus(); });
          }}
        >
          <EyeOff className="size-4" />
        </Button>
      )}
      <button
        type="button"
        data-tile
        aria-label={entry.title}
        onClick={onPlay}
        className="group flex w-full flex-col gap-2 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative block aspect-2/3 w-full overflow-hidden rounded-[10px] bg-muted ring-1 ring-border transition-shadow group-hover:ring-accent group-hover:shadow-[0_8px_28px_var(--pf-glow)]">
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
          {running && <Badge variant="success" className="absolute top-2 right-2 shadow-sm">{m.lib_badge_running()}</Badge>}
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground group-hover:text-foreground" title={entry.title}>
          {entry.title}
        </span>
      </button>
    </motion.li>
  );
}

/** What the shelf's profile hides, read when opened: each title dimmed, with the way back. */
function HiddenSheet({ hidden, actions }: { hidden: NonNullable<LibraryScreen["hidden"]>; actions: Actions }): JSX.Element {
  const none = hidden.entries?.length === 0;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) actions.openHidden(false); }}>
      <DialogContent className="max-w-md" {...(none ? {} : { "aria-describedby": undefined })}>
        <DialogHeader>
          <DialogTitle>{m.lib_hidden_for({ name: hidden.name })}</DialogTitle>
          {none && <DialogDescription>{m.lib_hidden_none({ name: hidden.name })}</DialogDescription>}
        </DialogHeader>
        {hidden.failed ? (
          <div className="grid gap-3">
            <ErrorLine text={m.lib_load_failed()} />
            <Button variant="secondary" onClick={() => actions.openHidden(true)}>{m.common_retry()}</Button>
          </div>
        ) : !hidden.entries ? (
          <Spinner className="mx-auto my-4 size-8" />
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {hidden.entries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-1">
                <span className="min-w-0 truncate text-muted-foreground" title={entry.title}>{entry.title}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`${m.lib_show_for({ name: hidden.name })}: ${entry.title}`}
                  onClick={(e) => {
                    // The row leaves on a yes: the next one's button takes the focus.
                    const li = e.currentTarget.closest("li");
                    const next = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector("button");
                    void actions.setHidden(entry, false).then((r) => { if (r.done) next?.focus(); });
                  }}
                >
                  {m.lib_show_for({ name: hidden.name })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** End the running title this device launched. It asks twice, as the dial does: unsaved progress
 *  in the game is lost. */
function EndGame({ onEnd }: { onEnd: () => void }): JSX.Element {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      size="sm"
      variant={armed ? "destructive" : "secondary"}
      title={m.lib_end_game_confirm_body()}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onEnd();
      }}
      onBlur={() => setArmed(false)}
    >
      <CircleX className="size-4" />
      {armed ? m.lib_end_game_armed() : m.lib_end_game()}
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

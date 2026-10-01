// The Hosts tab. A card is a host, and clicking it streams that host's desktop, as on every other
// punktfunk client; its library, its name and its link are in the card's menu. A new host is
// added from a sheet, or from the page itself while there is none.

import { cn } from "@unom/ui/lib/utils";
import { LibraryBig, Link2, Monitor, MoreHorizontal, Pencil, Play, Plus, Power, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { type JSX, useState } from "react";
import { GROUP, ROW_GAP, staggerProps } from "@/components/stagger";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Body, PageHead } from "./frame.tsx";
import { bare, ErrorLine, labelOf, status } from "./pieces.tsx";
import type { Actions, HostCard, Screen } from "./types.ts";

type HomeScreen = Extract<Screen, { kind: "home" }>;

/**
 * The console's grid: a column count per width of the LIST, never a track that fits itself to
 * what is in it. `grid-cols-N` is `repeat(N, minmax(0, 1fr))`, so every card is exactly one
 * share of the row and the gaps between them are the gap and nothing else — an address that
 * does not wrap, or a card that would rather size itself, cannot push its column wider than the
 * next one. Container queries, so the count follows the page and not the window with the
 * sidebar still in it.
 */
const GRID = "m-0 grid list-none grid-cols-1 gap-card p-0 @lg:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4 @7xl:grid-cols-5";

export function Home({ screen, actions }: { screen: HomeScreen; actions: Actions }): JSX.Element {
  const first = screen.hosts.length === 0;
  return (
    <Body>
      <PageHead title="Hosts" sub={first ? "Add the machine you want to stream from." : "Click a host to stream its desktop."}>
        {!first && (
          <Button size="sm" variant="secondary" onClick={() => actions.setAdding(true)}>
            <Plus className="size-4" />
            Add host
          </Button>
        )}
      </PageHead>
      {first ? (
        <Card className="w-full max-w-lg p-8">
          <AddHostForm screen={screen} actions={actions} />
        </Card>
      ) : (
        <div className="@container">
          {/* Its own cadence, tighter than the page's: a card a beat would make a wall of hosts
              take seconds to arrive. */}
          <motion.ul {...staggerProps(ROW_GAP)} className={GRID}>
            {screen.hosts.map((host) => (
              <HostTile key={host.origin} host={host} actions={actions} />
            ))}
          </motion.ul>
        </div>
      )}
      {!first && (
        <Dialog open={screen.adding} onOpenChange={(open) => actions.setAdding(open)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a host</DialogTitle>
              <DialogDescription>The address of a machine running punktfunk on your network.</DialogDescription>
            </DialogHeader>
            <AddHostForm screen={screen} actions={actions} />
          </DialogContent>
        </Dialog>
      )}
    </Body>
  );
}

function AddHostForm({ screen, actions }: { screen: HomeScreen; actions: Actions }): JSX.Element {
  const [address, setAddress] = useState("");
  const submit = () => actions.connect(address);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        autoFocus
        type="text"
        placeholder="192.168.1.25"
        autoComplete="off"
        spellCheck={false}
        aria-label="Host address"
        disabled={!!screen.busy}
        value={address}
        onChange={(e) => setAddress(e.currentTarget.value)}
      />
      {screen.error && <ErrorLine text={screen.error} />}
      <Button type="submit" disabled={!!screen.busy || !address.trim()}>
        {screen.busy ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}

/**
 * One host. The item is a pass-through group, so the card and the menu button beside it take
 * one slot in the cascade and arrive together; `grid` with `w-full` on the card, so the card
 * is the cell's width whatever it would rather be.
 */
function HostTile({ host, actions }: { host: HostCard; actions: Actions }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const state = status(host);
  const label = labelOf(host);
  const paired = !!host.fingerprint;
  // An asleep host the page's server can wake wakes on a click; it streams once it answers.
  const asleep = !!host.wake && host.reach === "unreachable";
  if (editing) {
    const commit = (value: string) => {
      actions.rename(host.origin, value);
      setEditing(false);
    };
    return (
      <motion.li variants={GROUP} className="grid min-w-0">
        <Card className="w-full min-w-0 gap-2 p-padding-card">
          <Input
            autoFocus
            defaultValue={label}
            aria-label={`Name for ${bare(host.origin)}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(e.currentTarget.value);
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={(e) => commit(e.currentTarget.value)}
          />
          <span className="text-xs text-muted-foreground">Enter to save, Escape to cancel</span>
        </Card>
      </motion.li>
    );
  }
  return (
    <motion.li variants={GROUP} className="relative grid min-w-0">
      <Card asChild interactive className="w-full min-w-0 items-stretch gap-3 p-4 text-left">
        <button
          type="button"
          disabled={host.waking}
          onClick={() => (asleep ? actions.wake(host.origin) : actions.streamDesktop(host.origin))}
          aria-label={`${asleep ? "Wake" : "Stream"} ${label}, ${state.text}`}
          title={bare(host.origin)}
        >
          <span className="flex min-w-0 items-center gap-3 pr-9">
            <span
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-[10px]",
                paired
                  ? "bg-linear-to-br from-brand to-brand-light/80 text-white shadow-[0_4px_16px_var(--pf-glow)]"
                  : "bg-primary/10 text-primary ring-1 ring-primary/30",
                host.reach === "unreachable" && "opacity-55",
              )}
            >
              <Monitor className="size-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{label}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn("size-2 shrink-0 rounded-full", state.dot)} aria-hidden="true" />
                <span className="truncate">{state.text}</span>
              </span>
            </span>
          </span>
          <span className="block min-w-0 truncate font-mono text-xs text-muted-foreground/70">{host.plane ?? bare(host.origin)}</span>
        </button>
      </Card>
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon" variant="ghost" className="absolute top-3 right-3 size-8" aria-label={`More for ${label}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={() => actions.streamDesktop(host.origin)}>
            <Play />
            Stream desktop
          </MenuItem>
          {paired && (
            <MenuItem onSelect={() => actions.browse(host.origin)}>
              <LibraryBig />
              Browse library
            </MenuItem>
          )}
          {host.wake && (
            <MenuItem disabled={host.waking || host.reach === "ok"} onSelect={() => actions.wake(host.origin)}>
              <Power />
              Wake
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Rename
          </MenuItem>
          <MenuItem onSelect={() => actions.copyLink(host.origin)}>
            <Link2 />
            Copy link
          </MenuItem>
          <MenuItem className="text-destructive [&_svg]:text-destructive" onSelect={() => actions.forget(host.origin)}>
            <Trash2 />
            Forget
          </MenuItem>
        </MenuContent>
      </Menu>
    </motion.li>
  );
}

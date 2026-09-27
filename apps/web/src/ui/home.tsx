// The way in. A machine someone has already streamed from is the common case and gets a card
// with its state on it; a new one gets the field, which is what `adding` puts in front.

import { Link2, Monitor, Pencil, Plus, Power, Settings, Trash2 } from "lucide-react";
import { type JSX, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ago, bare, Centre, ErrorLine, Frame, Page, Row, Sheet, status, Sub, TopBar } from "./pieces.tsx";
import type { Actions, HostCard, Screen } from "./types.ts";

type HomeScreen = Extract<Screen, { kind: "home" }>;

export function Home({ screen, actions }: { screen: HomeScreen; actions: Actions }): JSX.Element {
  if (screen.adding) return <AddHost screen={screen} actions={actions} />;
  return (
    <Frame
      bar={
        <TopBar>
          <Button size="icon" variant="ghost" aria-label="Settings" title="Settings" onClick={() => actions.openSettings(true)}>
            <Settings className="size-4" />
          </Button>
        </TopBar>
      }
    >
      <Page
        title="Your hosts"
        sub="Pick a machine to stream from."
        actions={
          <Button size="sm" variant="secondary" disabled={!!screen.busy} onClick={() => actions.setAdding(true)}>
            <Plus className="size-4" />
            Add a host
          </Button>
        }
      >
        <ul className="m-0 grid list-none gap-card p-0 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {screen.hosts.map((host) => (
            <HostTile key={host.origin} host={host} actions={actions} busy={!!screen.busy} />
          ))}
          {/* The same tile shape, dashed, because it is an invitation rather than a thing. */}
          <li className="flex">
            <button
              type="button"
              className="flex min-h-36 flex-1 flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-accent/60 hover:bg-primary/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              onClick={() => actions.setAdding(true)}
              disabled={!!screen.busy}
            >
              <Plus className="size-5" aria-hidden="true" />
              Add a host
            </button>
          </li>
        </ul>
        {screen.error && <ErrorLine text={screen.error} />}
      </Page>
    </Frame>
  );
}

function HostTile({ host, actions, busy }: { host: HostCard; actions: Actions; busy: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const state = status(host);
  // A label someone chose beats the hostname the machine reports: two boxes on one network can
  // answer to the same name, and only the person looking at them can tell which is which.
  const label = host.label ?? host.name ?? bare(host.origin);
  const wake = host.wake && host.reach !== "ok";
  const commit = (value: string) => {
    actions.rename(host.origin, value);
    setEditing(false);
  };
  if (editing) {
    return (
      <li className="flex">
        <Card className="flex-1 gap-2 p-padding-card">
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
      </li>
    );
  }
  // The whole card is the connect target. A button inside a button is invalid, so the card is the
  // button and its controls are siblings laid over it, which also keeps the card one tab stop.
  return (
    <li className="group relative flex">
      <Card asChild interactive className="min-h-36 flex-1 items-stretch gap-3 p-padding-card text-left">
        <button
          type="button"
          disabled={busy}
          onClick={() => actions.connect(host.origin)}
          aria-label={`Connect to ${label}, ${state.text}`}
        >
          <span className={`flex items-start gap-3 ${wake ? "pr-20" : ""}`}>
            <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
              <Monitor className="size-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{label}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{host.plane ?? bare(host.origin)}</span>
            </span>
          </span>
          <span className="mt-auto flex items-center gap-2 pr-24">
            <Badge variant={state.variant}>{state.text}</Badge>
            <span className="truncate text-xs text-muted-foreground">{ago(host.seen)}</span>
          </span>
          {/* The pinned identity, short: what someone compares against the host's own screen
              when they want to be sure this is the machine they think it is. */}
          {host.fingerprint && (
            <span className="truncate font-mono text-[0.7rem] text-muted-foreground/50" title={host.fingerprint}>
              {host.fingerprint.slice(0, 16)}
            </span>
          )}
        </button>
      </Card>
      {/* An asleep host's way back, shown without a hover: a phone has none. */}
      {wake && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute top-3 right-3"
          disabled={host.waking}
          onClick={() => actions.wake(host.origin)}
        >
          <Power className="size-3.5" />
          {host.waking ? "Waking…" : "Wake"}
        </Button>
      )}
      {/* Revealed on hover, focus or a touch pointer; pointer events move with the opacity, so an
          invisible button never takes a click. */}
      <span className="absolute right-3 bottom-3 flex gap-1 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto">
        <Button size="icon" variant="secondary" className="size-7 bg-background/80 backdrop-blur" aria-label={`Rename ${label}`} title="Rename" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon" variant="secondary" className="size-7 bg-background/80 backdrop-blur" aria-label={`Copy a link to ${label}`} title="Copy a link" onClick={() => actions.copyLink(host.origin)}>
          <Link2 className="size-3.5" />
        </Button>
        <Button size="icon" variant="secondary" className="size-7 bg-background/80 backdrop-blur" aria-label={`Forget ${label}`} title="Forget this host" onClick={() => actions.forget(host.origin)}>
          <Trash2 className="size-3.5 text-destructive" />
        </Button>
      </span>
    </li>
  );
}

function AddHost({ screen, actions }: { screen: HomeScreen; actions: Actions }): JSX.Element {
  const [address, setAddress] = useState("");
  const submit = () => actions.connect(address);
  return (
    <Centre>
      <Sheet title="Connect to a host" mark>
        <Sub>The address of a machine running punktfunk on your network.</Sub>
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
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        {screen.error && <ErrorLine text={screen.error} />}
        <Row>
          {screen.hosts.length > 0 && (
            <Button variant="secondary" onClick={() => actions.setAdding(false)}>Back</Button>
          )}
          <Button disabled={!!screen.busy} onClick={submit}>
            {screen.busy ? "Connecting…" : "Connect"}
          </Button>
        </Row>
      </Sheet>
    </Centre>
  );
}

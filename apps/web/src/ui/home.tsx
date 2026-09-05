// The way in. A machine someone has already streamed from is the common case and gets a card
// with its state on it; a new one gets the field, which is what `adding` puts in front.

import { Badge } from "@unom/ui/badge";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ago, bare, Centre, ErrorLine, Mark, Row, Sheet, status, Sub } from "./pieces.tsx";
import type { Actions, HostCard, Screen } from "./types.ts";

type HomeScreen = Extract<Screen, { kind: "home" }>;

export function Home({ screen, actions }: { screen: HomeScreen; actions: Actions }): JSX.Element {
  if (screen.adding) return <AddHost screen={screen} actions={actions} />;
  return (
    <div className="mx-auto w-full max-w-5xl px-inset pb-inset">
      <header className="flex items-center gap-4 pt-inset">
        <Mark />
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => actions.setAdding(true)}>Add a host</Button>
        <Button size="sm" variant="ghost" aria-label="Settings" onClick={() => actions.openSettings(true)}>
          Settings
        </Button>
      </header>
      <h2 className="mt-8 mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">Your hosts</h2>
      <ul className="grid list-none gap-4 p-0 m-0 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
        {screen.hosts.map((host) => (
          <HostTile key={host.origin} host={host} actions={actions} busy={!!screen.busy} />
        ))}
        {/* Add-a-host: the same tile shape, dashed, because it is an invitation rather than a
            thing. */}
        <li className="flex">
          <button
            type="button"
            className="flex min-h-26 flex-1 flex-col items-center justify-center gap-1 rounded-card border border-dashed border-white/15 bg-white/2 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
            onClick={() => actions.setAdding(true)}
            disabled={!!screen.busy}
          >
            <span className="text-2xl leading-none" aria-hidden="true">+</span>
            <span>Add a host</span>
          </button>
        </li>
      </ul>
      {screen.error && <ErrorLine text={screen.error} />}
    </div>
  );
}

function HostTile({ host, actions, busy }: { host: HostCard; actions: Actions; busy: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const state = status(host);
  // A label someone chose beats the hostname the machine reports: two boxes on one network can
  // answer to the same name, and only the person looking at them can tell which is which.
  const label = host.label ?? host.name ?? bare(host.origin);
  const commit = (value: string) => {
    actions.rename(host.origin, value);
    setEditing(false);
  };
  // The whole card is the connect target; the per-host menu sits above it. A button inside a
  // button is invalid, so the card is the button and the controls are siblings positioned over
  // it — which is also what keeps the card keyboard-reachable as one stop.
  return (
    <li className="group relative flex">
      {editing ? (
        <Card className="flex-1 p-5">
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
          <span className="mt-2 text-xs text-muted-foreground">Enter to save, Escape to cancel</span>
        </Card>
      ) : (
        <Card asChild interactive className="flex-1 items-stretch gap-1.5 p-5 text-left min-h-26">
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.connect(host.origin)}
            aria-label={`Connect to ${label}, ${state.text}`}
          >
            <span className="flex items-center gap-2">
              <Badge variant={state.tint} size="sm" dot>{state.text}</Badge>
              <span className="flex-1 truncate text-base font-semibold">{label}</span>
            </span>
            <span className="font-mono text-sm text-muted-foreground">{bare(host.origin)}</span>
            <span className="mt-auto pt-2 text-xs text-muted-foreground/70">{ago(host.seen)}</span>
            {/* The pinned identity, short. What someone compares against the host's own screen
                when they want to be sure this is the machine they think it is. */}
            {host.fingerprint && (
              <span className="truncate font-mono text-[0.72rem] text-foreground/20" title={host.fingerprint}>
                {host.fingerprint.slice(0, 16)}
              </span>
            )}
          </button>
        </Card>
      )}
      {/* Bottom-right, not top-right: the name is the widest thing on the card and the row it
          sits in is the one place these cannot go without covering it. */}
      <span className="absolute right-2 bottom-2 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button size="sm" variant="ghost" aria-label={`Rename ${label}`} title="Rename" onClick={() => setEditing(true)}>
          Rename
        </Button>
        {/* Marked at rest, not only on hover: the button that discards a pairing has to read as
            the heavier of the two before the pointer is anywhere near it. */}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/15 hover:text-destructive"
          aria-label={`Forget ${label}`}
          title="Forget this host"
          onClick={() => actions.forget(host.origin)}
        >
          Forget
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

// The pages that are a question rather than a list: one sheet each, centred in the frame.

import { type JSX, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { bare, ErrorLine, Row, Sheet, Sub } from "./pieces.tsx";
import type { Actions, Screen } from "./types.ts";

type Props<K extends Screen["kind"]> = { screen: Extract<Screen, { kind: K }>; actions: Actions };

export function Connecting({ screen, actions }: Props<"connecting">): JSX.Element {
  const title =
    screen.phase === "reaching" ? "Looking for the host"
      : screen.phase === "starting" ? "Starting the stream"
      : "Connecting";
  return (
    <Sheet title={title}>
      <Sub>{bare(screen.origin)}</Sub>
      <Spinner className="mx-auto my-8 block size-12" />
      <Row>
        <Button variant="secondary" onClick={() => actions.back()}>Cancel</Button>
      </Row>
    </Sheet>
  );
}

export function Accept({ screen, actions }: Props<"accept">): JSX.Element {
  return (
    <Sheet title="Accept this host's certificate">
      <Sub>
        A punktfunk host signs its own certificate, so your browser will not talk to it until
        you say so once. Open this, accept the warning, then come back.
      </Sub>
      {screen.again && (
        <Sub>
          Still asking after you accepted it? Then the host is not answering pages like this one:
          turn on Browser streaming in its console. Safari reaches a host this way only through a
          punktfunk server.
        </Sub>
      )}
      <a
        autoFocus
        className="break-all text-primary underline-offset-4 hover:underline"
        href={screen.url}
        target="_blank"
        rel="noopener"
      >
        {screen.url}
      </a>
      <Row>
        <Button variant="secondary" onClick={() => actions.back()}>Back</Button>
        <Button onClick={() => actions.retry()}>I have accepted it</Button>
      </Row>
    </Sheet>
  );
}

export function Pair({ screen, actions }: Props<"pair">): JSX.Element {
  const [pin, setPin] = useState("");
  const submit = () => { const v = pin.trim(); if (v) actions.pair(v); };
  const again = screen.mode === "again";
  return (
    <Sheet title={again ? "Pair with this host again" : "Pair with this host"}>
      <Sub>
        {again
          ? "This host no longer knows this browser — it was unpaired there. Enter the PIN it is showing to pair again."
          : "Enter the PIN this host is showing. It is on the host's own screen, and it expires after a couple of minutes."}
      </Sub>
      <Sub>No PIN? Request access, and approve this browser in the host's console.</Sub>
      {/* The console's PIN readout, as a field: it is copied off another screen digit by
          digit, and a mistyped one costs a whole pairing window. `h-auto!` because the input's
          own `h-input-height` is a token tailwind-merge cannot see as a height. */}
      <Input
        autoFocus
        type="text"
        inputMode="numeric"
        maxLength={8}
        placeholder="0000"
        autoComplete="one-time-code"
        aria-label="Pairing PIN"
        disabled={!!screen.busy}
        className="h-auto! rounded-lg bg-muted/40 py-5 text-center font-mono text-4xl font-semibold tracking-[0.3em] tabular-nums placeholder:text-muted-foreground/30 md:text-4xl"
        value={pin}
        onChange={(e) => setPin(e.currentTarget.value.replace(/\D/g, ""))}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      {screen.error && <ErrorLine text={screen.error} />}
      <Row>
        <Button variant="secondary" onClick={() => actions.back()}>Back</Button>
        <Button variant="secondary" disabled={!!screen.busy} onClick={() => actions.requestAccess()}>
          Request access
        </Button>
        <Button disabled={!!screen.busy} onClick={submit}>
          {screen.busy ? "Pairing…" : "Pair"}
        </Button>
      </Row>
    </Sheet>
  );
}

export function Waiting({ screen, actions }: Props<"waiting">): JSX.Element {
  return (
    <Sheet title="Waiting for approval">
      <Sub>
        Approve “{screen.name}” in the console of {bare(screen.origin)}, under Pairing. The
        stream starts as soon as you do. The request lapses after three minutes.
      </Sub>
      <Spinner className="mx-auto my-8 block size-12" />
      <Row>
        <Button autoFocus variant="secondary" onClick={() => actions.cancelRequest()}>Cancel</Button>
      </Row>
    </Sheet>
  );
}

// A trust moment, not an error. The host is answering but cannot prove it is the one this
// browser paired with, and the two explanations — a reinstalled machine, or something standing
// in the way of it — need different things from the person reading it.
export function Trust({ screen, actions }: Props<"trust">): JSX.Element {
  return (
    <Sheet title="This is not the same host">
      <Sub>
        Something is answering at {bare(screen.origin)}, but it cannot prove it is the machine
        this browser paired with.
      </Sub>
      <Sub>
        If you reinstalled punktfunk on it, or reset its configuration, that is expected — forget
        this host and pair again. If you did not, stop here: something else is answering at that
        address.
      </Sub>
      <Badge variant="outline">{screen.reason}</Badge>
      <Row>
        <Button autoFocus variant="secondary" onClick={() => actions.back()}>Back</Button>
        <Button variant="destructive" onClick={() => actions.forget(screen.origin)}>
          Forget and pair again
        </Button>
      </Row>
    </Sheet>
  );
}

export function LinkSheet({ screen, actions }: Props<"link">): JSX.Element {
  return (
    <Sheet title={`Connect to ${screen.name}?`}>
      <Sub>
        A link asks this browser to connect to {screen.address}
        {screen.launch ? ` and start ${screen.launch}` : ""}. Only go ahead if you opened it
        yourself.
      </Sub>
      <Row>
        <Button variant="secondary" onClick={() => actions.followLink(false)}>Cancel</Button>
        <Button autoFocus onClick={() => actions.followLink(true)}>Connect</Button>
      </Row>
    </Sheet>
  );
}

export function ErrorCard({ screen, actions }: Props<"error">): JSX.Element {
  return (
    <Sheet title={screen.head}>
      <Sub>{screen.text}</Sub>
      <Row>
        <Button autoFocus variant="secondary" onClick={() => actions.back()}>Back</Button>
        {screen.retry && <Button onClick={() => actions.retry()}>Try again</Button>}
      </Row>
    </Sheet>
  );
}

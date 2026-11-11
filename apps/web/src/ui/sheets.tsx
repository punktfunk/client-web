// The pages that are a question rather than a list: one sheet each, centred in the frame.

import { type JSX, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { m } from "../paraglide/messages.js";
import { bare, ErrorLine, Row, Sheet, Sub } from "./pieces.tsx";
import type { Actions, Screen } from "./types.ts";

type Props<K extends Screen["kind"]> = { screen: Extract<Screen, { kind: K }>; actions: Actions };

export function Connecting({ screen, actions }: Props<"connecting">): JSX.Element {
  const title =
    screen.phase === "reaching" ? m.browser_dial_reaching()
      : screen.phase === "starting" ? m.browser_dial_starting_stream()
      : m.dial_connecting();
  return (
    <Sheet title={title}>
      <Sub>{bare(screen.origin)}</Sub>
      <Spinner className="mx-auto my-8 block size-12" />
      <Row>
        <Button variant="secondary" onClick={() => actions.back()}>{m.common_cancel()}</Button>
      </Row>
    </Sheet>
  );
}

/** Who plays on a box with profiles. The saved pick leads, so it is where focus starts. */
export function Profiles({ screen, actions }: Props<"profiles">): JSX.Element {
  const cards = [...screen.cards].sort((a, b) => Number(b.id === screen.saved) - Number(a.id === screen.saved));
  return (
    <Sheet title={m.profile_title({ host: screen.host })}>
      {screen.gone && <Sub>{m.profile_gone({ name: screen.gone })}</Sub>}
      {screen.error ? (
        <ErrorLine text={screen.error} />
      ) : cards.length === 0 ? (
        <Sub>{m.profile_none()}</Sub>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3">
          {cards.map((c, i) => (
            <button
              key={c.id}
              type="button"
              autoFocus={i === 0}
              onClick={() => actions.pickProfile(c.id)}
              className="flex min-w-0 flex-col items-center gap-2 rounded-xl p-3 text-center outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={`grid size-16 place-items-center rounded-full text-lg font-bold text-white ${c.accent ? "" : "bg-brand"} ${c.id === screen.saved ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}
                style={c.accent ? { background: c.accent } : undefined}
                aria-hidden="true"
              >
                {c.picture ? (
                  <img src={c.picture} alt="" className="size-16 rounded-full object-cover" />
                ) : (
                  c.initials
                )}
              </span>
              <span className="w-full truncate font-semibold">{c.name}</span>
              {c.note && <span className="text-xs text-muted-foreground">{c.note}</span>}
            </button>
          ))}
        </div>
      )}
      <Row>
        <Button variant="secondary" autoFocus={cards.length === 0} onClick={() => actions.back()}>
          {cards.length ? m.common_cancel() : m.common_close()}
        </Button>
      </Row>
    </Sheet>
  );
}

/** A profile's seat coming up. Cancel is the way out; there is no timeout. */
export function SeatWait({ screen, actions }: Props<"seat">): JSX.Element {
  return (
    <Sheet title={screen.title}>
      {screen.detail && <Sub>{screen.detail}</Sub>}
      <Spinner className="mx-auto my-8 block size-12" />
      <Row>
        <Button variant="secondary" autoFocus onClick={() => actions.back()}>{m.common_cancel()}</Button>
      </Row>
    </Sheet>
  );
}

export function Accept({ screen, actions }: Props<"accept">): JSX.Element {
  return (
    <Sheet title={m.browser_accept_title()}>
      <Sub>{m.browser_accept_body()}</Sub>
      {screen.again && <Sub>{m.browser_accept_again()}</Sub>}
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
        <Button variant="secondary" onClick={() => actions.back()}>{m.common_back()}</Button>
        <Button onClick={() => actions.retry()}>{m.browser_accept_done()}</Button>
      </Row>
    </Sheet>
  );
}

export function Pair({ screen, actions }: Props<"pair">): JSX.Element {
  const [pin, setPin] = useState("");
  const submit = () => { const v = pin.trim(); if (v) actions.pair(v); };
  const again = screen.mode === "again";
  return (
    <Sheet title={again ? m.browser_pair_title_again() : m.pair_title({ host: bare(screen.origin) })}>
      <Sub>{again ? m.browser_pair_again_body() : m.pair_intro_pin_only()}</Sub>
      <Sub>{m.pair_no_pin_hint()}</Sub>
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
        aria-label={m.pair_pin()}
        disabled={!!screen.busy}
        className="h-auto! rounded-lg bg-muted/40 py-5 text-center font-mono text-4xl font-semibold tracking-[0.3em] tabular-nums placeholder:text-muted-foreground/30 md:text-4xl"
        value={pin}
        onChange={(e) => setPin(e.currentTarget.value.normalize("NFKC").replace(/\D/g, ""))}
        onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") submit(); }}
      />
      {screen.error && <ErrorLine text={screen.error} />}
      <Row>
        <Button variant="secondary" onClick={() => actions.back()}>{m.common_back()}</Button>
        <Button variant="secondary" disabled={!!screen.busy} onClick={() => actions.requestAccess()}>
          {m.pair_request_access()}
        </Button>
        <Button disabled={!!screen.busy} onClick={submit}>
          {screen.busy ? m.pair_pairing() : m.pair_action()}
        </Button>
      </Row>
    </Sheet>
  );
}

export function Waiting({ screen, actions }: Props<"waiting">): JSX.Element {
  return (
    <Sheet title={m.pair_waiting_for_approval()}>
      <Sub>{m.dial_approve_no_pin({ host: bare(screen.origin) })}</Sub>
      <Spinner className="mx-auto my-8 block size-12" />
      <Row>
        <Button autoFocus variant="secondary" onClick={() => actions.cancelRequest()}>{m.common_cancel()}</Button>
      </Row>
    </Sheet>
  );
}

// A trust moment, not an error. The host is answering but cannot prove it is the one this
// browser paired with, and the two explanations — a reinstalled machine, or something standing
// in the way of it — need different things from the person reading it.
export function Trust({ screen, actions }: Props<"trust">): JSX.Element {
  return (
    <Sheet title={m.trust_mismatch_title()}>
      <Sub>{m.browser_trust_body({ host: bare(screen.origin) })}</Sub>
      <Sub>{m.browser_trust_advice()}</Sub>
      <Badge variant="outline">{screen.reason}</Badge>
      <Row>
        <Button autoFocus variant="secondary" onClick={() => actions.back()}>{m.common_back()}</Button>
        <Button variant="destructive" onClick={() => actions.forget(screen.origin)}>
          {m.browser_trust_forget()}
        </Button>
      </Row>
    </Sheet>
  );
}

export function LinkSheet({ screen, actions }: Props<"link">): JSX.Element {
  return (
    <Sheet title={m.link_confirm_title()}>
      <Sub>
        {[
          m.link_confirm_asks({ host: screen.name, address: screen.address }),
          screen.launch ? m.link_confirm_launch({ game: screen.launch }) : "",
          m.link_confirm_guessable(),
        ]
          .filter(Boolean)
          .join(" ")}
      </Sub>
      <Row>
        <Button variant="secondary" onClick={() => actions.followLink(false)}>{m.common_cancel()}</Button>
        <Button autoFocus onClick={() => actions.followLink(true)}>{m.common_connect()}</Button>
      </Row>
    </Sheet>
  );
}

export function ErrorCard({ screen, actions }: Props<"error">): JSX.Element {
  return (
    <Sheet title={screen.head}>
      <Sub>{screen.text}</Sub>
      <Row>
        <Button autoFocus variant="secondary" onClick={() => actions.back()}>{m.common_back()}</Button>
        {screen.retry && <Button onClick={() => actions.retry()}>{m.common_retry()}</Button>}
      </Row>
    </Sheet>
  );
}

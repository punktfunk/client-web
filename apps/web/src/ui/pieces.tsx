// The handful of parts every screen is built from, on top of `components/ui`. The layout and the
// motion are the host console's: one bar across the top, a page titled the way its pages are, and
// siblings that arrive one after another.

import Section from "@unom/ui/section";
import { cn } from "@unom/ui/lib/utils";
import { motion } from "motion/react";
import { Children, isValidElement, type JSX, type ReactNode, useState } from "react";
import { ROW, ROW_GAP, Stagger } from "@/components/stagger";
import type { BadgeVariant } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Logo } from "./brand.tsx";
import type { HostCard } from "./types.ts";

/** Whether the brand's intro has played. Once a visit: replayed on every screen it would be noise. */
let introPlayed = false;

/** The bar across the top of every screen but the stream: the lockup, what this screen is about,
 *  and its actions on the right. */
export function TopBar({ title, children }: { title?: ReactNode; children?: ReactNode }): JSX.Element {
  const [intro] = useState(() => {
    const play = !introPlayed;
    introPlayed = true;
    return play;
  });
  return (
    <header className="sticky top-0 z-10 flex min-h-15 items-center gap-3 border-b border-border bg-card/40 px-inset py-3 backdrop-blur-xl">
      <Logo animate={intro} />
      {title && (
        <>
          <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        </>
      )}
      <span className="flex-1" />
      {children}
    </header>
  );
}

/** A screen with the bar on top; `bar` replaces the plain one when the screen has actions. */
export function Frame({ bar, children }: { bar?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-dvh w-full flex-col">
      {bar ?? <TopBar />}
      {children}
    </div>
  );
}

/** A page as the console lays one out: title, a line under it, actions on the right, then the
 *  content. `Section` drives the entrance, so cards and buttons inside it arrive in turn. */
export function Page({
  title,
  sub,
  actions,
  children,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <Section maxWidth={false} noPadding className="mx-auto w-full max-w-[1700px] px-inset py-6 sm:py-10">
      <div className="flex flex-col gap-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </Section>
  );
}

/** The screens that are a question rather than a list: the bar, then one sheet centred in what
 *  is left of the viewport. */
export function Centre({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Frame>
      <div className="grid w-full flex-1 place-items-center p-inset">{children}</div>
    </Frame>
  );
}

/** One centred glass panel with a heading and a short paragraph: connect, pair, trust, error.
 *  The card enters as the console's do, and its rows follow it in. The width is a reading
 *  measure: beyond about 32rem a single paragraph stops scanning cleanly. */
export function Sheet({
  title,
  mark,
  className,
  children,
}: {
  title: string;
  mark?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Stagger root className="w-full max-w-lg">
      <Card className={cn("w-full p-8", className)} aria-labelledby="pf-sheet-title">
        <Stagger gap={ROW_GAP} className="contents">
          {mark && (
            <motion.div variants={ROW} className="mb-6 self-center">
              <Logo size="lg" />
            </motion.div>
          )}
          <motion.h1 variants={ROW} id="pf-sheet-title" className="mb-2 text-xl font-semibold tracking-tight">
            {title}
          </motion.h1>
          {Children.toArray(children).map((child, i) => (
            <motion.div key={isValidElement(child) ? (child.key ?? i) : i} variants={ROW}>
              {child}
            </motion.div>
          ))}
        </Stagger>
      </Card>
    </Stagger>
  );
}

/** The paragraph under a sheet's title. */
export function Sub({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mb-5 text-muted-foreground">{children}</p>;
}

/** A sheet's button row. Each button takes an equal share, so a pair reads as a choice. */
export function Row({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-5 flex gap-2.5 *:flex-1">{children}</div>;
}

export function ErrorLine({ text }: { text: string }): JSX.Element {
  return <p role="alert" className="mt-3 text-sm text-destructive">{text}</p>;
}

/** Something is on its way: the brand spinner and a line, as the console waits. */
export function Loading({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner className="size-8" />
      {label}
    </div>
  );
}

/** Nothing to show, said in a card rather than left as a hole. */
export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <Card className="p-8 text-center text-sm text-muted-foreground">{children}</Card>;
}

/** A host without its scheme. Nothing on screen gains from the `https://`. */
export const bare = (origin: string): string => origin.replace(/^https:\/\//, "");

/** How long ago, in the roughest unit that is still true. A host seen four days ago does not
 *  need the hour. */
export function ago(at?: number): string {
  if (!at) return "never connected";
  const mins = (Date.now() - at) / 60000;
  if (mins < 2) return "just now";
  if (mins < 60) return `${Math.floor(mins)} min ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} h ago`;
  if (mins < 60 * 24 * 7) return `${Math.floor(mins / 1440)} d ago`;
  return new Date(at).toLocaleDateString();
}

/** A host's state as a badge and a word. Reachability and pairing are separate facts and the
 *  card shows whichever is the one standing in the way. */
export function status(h: HostCard): { variant: BadgeVariant; text: string } {
  if (h.reach === undefined) return { variant: "outline", text: "checking…" };
  if (h.reach === "unreachable") return { variant: "outline", text: "offline" };
  if (h.reach === "blocked") return { variant: "warning", text: "certificate not accepted" };
  return h.fingerprint ? { variant: "success", text: "online" } : { variant: "warning", text: "not paired" };
}

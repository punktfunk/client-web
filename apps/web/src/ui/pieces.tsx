// The handful of parts every page is built from, on top of `components/ui`. The frame and the
// page head are in `frame.tsx`; these are what goes on a page.

import { cn } from "@unom/ui/lib/utils";
import type { JSX, ReactNode } from "react";
import type { BadgeVariant } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { HostCard } from "./types.ts";

/** The pages that are a question rather than a list — connect, pair, trust, an error: one card,
 *  centred in the page. The width is a reading measure: beyond about 32rem a paragraph stops
 *  scanning cleanly. */
export function Sheet({ title, className, children }: { title: string; className?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="grid flex-1 place-items-center p-4 sm:p-10">
      <Card className={cn("w-full max-w-lg p-8", className)} aria-labelledby="pf-sheet-title">
        <h1 id="pf-sheet-title" className="mb-2 text-xl font-semibold tracking-tight">
          {title}
        </h1>
        {children}
      </Card>
    </div>
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
export function Empty({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <Card className="flex flex-col items-center gap-3 p-10 text-center text-sm text-muted-foreground">
      {title && <p className="text-base font-medium text-foreground">{title}</p>}
      {children}
    </Card>
  );
}

/** A host without its scheme. Nothing on screen gains from the `https://`. */
export const bare = (origin: string): string => origin.replace(/^https:\/\//, "");

/** What a host is called: the name someone gave it here, else its own, else its address. Two
 *  boxes on one network can answer to the same hostname; only the person can tell them apart. */
export const labelOf = (h: HostCard): string => h.label ?? h.name ?? bare(h.origin);

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

/** A host's state as a dot colour and a word. Reachability and pairing are separate facts and
 *  the card shows whichever is the one standing in the way. */
export function status(h: HostCard): { variant: BadgeVariant; text: string; dot: string } {
  if (h.waking) return { variant: "outline", text: "Waking…", dot: "bg-warning animate-pulse" };
  if (h.reach === undefined) return { variant: "outline", text: "Checking…", dot: "bg-muted-foreground/40" };
  if (h.reach === "unreachable") return { variant: "outline", text: h.wake ? "Offline · can wake" : "Offline", dot: "bg-muted-foreground/40" };
  if (h.reach === "blocked") return { variant: "warning", text: "Certificate not accepted", dot: "bg-warning" };
  return h.fingerprint
    ? { variant: "success", text: "Online", dot: "bg-success" }
    : { variant: "warning", text: "Not paired", dot: "bg-warning" };
}

// The handful of parts every screen is built from, on top of `components/ui`.

import { cn } from "@unom/ui/lib/utils";
import type { JSX, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import type { HostCard } from "./types.ts";

/** The punktfunk mark. The file carries its own dark-scheme colours, so it is an `<img>`
 *  rather than inlined SVG — nothing here needs to restyle it. The wordmark occupies only the
 *  bottom third of the lockup's box, so the mark is taller than it looks to leave "funk"
 *  legible; `aspect-ratio` because the file carries no intrinsic size. */
export function Mark({ className }: { className?: string }): JSX.Element {
  return (
    <img
      src="/punktfunk-logo.svg"
      alt="punktfunk"
      className={cn("h-12 w-auto aspect-[579/298]", className)}
    />
  );
}

/** The screens that are a question rather than a list centre one sheet against the viewport.
 *  `min-h-dvh` rather than `100%`: the shell is a grid whose track is content-sized on the
 *  screens that stretch, so a percentage height would resolve against the content and collapse. */
export function Centre({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid w-full min-h-dvh place-items-center p-inset">{children}</div>;
}

/** One centred glass panel with a heading and a short paragraph: connect, pair, trust, error.
 *  The width is a reading measure, not a layout — beyond about 32rem a single paragraph stops
 *  scanning cleanly. */
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
    <Card className={cn("w-full max-w-lg p-8", className)} aria-labelledby="pf-sheet-title">
      {mark && <Mark className="mb-5 h-14 self-center" />}
      <h1 id="pf-sheet-title" className="mb-2 text-xl font-semibold tracking-tight">{title}</h1>
      {children}
    </Card>
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
  return <p role="alert" className="mt-3 text-destructive">{text}</p>;
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

/** A host's state as a badge tint and a word. Reachability and pairing are separate facts and
 *  the card shows whichever is the one standing in the way. */
export function status(h: HostCard): { tint: "outline" | "success" | "warn"; text: string } {
  if (h.reach === undefined) return { tint: "outline", text: "checking…" };
  if (h.reach === "unreachable") return { tint: "outline", text: "offline" };
  if (h.reach === "blocked") return { tint: "warn", text: "certificate not accepted" };
  return h.fingerprint ? { tint: "success", text: "online" } : { tint: "warn", text: "not paired" };
}

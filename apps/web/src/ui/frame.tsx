// The frame every screen but the stream sits in: the host console's sidebar on the left, the page
// on the right. A 240 px sidebar from `lg`, an icon rail below it, a tab bar on a phone — the
// console's three widths (`web/src/components/app-shell.tsx`), so the two feel like one product.

import { cn } from "@unom/ui/lib/utils";
import { Gamepad2, LibraryBig, type LucideIcon, Monitor, Settings } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { BrandMark, Wordmark } from "./brand.tsx";
import type { Actions, Tab } from "./types.ts";

const ITEM =
  "group relative flex w-full items-center justify-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring lg:justify-start";
const ACTIVE = "bg-primary/15 font-medium text-foreground hover:bg-primary/15";

const TABS: ReadonlyArray<{ tab: Tab; icon: LucideIcon; label: string }> = [
  { tab: "hosts", icon: Monitor, label: "Hosts" },
  { tab: "library", icon: LibraryBig, label: "Library" },
  { tab: "settings", icon: Settings, label: "Settings" },
];

export function Frame({
  tab,
  host,
  actions,
  children,
}: {
  tab: Tab;
  /** The host the library belongs to, under the Library entry. */
  host?: string | undefined;
  actions: Actions;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-dvh">
      <aside className="hidden h-dvh w-16 shrink-0 flex-col border-r bg-card/40 p-2 sm:flex lg:w-60 lg:p-4">
        <div className="mb-7 flex items-center justify-center gap-2 px-2 pt-1 lg:justify-start" aria-label="punktfunk" role="img">
          <BrandMark className="size-7 shrink-0 drop-shadow-[0_2px_12px_rgba(108,91,243,0.45)]" animate={false} />
          <Wordmark className="hidden h-4 w-auto lg:block" animate={false} />
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {TABS.map(({ tab: t, icon: Icon, label }) => (
            <button
              key={t}
              type="button"
              title={label}
              aria-current={tab === t ? "page" : undefined}
              className={cn(ITEM, tab === t && ACTIVE)}
              onClick={() => actions.navigate(t)}
            >
              <Icon className="size-4 shrink-0" />
              <span className="hidden min-w-0 flex-1 text-left lg:block">
                <span className="block">{label}</span>
                {t === "library" && host && <span className="block truncate text-xs font-normal text-muted-foreground">{host}</span>}
              </span>
            </button>
          ))}
        </nav>
        <button
          type="button"
          title="Console mode — the controller interface"
          className={cn(ITEM, "mt-auto")}
          onClick={() => actions.consoleMode(true)}
        >
          <Gamepad2 className="size-4 shrink-0" />
          <span className="hidden lg:inline">Console mode</span>
        </button>
      </aside>

      {/* The page scrolls, the sidebar does not. `pb-20` leaves the phone's tab bar room. */}
      <main className="min-w-0 flex-1 overflow-y-auto overscroll-contain pb-20 sm:pb-0">{children}</main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-50 flex border-t bg-card/95 backdrop-blur sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {TABS.map(({ tab: t, icon: Icon, label }) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-xs text-muted-foreground",
              tab === t && "font-medium text-foreground",
            )}
            onClick={() => actions.navigate(t)}
          >
            <span className={cn("flex h-7 w-12 items-center justify-center rounded-full", tab === t && "bg-primary/15")}>
              <Icon className="size-5" />
            </span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** A page's head: title, one line under it, its actions on the right. */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** The page body: the console's measure and gutters. */
export function Body({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn("mx-auto flex w-full max-w-[1700px] flex-col gap-card px-4 py-6 sm:p-10", className)}>{children}</div>;
}

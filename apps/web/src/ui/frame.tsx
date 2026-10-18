// The frame every screen but the stream sits in: the host console's sidebar on the left, the page
// on the right. A 240 px sidebar from `lg`, an icon rail below it, a brand bar and a tab bar on a
// phone — the console's three widths (`web/src/components/app-shell.tsx`), and its motion: the
// sidebar's entries rise in turn on load, the phone's bar slides up with its tabs following, a
// press answers at once, and the pill behind the tab you are on slides across rather than
// blinking out and back. Keep the variants in step with that file.

import { cn } from "@unom/ui/lib/utils";
import { Gamepad2, LibraryBig, type LucideIcon, Monitor, Settings } from "lucide-react";
import { motion, stagger, type Variants } from "motion/react";
import type { JSX, ReactNode } from "react";
import { staggerProps } from "@/components/stagger";
import { BrandMark, Wordmark } from "./brand.tsx";
import type { Actions, Tab } from "./types.ts";

// Centred in the collapsed rail, where the label is hidden; left-aligned beside it from lg.
const ITEM =
  "group relative flex w-full items-center justify-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring lg:justify-start";
const ACTIVE = "bg-primary/15 font-medium text-foreground";
const RISE = { from: { opacity: 0, x: -20 }, enter: { opacity: 1, x: 0 } };

/** The phone bar slides up on load and its tabs rise in turn behind it, as the sidebar's items do. */
const BAR: Variants = {
  from: { y: "100%" },
  enter: {
    y: 0,
    transition: { type: "spring", bounce: 0, duration: 0.45, delayChildren: stagger(0.05, { startDelay: 0.1 }) },
  },
};
const TAB = { from: { opacity: 0, y: 12 }, enter: { opacity: 1, y: 0 } };

/** A press answers at once. Objects, never labels: a label would stop the item inheriting its entrance. */
const PRESS = { scale: 0.9 };
const HOVER = { scale: 1.02 };
const TAP = { scale: 0.98 };

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
      {/* Pinned at viewport height; the page beside it scrolls. `overflow-y-auto` lets the nav
          itself scroll on a very short viewport rather than push Console mode off the bottom. */}
      <aside className="hidden h-dvh w-16 shrink-0 flex-col overflow-y-auto border-r bg-card/40 p-2 sm:flex lg:w-60 lg:p-4">
        <div className="mb-7 flex items-center justify-center gap-2 px-2 pt-1 lg:justify-start" aria-label="punktfunk" role="img">
          <BrandMark className="size-7 shrink-0 drop-shadow-[0_2px_12px_rgba(108,91,243,0.45)]" animate={false} />
          <Wordmark className="hidden h-4 w-auto lg:block" animate={false} />
        </div>
        <motion.nav aria-label="Main" initial="from" animate="enter" {...staggerProps()} className="flex flex-1 flex-col gap-1">
          {TABS.map(({ tab: t, icon, label }) => (
            <SidebarItem
              key={t}
              icon={icon}
              label={label}
              sub={t === "library" ? host : undefined}
              active={tab === t}
              onClick={() => actions.navigate(t)}
            />
          ))}
          <SidebarItem
            icon={Gamepad2}
            label="Console mode"
            title="Console mode — the controller interface"
            className="mt-auto"
            onClick={() => actions.consoleMode(true)}
          />
        </motion.nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* A phone has no sidebar to carry the brand, so the console's top bar does. */}
        <header className="flex items-center gap-2 border-b bg-card/40 px-4 py-3 sm:hidden">
          <span className="flex items-center gap-2" role="img" aria-label="punktfunk">
            <BrandMark className="size-6" animate={false} />
            <Wordmark className="h-3.5 w-auto" animate={false} />
          </span>
        </header>
        {/* The page scrolls, the sidebar does not. `pb-20` leaves the phone's tab bar room. */}
        <main className="min-w-0 flex-1 overflow-y-auto overscroll-contain pb-20 sm:pb-0">{children}</main>
      </div>

      <motion.nav
        aria-label="Main"
        initial="from"
        animate="enter"
        variants={BAR}
        className="fixed inset-x-0 bottom-0 z-50 flex border-t bg-card/95 backdrop-blur sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {TABS.map(({ tab: t, icon: Icon, label }) => (
          <motion.button
            key={t}
            type="button"
            variants={TAB}
            whileTap={PRESS}
            aria-current={tab === t ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 px-0.5 py-2 text-xs text-muted-foreground transition-colors",
              tab === t && "font-medium text-foreground",
            )}
            onClick={() => actions.navigate(t)}
          >
            <TabIcon active={tab === t}>
              <Icon className="size-5 shrink-0" />
            </TabIcon>
            <span className="w-full truncate text-center leading-tight">{label}</span>
          </motion.button>
        ))}
      </motion.nav>
    </div>
  );
}

/** One entry in the sidebar: it rises in with its siblings, answers a hover and a press, and
 *  brightens under the pointer — a brand-tinted wash OVER whatever its background is, so the
 *  active one gets lighter too. */
function SidebarItem({
  icon: Icon,
  label,
  title,
  sub,
  active = false,
  className,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  /** A second line under the label, where there is room for one. */
  sub?: string | undefined;
  active?: boolean;
  className?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <motion.button
      type="button"
      variants={RISE}
      whileHover={HOVER}
      whileTap={TAP}
      title={title ?? label}
      aria-current={active ? "page" : undefined}
      className={cn(ITEM, active && ACTIVE, className)}
      onClick={onClick}
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-md bg-primary/0 transition-colors duration-200 group-hover:bg-primary/15" />
      <Icon className="relative size-4 shrink-0" />
      <span className="relative hidden min-w-0 flex-1 text-left lg:block">
        <span className="block">{label}</span>
        {sub && <span className="block truncate text-xs font-normal text-muted-foreground">{sub}</span>}
      </span>
    </motion.button>
  );
}

/**
 * A tab's icon, over the pill that marks the page you are on. The pill is one shared `layoutId`,
 * so switching tabs slides it across instead of blinking it out and back in.
 */
function TabIcon({ active, children }: { active: boolean; children: ReactNode }): JSX.Element {
  return (
    <span className="relative flex h-7 w-12 items-center justify-center">
      {active && (
        <motion.span
          layoutId="tab-pill"
          className="absolute inset-0 rounded-full bg-primary/15"
          transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
        />
      )}
      <span className="relative">{children}</span>
    </span>
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

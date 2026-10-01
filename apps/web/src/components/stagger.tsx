// The console's on-mount cadence (`web/src/components/stagger.tsx`), kept in step with that file:
// siblings arrive one after another, not all on the same frame.
//
// Every animated primitive here (`Card`, `Button` — all `@unom/ui`) is a motion element whose
// `from`/`enter` variants are INHERITED from the nearest motion ancestor, and it is that ancestor
// which owns the timing. Nothing animates until something above it says `from → enter`; the
// console's pages get that from `@unom/ui`'s `<Section>`, and this shell gets it from the
// `<Stagger root>` around every page (`shell.tsx`), the dialog surface, and each settings tab.

import { type HTMLMotionProps, motion, stagger } from "motion/react";
import type { FC } from "react";

/** The house cadence, in seconds between siblings. */
export const STAGGER_GAP = 0.1;

/** Rows are lighter than cards: a tighter gap, a shorter rise. */
export const ROW_GAP = 0.05;
export const ROW = { from: { opacity: 0, y: 6 }, enter: { opacity: 1, y: 0 } };

/** A pass-through group: it moves nothing itself, and everything inside it arrives together at
 *  the group's own slot in the cascade. For a list item that holds a card and a button beside
 *  it, which would otherwise take two slots. */
export const GROUP = { from: {}, enter: {} };

/**
 * The stagger-container contract as plain props — for the places that need a specific element
 * (`motion.ul`, `motion.nav`) rather than the `<Stagger>` div below.
 *
 * The empty `enter`/`from` variants are not a placeholder: a motion element only PROPAGATES a
 * variant it names, so a container that defines none stops the cascade dead and its children
 * never animate at all.
 */
export const staggerProps = (gap: number = STAGGER_GAP) => ({
  variants: GROUP,
  transition: { delayChildren: stagger(gap) },
});

/**
 * The trap this exists for: an `AnimatedCard` is ALSO a motion element, and it sets no
 * `delayChildren` — so a grid of cards nested inside a card becomes its own timing group and
 * every tile lands at once. Wrapping the grid re-establishes the cadence.
 *
 * `root` is for a group with no animating motion ancestor, or one whose ancestor may no longer be
 * driving when it mounts: it runs `from → enter` itself. A page and a tab panel are the clear
 * cases; a dialog is not, since `DialogContent` drives its rows. Inside a page or a card, leave
 * it off — there it would run on its own clock instead of the page's.
 *
 * A group that mounts late still staggers, through plain wrappers too. A child that mounts after
 * its container animated does not: it enters alone, at once. So a container whose children wait
 * for data renders inside the loaded branch, with them. A child that names a variant label of
 * its own (`exit="exit"` counts) stops inheriting; give it an object instead.
 */
export const Stagger: FC<
  HTMLMotionProps<"div"> & {
    /** Seconds between siblings. */
    gap?: number;
    /** Drive the enter animation instead of inheriting it — see above. */
    root?: boolean;
  }
> = ({ gap, root = false, transition, ...props }) => {
  const base = staggerProps(gap);
  return (
    <motion.div
      {...(root ? { initial: "from", animate: "enter" } : {})}
      variants={base.variants}
      transition={{ ...base.transition, ...transition }}
      {...props}
    />
  );
};

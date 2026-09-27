// The console's on-mount cadence (`web/src/components/stagger.tsx` in the monorepo), so the two
// UIs arrive the same way. Keep the numbers in step with that file.

import { type HTMLMotionProps, motion, stagger } from "motion/react";
import type { JSX } from "react";

/** The house cadence, in seconds between siblings. */
export const STAGGER_GAP = 0.1;

/** Rows are lighter than cards: a tighter gap, a shorter rise. */
export const ROW_GAP = 0.05;
export const ROW = { from: { opacity: 0, y: 6 }, enter: { opacity: 1, y: 0 } };

/**
 * The stagger-container contract as plain props. The empty `enter`/`from` variants are not a
 * placeholder: a motion element only propagates a variant it names, so a container that defines
 * none stops the cascade and its children never animate.
 */
export const staggerProps = (gap: number = STAGGER_GAP) => ({
  variants: { enter: {}, from: {} },
  transition: { delayChildren: stagger(gap) },
});

/**
 * Siblings arrive one after another. Every `@unom/ui` primitive (`Card`, `Button`) inherits its
 * `from`/`enter` variants from the nearest motion ancestor, which owns the timing; a card is one
 * too and sets no `delayChildren`, so a grid inside a card lands all at once without this.
 *
 * `root` drives `from → enter` itself, for a group with no animating ancestor: a dialog (it
 * renders through a portal) or a grid that mounts once its data arrives.
 */
export function Stagger({
  gap,
  root = false,
  transition,
  ...props
}: HTMLMotionProps<"div"> & { gap?: number; root?: boolean }): JSX.Element {
  const base = staggerProps(gap);
  return (
    <motion.div
      {...(root ? { initial: "from", animate: "enter" } : {})}
      variants={base.variants}
      transition={{ ...base.transition, ...transition }}
      {...props}
    />
  );
}

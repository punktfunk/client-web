import { AnimatedCard } from "@unom/ui/card";
import { cn } from "@unom/ui/lib/utils";
import type { ComponentProps } from "react";

// The client's Card IS @unom/ui's animated card, as the console wears it: the opaque brand
// surface with its 2px ring softened to a 1px tint, plus a short shadow to lift it off the
// client's darker ground. It used to be glass — a translucent surface over a blurred backdrop —
// which cost a backdrop filter per card for a blur of a gradient that never moves, and a 64px
// shadow that every scroller on the page cut off at its edge.
//
// `padding` defaults off as in the console, so a screen owns its own inset.
type CardProps = ComponentProps<typeof AnimatedCard>;

export const Card = ({ className, padding = false, children, ...props }: CardProps) => (
  <AnimatedCard
    padding={padding}
    className={cn("ring-1 ring-accent/40 shadow-[0_8px_24px_rgb(0_0_0/0.35)]", className)}
    {...props}
  >
    {children}
  </AnimatedCard>
);
Card.displayName = "Card";

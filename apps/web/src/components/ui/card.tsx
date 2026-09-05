import { AnimatedCard } from "@unom/ui/card";
import { cn } from "@unom/ui/lib/utils";
import type { ComponentProps } from "react";

// The client's Card IS @unom/ui's animated card, worn as glass: the console's surface made
// translucent with a blurred backdrop, because every panel here sits over the aurora or over a
// live picture, and an opaque card in front of a game is a hole in it.
//
// `padding` defaults off as in the console, so a screen owns its own inset.
type CardProps = ComponentProps<typeof AnimatedCard>;

export const Card = ({ className, padding = false, children, ...props }: CardProps) => (
  <AnimatedCard
    padding={padding}
    className={cn(
      "bg-card/75 backdrop-blur-xl ring-1 ring-accent/40 shadow-[0_24px_64px_rgb(0_0_0/0.55)]",
      className,
    )}
    {...props}
  >
    {children}
  </AnimatedCard>
);
Card.displayName = "Card";

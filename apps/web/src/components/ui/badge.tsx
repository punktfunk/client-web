// The console's Badge (`web/src/components/ui/badge.tsx`): a small squared label, status by
// colour. No dots — the console marks state with the word and its tint.

import { cn } from "@unom/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, JSX } from "react";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        success: "border-transparent bg-[var(--success)] text-white",
        // Amber is light in both themes; white on it fails contrast.
        warning: "border-transparent bg-[var(--warning)] text-black",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

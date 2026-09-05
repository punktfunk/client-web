import { AnimatedButton, buttonVariants } from "@unom/ui/button";
import { cn } from "@unom/ui/lib/utils";
import type { ComponentProps } from "react";

// The client's Button IS @unom/ui's animated button — pill shape, material gloss, the shared
// brand tokens — with the console's one correction: make `disabled` VISIBLE.
//
// `AnimatedButton` is a motion element whose mount animation settles as an inline `opacity: 1`,
// which outranks the `disabled:opacity-50` the library ships. `!important` is the one thing that
// beats an inline declaration.
export type ButtonProps = ComponentProps<typeof AnimatedButton>;

export const Button = ({ className, ...props }: ButtonProps) => (
  <AnimatedButton className={cn("disabled:opacity-50!", className)} {...props} />
);
Button.displayName = "Button";

export { buttonVariants };

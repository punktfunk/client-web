// A card's "more" menu: radix's dropdown on the popover surface, the Select's highlighted row.
// @unom/ui has no menu of its own, so this is the one part styled here.
import { cn } from "@unom/ui/lib/utils";
import { Check } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ComponentProps } from "react";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

const ITEM = cn(
  "flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 outline-none select-none",
  "focus:bg-primary/15 focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
);

export const MenuContent = ({ className, ...props }: ComponentProps<typeof DropdownMenu.Content>) => (
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      sideOffset={6}
      align="end"
      className={cn(
        "z-100 min-w-48 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        className,
      )}
      {...props}
    />
  </DropdownMenu.Portal>
);

export const MenuItem = ({ className, ...props }: ComponentProps<typeof DropdownMenu.Item>) => (
  <DropdownMenu.Item className={cn(ITEM, className)} {...props} />
);

/** One choice of a radio group: the check sits in the gutter, so rows line up checked or not. */
export const MenuRadioItem = ({ className, children, ...props }: ComponentProps<typeof DropdownMenu.RadioItem>) => (
  <DropdownMenu.RadioItem className={cn(ITEM, "relative pl-8", className)} {...props}>
    <DropdownMenu.ItemIndicator className="absolute top-2.5 left-2.5 flex">
      <Check className="text-primary!" />
    </DropdownMenu.ItemIndicator>
    {children}
  </DropdownMenu.RadioItem>
);

/** A group's heading: not focusable, not a choice. */
export const MenuLabel = ({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) => (
  <DropdownMenu.Label className={cn("px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground", className)} {...props} />
);

export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 h-px bg-border" />;

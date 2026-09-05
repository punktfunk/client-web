// The client's Select IS @unom/ui's radix select, with the console's two corrections — @unom/ui's
// palette names do not all mean the same thing in this token set:
//
//   • `text-secondary`, which the trigger uses for the placeholder and the chevron, is a *text*
//     colour upstream. Here `--secondary` is a SURFACE, so the chevron vanished against the card.
//   • `border-main` is the foreground colour — a near-white 1px border, which would shout next
//     to the `border-input` every Input beside it uses.
//
// The trigger also defaults to `w-full`: in this client a select is a form field in a stacked
// column, never an inline chip.
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem as SelectItemBase,
  SelectLabel,
  SelectTrigger as SelectTriggerBase,
  SelectValue,
} from "@unom/ui/form/select";
import { cn } from "@unom/ui/lib/utils";
import type { ComponentProps } from "react";

const SelectTrigger = ({ className, ...props }: ComponentProps<typeof SelectTriggerBase>) => (
  <SelectTriggerBase
    className={cn(
      "w-full rounded-md border-input data-placeholder:text-muted-foreground",
      "[&_svg:not([class*='text-'])]:text-muted-foreground",
      className,
    )}
    {...props}
  />
);
SelectTrigger.displayName = "SelectTrigger";

// The highlighted row, in brand violet rather than upstream's grey `bg-main/25` wash.
const SelectItem = ({ className, ...props }: ComponentProps<typeof SelectItemBase>) => (
  <SelectItemBase className={cn("focus:bg-primary/15 focus:text-foreground", className)} {...props} />
);
SelectItem.displayName = "SelectItem";

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue };

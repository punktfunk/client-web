// The client's Tabs ARE @unom/ui's radix tabs, with the console's one correction: @unom/ui draws
// inactive triggers `text-secondary`, which in this palette is a surface colour, so every
// inactive tab would vanish into the strip behind it.
import { cn } from "@unom/ui/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger as TabsTriggerBase } from "@unom/ui/tabs";
import type { ComponentProps } from "react";

const TabsTrigger = ({ className, ...props }: ComponentProps<typeof TabsTriggerBase>) => (
  <TabsTriggerBase
    className={cn("text-muted-foreground hover:text-foreground data-[state=active]:text-foreground", className)}
    {...props}
  />
);
TabsTrigger.displayName = "TabsTrigger";

export { Tabs, TabsContent, TabsList, TabsTrigger };

// The client's Dialog IS @unom/ui's radix dialog. @unom/ui ships the SURFACE only and leaves
// placement to the app, so `DialogContent` here is the surface already wrapped in its portal +
// overlay and centred in the viewport, with the console's cadence: the surface zooms in whole,
// and its rows — header, body, footer — rise in turn behind it.
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogContent as DialogSurface,
  DialogTitle,
} from "@unom/ui/dialog";
import { cn } from "@unom/ui/lib/utils";
import { motion } from "motion/react";
import { Children, type ComponentProps, isValidElement } from "react";
import { ROW, ROW_GAP, Stagger } from "@/components/stagger";

const DialogContent = ({ className, children, ...props }: ComponentProps<typeof DialogSurface>) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogSurface
      className={cn(
        "fixed left-1/2 top-1/2 z-100 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto p-6",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-150",
        className,
      )}
      {...props}
    >
      {/* `root`, because a dialog renders through a portal — outside every page cascade, nothing
          above it drives `from → enter`. `contents` keeps each row a flex item of the surface, so
          its gap still spaces them. */}
      <Stagger root gap={ROW_GAP} className="contents">
        {Children.toArray(children).map((child, i) => (
          <motion.div key={isValidElement(child) ? (child.key ?? i) : i} variants={ROW}>
            {child}
          </motion.div>
        ))}
      </Stagger>
    </DialogSurface>
  </DialogPortal>
);
DialogContent.displayName = "DialogContent";

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };

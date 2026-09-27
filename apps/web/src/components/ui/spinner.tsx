// The console's spinner (`web/src/components/ui/spinner.tsx`): the brand lens, alive. Its two
// circles orbit on a path whose long axis points into the screen, so each surges toward and away
// from the viewer in antiphase. The depth is faked with a perspective `scale()` and a z-index,
// because `mix-blend-mode` flattens a preserve-3d context in some browsers. Size via className.

import { cn } from "@unom/ui/lib/utils";
import { motion, useReducedMotion, useTime, useTransform } from "motion/react";
import { type HTMLAttributes, type JSX, useEffect, useRef } from "react";

const DURATION_MS = 1600;
const R_DEPTH = 0.34;
const PERSP = 1.05;
const R_PLANE_FIXED = 0.12;
const R_PLANE_SWAY = 0.05;
const DIAG: readonly [number, number] = [-Math.SQRT1_2, Math.SQRT1_2];
const LOBE_FRAC = 0.58;

export function Spinner({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const size = useRef(0);
  const time = useTime();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    size.current = el.clientWidth;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) size.current = w;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reduced motion parks flat: the widest lens, no depth, which is the still brand mark.
  const angleAt = (t: number) => (reduce ? 0 : (t / DURATION_MS) * Math.PI * 2);
  const depthAt = (t: number, side: number) => side * Math.sin(angleAt(t)) * R_DEPTH;
  const transformAt = (t: number, side: number) => {
    const angle = angleAt(t);
    const p = PERSP / (PERSP - depthAt(t, side));
    const mag = (R_PLANE_FIXED + R_PLANE_SWAY * Math.cos(angle)) * side;
    return `translate(-50%, -50%) translate(${mag * DIAG[0] * p * size.current}px, ${mag * DIAG[1] * p * size.current}px) scale(${p})`;
  };

  const light = useTransform(time, (t) => transformAt(t, 1));
  const deep = useTransform(time, (t) => transformAt(t, -1));
  const zLight = useTransform(time, (t) => Math.round(depthAt(t, 1) * 1000));
  const zDeep = useTransform(time, (t) => Math.round(depthAt(t, -1) * 1000));
  const lobe = (color: string) => ({
    width: `${LOBE_FRAC * 100}%`,
    height: `${LOBE_FRAC * 100}%`,
    backgroundColor: color,
    mixBlendMode: "screen" as const,
  });

  return (
    <div
      ref={ref}
      role="status"
      aria-label="Loading"
      className={cn("relative isolate inline-block size-6", className)}
      {...props}
    >
      <motion.div
        className="absolute top-1/2 left-1/2 rounded-full"
        style={{ ...lobe("var(--pf-brand-light)"), transform: light, zIndex: zLight }}
      />
      <motion.div
        className="absolute top-1/2 left-1/2 rounded-full"
        style={{ ...lobe("var(--pf-brand)"), transform: deep, zIndex: zDeep }}
      />
    </div>
  );
}

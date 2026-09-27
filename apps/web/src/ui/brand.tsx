// The punktfunk lockup as the website's header draws it: the lens mark, then the "funk" wordmark.
// Both are ported from punktfunk-website `src/components/{BrandMark,Wordmark}.tsx`; keep the paths
// and timings in step with that repo rather than redrawing them here.

import { cn } from "@unom/ui/lib/utils";
import { animate as animateValue, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { type JSX, useEffect, useId } from "react";

// Two overlapping circles forming a lens. Back to front: light violet, deep purple, the overlap.
const LIGHT =
  "M403.037,791.672c107.586,0 194.41,-86.824 194.41,-194.41c0,-107.586 -86.824,-194.41 -194.41,-194.41c-107.586,0 -194.41,86.824 -194.41,194.41c0,107.586 86.824,194.41 194.41,194.41Z";
const DEEP =
  "M735.276,540.321c76.075,-76.075 76.075,-198.862 0,-274.937c-76.075,-76.075 -198.862,-76.075 -274.937,0c-76.075,76.075 -76.075,198.862 0,274.937c76.075,76.075 198.862,76.075 274.937,0Z";
const OVERLAP =
  "M647.84,590.737c-64.853,17.403 -136.871,0.597 -187.885,-50.416c-51.013,-51.013 -67.819,-123.032 -50.416,-187.885c64.853,-17.403 136.871,-0.597 187.885,50.416c51.013,51.013 67.819,123.032 50.416,187.885Z";

// The intro orbit. Its resting angle (2π) is the identity, so it lands exactly on the still mark.
const R_DEPTH = 0.34;
const PERSP = 1.05;
const SWAY = 0.06;
const DIAG = [-Math.SQRT1_2, Math.SQRT1_2] as const;
const U = 1000;
const DURATION = 1.3;
const END = Math.PI * 2;

function orbitTransform(a: number, side: number): string {
  const z = side * Math.sin(a) * R_DEPTH;
  const p = PERSP / (PERSP - z);
  const mag = side * SWAY * (Math.cos(a) - 1);
  return `translate(${mag * DIAG[0] * U * p}px, ${mag * DIAG[1] * U * p}px) scale(${p})`;
}

const origin = { transformBox: "fill-box", transformOrigin: "center" } as const;

export function BrandMark({ className, animate }: { className: string; animate: boolean }): JSX.Element {
  const angle = useMotionValue(animate ? 0 : END);
  useEffect(() => {
    if (!animate) return;
    const controls = animateValue(angle, END, { duration: DURATION, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [angle, animate]);
  const light = useTransform(angle, (a) => orbitTransform(a, 1));
  const deep = useTransform(angle, (a) => orbitTransform(a, -1));
  return (
    <svg viewBox="0 0 1000 1000" className={className} aria-hidden="true">
      <motion.path d={LIGHT} fill="#a79ff8" style={{ transform: light, ...origin }} />
      <motion.path d={DEEP} fill="#6c5bf3" style={{ transform: deep, ...origin }} />
      {/* The overlap only reads once the circles settle, so it fades in over the orbit's tail. */}
      <motion.path
        d={OVERLAP}
        fill="#d2c9fb"
        initial={animate ? { opacity: 0, scale: 0.6 } : false}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.45, delay: DURATION * 0.6, ease: "easeOut" }}
        style={origin}
      />
    </svg>
  );
}

// Each letter with the horizontal extent of its own box: animating, a letter slides in from the
// right, clipped to that box.
const LETTERS = [
  { x: 16.78, w: 108.54, d: "M16.782,16.051l0,102.687l31.253,0l0,-35.563l73.436,0l0,-23.555l-73.436,0l0,-19.398l77.285,0l0,-24.171l-108.537,0Z" },
  { x: 131.78, w: 133.33, d: "M131.785,16.051l0,47.264c0.154,16.627 0.154,16.627 0.308,20.014c0.77,15.087 2.463,21.4 7.544,26.634c7.698,8.16 20.014,10.315 59.272,10.315c23.863,0 34.178,-0.616 43.415,-2.463c11.7,-2.463 19.552,-10.623 21.246,-22.323c0.924,-7.236 1.078,-8.929 1.54,-32.176l0,-47.264l-31.253,0l0,47.264c0,2.155 -0.154,7.082 -0.308,10.623c-0.462,9.699 -1.232,12.47 -3.695,15.087c-3.387,3.695 -9.853,4.619 -31.407,4.619c-26.634,0 -32.638,-1.693 -34.332,-9.853c-0.77,-4.157 -0.77,-4.311 -1.078,-20.476l0,-47.264l-31.253,0Z" },
  { x: 271.58, w: 142.87, d: "M271.575,15.943l0,102.687l31.868,0l-0.77,-76.669l3.387,0l54.038,76.669l54.346,0l0,-102.687l-31.868,0l0.77,76.515l-3.233,0l-53.73,-76.515l-54.808,0Z" },
  { x: 420.91, w: 141.79, d: "M420.91,15.943l0,102.687l31.253,0l0,-39.258l17.089,0l46.032,39.258l47.418,0l-64.353,-52.344l59.426,-50.959l-47.88,0l-40.644,37.873l-17.089,0l0,-37.257l-31.253,0Z" },
];

export function Wordmark({ className, animate }: { className: string; animate: boolean }): JSX.Element {
  // Unique per wordmark on the page; React's colons are not safe inside `url(#…)`.
  const uid = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 579 136" fill="currentColor" className={cn("text-highlight", className)} aria-hidden="true">
      {animate && (
        <defs>
          {LETTERS.map((l, i) => (
            <clipPath key={l.x} id={`${uid}-${i}`} clipPathUnits="userSpaceOnUse">
              <rect x={l.x} y={0} width={l.w} height={136} />
            </clipPath>
          ))}
        </defs>
      )}
      {LETTERS.map((l, i) =>
        animate ? (
          <g key={l.x} clipPath={`url(#${uid}-${i})`}>
            <motion.path
              d={l.d}
              initial={{ x: l.w }}
              animate={{ x: 0 }}
              transition={{ duration: 0.55, delay: 0.15 + i * 0.09, ease: [0.16, 1, 0.3, 1] }}
            />
          </g>
        ) : (
          <path key={l.x} d={l.d} />
        ),
      )}
    </svg>
  );
}

const SIZES = {
  md: { mark: "size-8", word: "h-5", gap: "gap-2" },
  lg: { mark: "size-12", word: "h-8", gap: "gap-3" },
} as const;

/** The lockup. `animate` plays the website's one-shot intro on mount; reduced motion shows it still. */
export function Logo({
  className,
  size = "md",
  animate = false,
}: {
  className?: string;
  size?: keyof typeof SIZES;
  animate?: boolean;
}): JSX.Element {
  const reduce = useReducedMotion();
  const play = animate && !reduce;
  const s = SIZES[size];
  return (
    <span role="img" aria-label="punktfunk" className={cn("flex shrink-0 items-center", s.gap, className)}>
      <BrandMark className={s.mark} animate={play} />
      <Wordmark className={cn(s.word, "w-auto")} animate={play} />
    </span>
  );
}

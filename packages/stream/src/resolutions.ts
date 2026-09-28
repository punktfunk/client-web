// Stream sizes grouped by shape, and the rule a typed size goes through. The twin of
// `punktfunk_core::resolutions`: the same families, sizes and limits, so a size picked or typed
// here asks the host for what every other client would.

/** One family of sizes with the same shape, ascending. Every side is even: the host refuses odd. */
export interface Aspect {
  label: string;
  ratio: readonly [number, number];
  sizes: ReadonlyArray<readonly [number, number]>;
}

/** The families in the order the switch shows them, most common first. */
export const ASPECTS: ReadonlyArray<Aspect> = [
  { label: "16:9", ratio: [16, 9], sizes: [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [5120, 2880]] },
  { label: "16:10", ratio: [16, 10], sizes: [[1280, 800], [1920, 1200], [2560, 1600], [2880, 1800], [3840, 2400]] },
  { label: "21:9", ratio: [21, 9], sizes: [[2560, 1080], [3440, 1440], [3840, 1600], [5120, 2160]] },
  { label: "32:9", ratio: [32, 9], sizes: [[3840, 1080], [5120, 1440], [7680, 2160]] },
  { label: "3:2", ratio: [3, 2], sizes: [[2160, 1440], [2256, 1504], [2880, 1920], [3000, 2000]] },
  { label: "4:3", ratio: [4, 3], sizes: [[1024, 768], [1600, 1200], [2048, 1536]] },
];

/** "21:9" panels are really 2.37–2.40; 4 % keeps them together and still parts 16:10 from 3:2. */
const TOLERANCE = 0.04;

/** The family `w`×`h` belongs to by shape, not by membership. `-1` for a zero side or no match. */
export function aspectOf(w: number, h: number): number {
  if (w <= 0 || h <= 0) return -1;
  return ASPECTS.findIndex((a) => Math.abs(w / h / (a.ratio[0] / a.ratio[1]) - 1) < TOLERANCE);
}

/** The size in family `aspect` nearest in height to `h`; `0` looks for 1080. Ties go smaller. */
export function nearest(aspect: number, h: number): readonly [number, number] {
  const want = h || 1080;
  const sizes = ASPECTS[aspect]?.sizes ?? ASPECTS[0]!.sizes;
  return sizes.reduce((best, s) => (Math.abs(s[1] - want) < Math.abs(best[1] - want) ? s : best));
}

/** Smallest stream mode the host accepts, per side. */
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 200;

/** A typed size as a mode the host takes: at least 320 × 200, at most the codec's ceiling per
 *  side (4096 for H.264, 8192 otherwise), then floored even. */
export function customSize(w: number, h: number, codec: string): [number, number] {
  const max = codec === "h264" ? 4096 : 8192;
  const side = (n: number, min: number) => Math.floor(Math.min(max, Math.max(min, Math.floor(n) || 0)) / 2) * 2;
  return [side(w, MIN_WIDTH), side(h, MIN_HEIGHT)];
}

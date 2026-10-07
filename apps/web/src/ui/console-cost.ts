// What a console frame costs on this device, and which part of the picture costs it.
//
// A meter that closes a run of frames into one line for the page's log, and a sweep that walks
// what the console can leave out on the screen that is showing — a few seconds each — into a
// table. Both are arithmetic over times the caller measured; neither touches the page or the
// console.

/** A closed run of frames: how many were drawn, how fast, and the main thread's time in each. */
export interface FrameWindow {
  frames: number;
  seconds: number;
  fps: number;
  meanMs: number;
  peakMs: number;
}

export class FrameMeter {
  private frames = 0;
  private sum = 0;
  private peak = 0;
  private since = -1;

  /** One drawn frame that took `ms`. Returns the window once it has run `windowMs`. */
  add(ms: number, now: number, windowMs: number): FrameWindow | null {
    if (this.since < 0) this.since = now;
    this.frames++;
    this.sum += ms;
    this.peak = Math.max(this.peak, ms);
    const ran = now - this.since;
    if (ran < windowMs) return null;
    const out = {
      frames: this.frames,
      seconds: ran / 1000,
      // The first frame opens the window, so `frames - 1` intervals fill it.
      fps: ((this.frames - 1) * 1000) / ran,
      meanMs: this.sum / this.frames,
      peakMs: this.peak,
    };
    this.reset();
    return out;
  }

  reset(): void {
    this.frames = 0;
    this.sum = 0;
    this.peak = 0;
    this.since = -1;
  }
}

/** One thing to price: what a running console is told to leave out, and how small it draws. */
export interface Step {
  name: string;
  /** The blur behind pinned chrome. */
  blur: boolean;
  /** Motion. Without it the backdrop renders once and stays. */
  motion: boolean;
  /** The drawing buffer's share of the canvas, each way. */
  scale: number;
}

/** Each row removes one more thing a running console can do without. */
export const STEPS: readonly Step[] = [
  { name: "as started", blur: true, motion: true, scale: 1 },
  { name: "still backdrop", blur: true, motion: false, scale: 1 },
  { name: "no blur", blur: false, motion: true, scale: 1 },
  { name: "no blur, still backdrop", blur: false, motion: false, scale: 1 },
  { name: "no blur, still, 2/3 size", blur: false, motion: false, scale: 2 / 3 },
];

/**
 * A step's measurement, per frame: the main thread drawing (`cpuMs`), the main thread busy
 * with anything else long enough to delay a frame (`otherMs`), and the rest of the interval
 * (`waitMs`), which is the GPU or the compositor making the page wait.
 */
export interface Row {
  step: string;
  fps: number;
  cpuMs: number;
  otherMs: number;
  waitMs: number;
}

/** A step settles, then is counted. */
const SETTLE_MS = 1000;
const RUN_MS = 4000;

export class Sweep {
  readonly rows: Row[] = [];
  private readonly steps: readonly Step[];
  private at = 0;
  private settled = false;
  private since: number;
  private readonly meter = new FrameMeter();
  private other = 0;

  constructor(now: number, steps: readonly Step[] = STEPS) {
    this.steps = steps;
    this.since = now;
  }

  /** The step to draw as now; `undefined` once every step has run. */
  get step(): Step | undefined {
    return this.steps[this.at];
  }

  /** One drawn frame that took `ms`, with `otherMs` of long tasks that were not it since the
   *  last one. `true` when the step to draw as has changed. */
  frame(ms: number, now: number, otherMs = 0): boolean {
    const step = this.step;
    if (!step) return false;
    if (!this.settled) {
      this.settled = now - this.since >= SETTLE_MS;
      this.other = 0;
      return false;
    }
    this.other += otherMs;
    const ran = this.meter.add(ms, now, RUN_MS);
    if (!ran) return false;
    const other = this.other / ran.frames;
    const interval = ran.fps > 0 ? 1000 / ran.fps : 0;
    this.rows.push({
      step: step.name,
      fps: ran.fps,
      cpuMs: ran.meanMs,
      otherMs: other,
      waitMs: Math.max(0, interval - ran.meanMs - other),
    });
    this.other = 0;
    this.at++;
    this.settled = false;
    this.since = now;
    return true;
  }
}

/** Rows as lines under a heading. */
export function table(heading: string, rows: readonly Row[]): string[] {
  const wide = Math.max(4, ...rows.map((r) => r.step.length));
  const num = (n: number) => n.toFixed(1).padStart(8);
  return [
    heading,
    `${"".padEnd(wide)}${"fps".padStart(8)}${"cpu ms".padStart(8)}${"other".padStart(8)}${"wait".padStart(8)}`,
    ...rows.map((r) => `${r.step.padEnd(wide)}${num(r.fps)}${num(r.cpuMs)}${num(r.otherMs)}${num(r.waitMs)}`),
  ];
}

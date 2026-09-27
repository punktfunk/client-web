// The settings sheet. It renders over whatever screen was showing — including a live one — so
// it is a dialog rather than a route, and closing it puts the previous screen back. Rows are the
// console's: label and hint on the left, the control on the right, on and off as two buttons.

import { DEFAULTS, type Settings } from "@punktfunk/stream";
import { Label } from "@unom/ui/form/label";
import { cn } from "@unom/ui/lib/utils";
import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import type { Actions, Screen } from "./types.ts";

/** The sizes offered, and what each means on the wire. `0×0` follows the window, which is what
 *  a browser usually wants — the others are for pinning a stream to something the host encodes
 *  well regardless of how the tab is sized. */
const SIZES: ReadonlyArray<[label: string, width: number, height: number]> = [
  ["Follow the window", 0, 0],
  ["1280 × 720", 1280, 720],
  ["1920 × 1080", 1920, 1080],
  ["2560 × 1440", 2560, 1440],
  ["3840 × 2160", 3840, 2160],
];

const RATES = [30, 60, 120, 144];

/** Where the slider starts when Automatic is turned off. */
const FIXED_START_KBPS = 20_000;

/** Set by `vite.config.ts` from `git describe`. */
declare const __PF_VERSION__: string;

export function SettingsDialog({ screen, actions }: { screen: Extract<Screen, { kind: "settings" }>; actions: Actions }): JSX.Element {
  const v = screen.values;
  const set = (patch: Partial<Settings>) => actions.setSettings(patch);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) actions.openSettings(false); }}>
      <DialogContent showCloseButton={false} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            These apply to every host. Size, frame rate, bitrate, video plane, audio and input
            take effect on the next stream; the rest apply straight away.
          </DialogDescription>
        </DialogHeader>

        <Setting label="Stream size" htmlFor="pf-size" first>
          <Select
            value={`${v.width}x${v.height}`}
            onValueChange={(value) => {
              const [w, h] = value.split("x").map(Number);
              set({ width: w ?? 0, height: h ?? 0 });
            }}
          >
            <SelectTrigger id="pf-size"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SIZES.map(([label, w, h]) => <SelectItem key={label} value={`${w}x${h}`}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Setting>

        <Setting label="Frame rate" htmlFor="pf-fps">
          <Select value={String(v.fps)} onValueChange={(value) => set({ fps: Number(value) })}>
            <SelectTrigger id="pf-fps"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RATES.map((f) => <SelectItem key={f} value={String(f)}>{f} fps</SelectItem>)}
            </SelectContent>
          </Select>
        </Setting>

        <Toggle
          id="pf-auto-bitrate"
          label="Automatic bitrate"
          hint="The host picks the rate this connection carries and follows it as that changes."
          on={v.bitrateKbps === 0}
          onChange={(on) => set({ bitrateKbps: on ? 0 : FIXED_START_KBPS })}
        />
        {v.bitrateKbps > 0 && (
          <Slider
            label="Bitrate"
            min={2}
            max={150}
            step={1}
            value={Math.round(v.bitrateKbps / 1000)}
            formatValue={(n) => `${n} Mbps`}
            onValueChange={(n) => set({ bitrateKbps: n * 1000 })}
          />
        )}

        <Setting label="Video plane" htmlFor="pf-backend">
          <Select value={v.videoBackend} onValueChange={(value) => set({ videoBackend: value as Settings["videoBackend"] })}>
            <SelectTrigger id="pf-backend"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="webgpu">WebGPU</SelectItem>
              <SelectItem value="webgl2">WebGL2</SelectItem>
            </SelectContent>
          </Select>
        </Setting>

        <Setting label="Mouse" htmlFor="pf-pointer">
          <Select value={v.pointer} onValueChange={(value) => set({ pointer: value as Settings["pointer"] })}>
            <SelectTrigger id="pf-pointer"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="absolute">Follow the cursor (desktop)</SelectItem>
              <SelectItem value="capture">Capture the pointer (games)</SelectItem>
            </SelectContent>
          </Select>
        </Setting>

        <Slider
          className="border-t border-border pt-4"
          label="Stick deadzone"
          min={0}
          max={40}
          step={1}
          value={Math.round(v.deadzone * 100)}
          formatValue={(n) => `${n}%`}
          onValueChange={(n) => set({ deadzone: n / 100 })}
        />

        <Setting label="Statistics overlay" htmlFor="pf-stats">
          <Select value={v.statsTier} onValueChange={(value) => set({ statsTier: value as Settings["statsTier"] })}>
            <SelectTrigger id="pf-stats"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="detailed">Detailed</SelectItem>
            </SelectContent>
          </Select>
        </Setting>

        <Toggle
          id="pf-advanced-stats"
          label="Advanced statistics"
          hint="Off shows the figures Moonlight's overlay also shows. On shows capture to glass as p50/p95 and every stage between."
          on={v.advancedStats}
          onChange={(on) => set({ advancedStats: on })}
        >
          <a
            href="https://docs.punktfunk.unom.io/docs/stats"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline"
          >
            What each number means
          </a>
        </Toggle>

        <Toggle id="pf-audio" label="Play the host's audio" on={v.audio} onChange={(on) => set({ audio: on })} />
        <Toggle id="pf-input" label="Send keyboard, mouse and gamepads" on={v.captureInput} onChange={(on) => set({ captureInput: on })} />
        <Toggle
          id="pf-resize"
          label="Renegotiate the size when the window changes"
          hint="The host rebuilds its capture to answer, which interrupts the picture."
          on={v.resizeStream}
          onChange={(on) => set({ resizeStream: on })}
        />

        <DialogFooter className="*:flex-1">
          <Button variant="secondary" onClick={() => set(DEFAULTS)}>Reset</Button>
          <Button autoFocus onClick={() => actions.openSettings(false)}>Done</Button>
        </DialogFooter>
        <p className="-mt-2 text-center text-xs text-muted-foreground">punktfunk web {__PF_VERSION__}</p>
      </DialogContent>
    </Dialog>
  );
}

/** One setting as the console lays it out: label and hint on the left, the control on the right,
 *  stacked on a phone. A rule above every row but the first. */
function Setting({
  label,
  hint,
  htmlFor,
  first,
  children,
  extra,
}: {
  label: string;
  hint?: string | undefined;
  htmlFor?: string;
  first?: boolean;
  children: ReactNode;
  extra?: ReactNode;
}): JSX.Element {
  return (
    <div className={cn("flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-8", !first && "border-t border-border pt-4")}>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={htmlFor} className="text-sm font-medium">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {extra}
      </div>
      <div className="shrink-0 md:w-64">{children}</div>
    </div>
  );
}

/** On and off as the console offers them: two buttons, the live one filled. */
function Toggle({
  id,
  label,
  hint,
  on,
  onChange,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  on: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <Setting label={label} hint={hint} extra={children}>
      <div id={id} role="group" aria-label={label} className="flex gap-2 md:justify-end">
        <Button size="sm" variant={on ? "outline" : "default"} aria-pressed={!on} onClick={() => on && onChange(false)}>
          Off
        </Button>
        <Button size="sm" variant={on ? "default" : "outline"} aria-pressed={on} onClick={() => !on && onChange(true)}>
          On
        </Button>
      </div>
    </Setting>
  );
}

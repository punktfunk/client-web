// The settings sheet. It renders over whatever screen was showing — including a live one — so
// it is a dialog rather than a route, and closing it puts the previous screen back.

import { DEFAULTS, type Settings } from "@punktfunk/stream";
import { Label } from "@unom/ui/form/label";
import { Switch } from "@unom/ui/form/switch";
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

export function SettingsDialog({ screen, actions }: { screen: Extract<Screen, { kind: "settings" }>; actions: Actions }): JSX.Element {
  const v = screen.values;
  const set = (patch: Partial<Settings>) => actions.setSettings(patch);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) actions.openSettings(false); }}>
      <DialogContent showCloseButton={false} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            These apply to every host. Size, frame rate and bitrate take effect on the next
            stream; the rest apply straight away.
          </DialogDescription>
        </DialogHeader>

        <Field label="Stream size" htmlFor="pf-size">
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
        </Field>

        <Field label="Frame rate" htmlFor="pf-fps">
          <Select value={String(v.fps)} onValueChange={(value) => set({ fps: Number(value) })}>
            <SelectTrigger id="pf-fps"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RATES.map((f) => <SelectItem key={f} value={String(f)}>{f} fps</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>

        <Slider
          label="Bitrate"
          min={2}
          max={150}
          step={1}
          value={Math.round(v.bitrateKbps / 1000)}
          formatValue={(n) => `${n} Mbps`}
          onValueChange={(n) => set({ bitrateKbps: n * 1000 })}
        />

        <Field label="Video plane" htmlFor="pf-backend">
          <Select value={v.videoBackend} onValueChange={(value) => set({ videoBackend: value as Settings["videoBackend"] })}>
            <SelectTrigger id="pf-backend"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="webgpu">WebGPU</SelectItem>
              <SelectItem value="webgl2">WebGL2</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Mouse" htmlFor="pf-pointer">
          <Select value={v.pointer} onValueChange={(value) => set({ pointer: value as Settings["pointer"] })}>
            <SelectTrigger id="pf-pointer"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="absolute">Follow the cursor (desktop)</SelectItem>
              <SelectItem value="capture">Capture the pointer (games)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Slider
          label="Stick deadzone"
          min={0}
          max={40}
          step={1}
          value={Math.round(v.deadzone * 100)}
          formatValue={(n) => `${n}%`}
          onValueChange={(n) => set({ deadzone: n / 100 })}
        />

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
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** A switch belongs beside its label, not under it. */
function Toggle({ id, label, hint, on, onChange }: { id: string; label: string; hint?: string; on: boolean; onChange: (on: boolean) => void }): JSX.Element {
  return (
    <div className="flex items-center gap-4 border-t border-border pt-3">
      <Label htmlFor={id} className="flex-1 leading-snug">
        {label}
        {hint && <span className="mt-1 block text-xs font-normal text-muted-foreground">{hint}</span>}
      </Label>
      <Switch id={id} checked={on} onCheckedChange={onChange} />
    </div>
  );
}

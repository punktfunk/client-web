// Settings, in the macOS client's tabs: General, Display, Input, Audio, Controllers, About. A
// page in the frame, or a dialog over a live stream — the same tabs either way. Inside a tab,
// rows are grouped in cards as the host console groups its own: label and hint on the left, the
// control on the right, and a choice of four or fewer as buttons side by side.

import { DEFAULTS, type Settings } from "@punktfunk/stream";
import { cn } from "@unom/ui/lib/utils";
import { type JSX, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Body, PageHead } from "./frame.tsx";
import type { Actions, Screen } from "./types.ts";

type SettingsScreen = Extract<Screen, { kind: "settings" }>;
type SetFn = (patch: Partial<Settings>) => void;

/** The sizes offered, and what each means on the wire. `0×0` follows the window, which is what
 *  a browser usually wants — the others pin a stream to something the host encodes well
 *  regardless of how the tab is sized. */
const SIZES: ReadonlyArray<[label: string, width: number, height: number]> = [
  ["Follow the window", 0, 0],
  ["1280 × 720", 1280, 720],
  ["1920 × 1080", 1920, 1080],
  ["2560 × 1440", 2560, 1440],
  ["3840 × 2160", 3840, 2160],
];

const RATES = [30, 60, 90, 120, 144, 165, 240];

/** Where the slider starts when Automatic is turned off. */
const FIXED_START_KBPS = 20_000;

const TABS = ["General", "Display", "Input", "Audio", "Controllers", "About"] as const;
type TabName = (typeof TABS)[number];

/** The tab last open, for the next time settings open this visit. */
let lastTab: TabName = "General";

/** Set by `vite.config.ts` from `git describe`. */
declare const __PF_VERSION__: string;

export function SettingsPage({ screen, actions }: { screen: SettingsScreen; actions: Actions }): JSX.Element {
  return (
    <Body className="max-w-4xl">
      <PageHead title="Settings" sub="These apply to every host. Stream settings take effect on the next stream." />
      <SettingsTabs screen={screen} actions={actions} />
    </Body>
  );
}

/** The same tabs over a live stream, where leaving the picture for a page would end nothing
 *  but hide it. */
export function SettingsDialog({ screen, actions }: { screen: SettingsScreen; actions: Actions }): JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) actions.openSettings(false); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Stream settings take effect on the next stream; the rest apply now.</DialogDescription>
        </DialogHeader>
        <SettingsTabs screen={screen} actions={actions} />
        <DialogFooter>
          <Button autoFocus onClick={() => actions.openSettings(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsTabs({ screen, actions }: { screen: SettingsScreen; actions: Actions }): JSX.Element {
  const [tab, setTab] = useState<TabName>(lastTab);
  const v = screen.values;
  const set: SetFn = (patch) => actions.setSettings(patch);
  return (
    <Tabs
      value={tab}
      onValueChange={(t) => {
        lastTab = t as TabName;
        setTab(lastTab);
      }}
      className="flex flex-col gap-5"
    >
      <TabsList className="w-full justify-start overflow-x-auto">
        {TABS.map((t) => <TabsTrigger key={t} value={t}>{t}</TabsTrigger>)}
      </TabsList>

      <TabsContent value="General" className="flex flex-col gap-5">
        <Group title="Session">
          <Toggle
            label="Fullscreen while streaming"
            hint="Goes fullscreen when a stream starts from a click, and back to the window when it ends."
            on={v.fullscreen}
            onChange={(on) => set({ fullscreen: on })}
          />
        </Group>
        <Group title="Statistics">
          <Row label="Statistics overlay" hint="Ctrl+Alt+Shift+S cycles it during a stream.">
            <Segmented
              label="Statistics overlay"
              value={v.statsTier}
              options={[["off", "Off"], ["compact", "Compact"], ["normal", "Normal"], ["detailed", "Detailed"]]}
              onChange={(statsTier) => set({ statsTier })}
            />
          </Row>
          <Toggle
            label="Advanced statistics"
            hint="Off shows the figures Moonlight's overlay also shows. On shows capture to glass as p50/p95 and every stage between."
            on={v.advancedStats}
            onChange={(on) => set({ advancedStats: on })}
          >
            <a href="https://docs.punktfunk.unom.io/docs/stats" target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">
              What each number means
            </a>
          </Toggle>
        </Group>
        {!screen.streaming && (
          <Group title="Interface">
            <Row label="Console mode" hint="The controller interface every punktfunk client shares, for a TV or a gamepad.">
              <Button size="sm" variant="secondary" onClick={() => actions.consoleMode(true)}>Switch to console mode</Button>
            </Row>
          </Group>
        )}
      </TabsContent>

      <TabsContent value="Display" className="flex flex-col gap-5">
        <Group title="Resolution">
          <Row label="Resolution" htmlFor="pf-size">
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
          </Row>
          {v.width === 0 && (
            <Toggle
              label="Follow window resizes"
              hint="Renegotiates the size when the window changes mid-stream. The host rebuilds its capture to answer, which interrupts the picture."
              on={v.resizeStream}
              onChange={(on) => set({ resizeStream: on })}
            />
          )}
          <Row label="Frame rate" htmlFor="pf-fps">
            <Select value={String(v.fps)} onValueChange={(value) => set({ fps: Number(value) })}>
              <SelectTrigger id="pf-fps"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RATES.map((f) => <SelectItem key={f} value={String(f)}>{f} fps</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
        </Group>
        <Group title="Quality">
          <Toggle
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
          <Row label="Video codec" hint="Asked for first. The host falls back to one both sides have.">
            <Segmented
              label="Video codec"
              value={v.codec}
              options={[["auto", "Automatic"], ["hevc", "HEVC"], ["av1", "AV1"], ["h264", "H.264"]]}
              onChange={(codec) => set({ codec })}
            />
          </Row>
          <Toggle
            label="10-bit HDR"
            hint="Used when this browser and display can show it; otherwise the stream stays SDR."
            on={v.hdr}
            onChange={(on) => set({ hdr: on })}
          />
        </Group>
        <Group title="Renderer">
          <Row label="Video plane" hint="Automatic uses WebGPU where the browser has it.">
            <Segmented
              label="Video plane"
              value={v.videoBackend}
              options={[["auto", "Automatic"], ["webgpu", "WebGPU"], ["webgl2", "WebGL2"]]}
              onChange={(videoBackend) => set({ videoBackend })}
            />
          </Row>
        </Group>
      </TabsContent>

      <TabsContent value="Input" className="flex flex-col gap-5">
        <Group title="Keyboard & mouse">
          <Row
            label="Mouse input"
            hint={
              v.pointer === "absolute"
                ? "The host's pointer goes where yours is. For desktops."
                : "A click locks the pointer and sends motion. For games with mouselook; Esc releases."
            }
          >
            <Segmented
              label="Mouse input"
              value={v.pointer}
              options={[["absolute", "Desktop"], ["capture", "Capture (games)"]]}
              onChange={(pointer) => set({ pointer })}
            />
          </Row>
          <Toggle label="Invert scroll direction" on={v.invertScroll} onChange={(on) => set({ invertScroll: on })} />
          <Toggle
            label="Send keyboard, mouse and controllers"
            hint="Off only watches the stream."
            on={v.captureInput}
            onChange={(on) => set({ captureInput: on })}
          />
        </Group>
      </TabsContent>

      <TabsContent value="Audio" className="flex flex-col gap-5">
        <Group title="Playback">
          <Toggle label="Play the host's audio" on={v.audio} onChange={(on) => set({ audio: on })} />
        </Group>
      </TabsContent>

      <TabsContent value="Controllers" className="flex flex-col gap-5">
        <Group title="Sticks">
          <Slider
            label="Stick deadzone"
            min={0}
            max={40}
            step={1}
            value={Math.round(v.deadzone * 100)}
            formatValue={(n) => `${n}%`}
            onValueChange={(n) => set({ deadzone: n / 100 })}
          />
        </Group>
      </TabsContent>

      <TabsContent value="About" className="flex flex-col gap-5">
        <Group title="punktfunk web">
          <Row label="Version">
            <span className="font-mono text-sm text-muted-foreground">{__PF_VERSION__}</span>
          </Row>
          <Row label="Documentation">
            <a className="text-sm text-primary underline-offset-4 hover:underline" href="https://docs.punktfunk.unom.io/docs/browser-client" target="_blank" rel="noreferrer">
              The browser client guide
            </a>
          </Row>
          <Row label="Source code">
            <a className="text-sm text-primary underline-offset-4 hover:underline" href="https://github.com/punktfunk/client-web" target="_blank" rel="noreferrer">
              github.com/punktfunk/client-web
            </a>
          </Row>
          <Row label="Reset settings" hint="Every setting on every tab back to its default.">
            <Button size="sm" variant="secondary" onClick={() => set(DEFAULTS)}>Reset</Button>
          </Row>
        </Group>
      </TabsContent>
    </Tabs>
  );
}

/** A card of related rows under a heading, a rule between rows. */
function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      <Card className="flex flex-col gap-4 p-5 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-4">{children}</Card>
    </section>
  );
}

/** One setting: label and hint on the left, the control on the right, stacked on a phone. */
function Row({
  label,
  hint,
  htmlFor,
  children,
  extra,
}: {
  label: string;
  hint?: string | undefined;
  htmlFor?: string;
  children: ReactNode;
  extra?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-8">
      <div className="min-w-0 space-y-1">
        <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {extra}
      </div>
      <div className="flex shrink-0 md:max-w-[60%] md:justify-end [&>button[role=combobox]]:md:w-56">{children}</div>
    </div>
  );
}

/** A choice of a few, as buttons side by side: the live one filled. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map(([v, text]) => (
        <Button
          key={v}
          size="sm"
          variant={value === v ? "default" : "outline"}
          aria-pressed={value === v}
          className={cn(value === v && "pointer-events-none")}
          onClick={() => onChange(v)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

/** On and off as the console offers them: two buttons, the live one filled. */
function Toggle({
  label,
  hint,
  on,
  onChange,
  children,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <Row label={label} hint={hint} extra={children}>
      <Segmented
        label={label}
        value={on ? "on" : "off"}
        options={[["off", "Off"], ["on", "On"]]}
        onChange={(v) => onChange(v === "on")}
      />
    </Row>
  );
}

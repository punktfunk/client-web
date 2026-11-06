// Settings, in the macOS client's tabs: General, Display, Input, Audio, Controllers, About. A
// page in the frame, or a dialog over a live stream — the same tabs either way. Inside a tab,
// rows are grouped in cards as the host console groups its own: label and hint on the left, the
// control on the right, and a choice of four or fewer as buttons side by side. Each tab's
// advanced rows show under Show advanced; hidden, a tab says how many of them are changed.

import { ASPECTS, aspectOf, customSize, DEFAULTS, nearest, type Settings, STATS_SCALES, tizen } from "@punktfunk/stream";
import { cn } from "@unom/ui/lib/utils";
import { motion } from "motion/react";
import { Children, Fragment, isValidElement, type JSX, type ReactNode, useState } from "react";
import { ROW, ROW_GAP, Stagger } from "@/components/stagger";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { m } from "../paraglide/messages.js";
import { Body, PageHead } from "./frame.tsx";
import type { Actions, Screen } from "./types.ts";

type SettingsScreen = Extract<Screen, { kind: "settings" }>;
type SetFn = (patch: Partial<Settings>) => void;

/** The Resolution list's entry that shows the typed width and height. */
const CUSTOM = "custom";

const RATES = [30, 60, 90, 120, 144, 165, 240];

/** Where the slider starts when Automatic is turned off. */
const FIXED_START_KBPS = 20_000;

const TABS = {
  general: () => m.prefs_category_general(),
  display: () => m.prefs_category_display(),
  input: () => m.prefs_category_input(),
  audio: () => m.prefs_category_audio(),
  controllers: () => m.prefs_category_controllers(),
  about: () => m.prefs_category_about(),
} as const;
type TabName = keyof typeof TABS;

/** The tab last open, for the next time settings open this visit. */
let lastTab: TabName = "general";

/** What the page binds while streaming, as `pf_client_core::shortcuts` lists it for the console:
 *  `input.ts` holds the bindings. The Samsung set adds the remote's Back, and has no Esc row
 *  because Esc still reaches the host there. */
const CONTROLS: ReadonlyArray<readonly [keys: string, text: () => string]> = [
  ["Ctrl+Alt+Shift+Q", () => m.controls_release_mouse()],
  ["Esc", () => m.controls_release_mouse_page()],
  ["Ctrl+Alt+Shift+D", () => m.controls_disconnect()],
  ["Ctrl+Alt+Shift+S", () => m.controls_cycle_stats()],
  ["Ctrl+Alt+Shift+O", () => m.controls_open_menu()],
  ["Ctrl+Alt+Shift+V", () => m.controls_toggle_mic()],
  ["Ctrl+Alt+Shift+M", () => m.controls_switch_mouse_mode()],
  [m.controls_either({ first: "F11", second: "Alt+Enter" }), () => m.controls_toggle_fullscreen()],
  ["Select + A", () => m.browser_controls_open_menu_pad()],
  ["L1 + R1 + Start + Select", () => m.browser_controls_release_pad()],
];

/** Set by `vite.config.ts` from `git describe`. */
declare const __PF_VERSION__: string;

export function SettingsPage({ screen, actions }: { screen: SettingsScreen; actions: Actions }): JSX.Element {
  return (
    <Body className="max-w-4xl">
      <PageHead title={m.prefs_title()} sub={m.browser_prefs_page_hint()} />
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
          <DialogTitle>{m.prefs_title()}</DialogTitle>
          <DialogDescription>{m.browser_prefs_dialog_hint()}</DialogDescription>
        </DialogHeader>
        <SettingsTabs screen={screen} actions={actions} />
        <DialogFooter>
          <Button autoFocus onClick={() => actions.openSettings(false)}>{m.common_done()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How many of `keys` hold something other than a fresh browser would. */
function changed(v: Settings, keys: ReadonlyArray<keyof Settings>): number {
  return keys.filter((k) => v[k] !== DEFAULTS[k]).length;
}

function SettingsTabs({ screen, actions }: { screen: SettingsScreen; actions: Actions }): JSX.Element {
  const [tab, setTab] = useState<TabName>(lastTab);
  const v = screen.values;
  const set: SetFn = (patch) => actions.setSettings(patch);
  const advanced = (keys: ReadonlyArray<keyof Settings>, rows: ReactNode) => (
    <Advanced show={v.showAdvanced} changed={changed(v, keys)} onShow={() => set({ showAdvanced: true })}>
      {rows}
    </Advanced>
  );
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
        {(Object.keys(TABS) as TabName[]).map((t) => <TabsTrigger key={t} value={t}>{TABS[t]()}</TabsTrigger>)}
      </TabsList>

      <Panel value="general">
        <Group title={m.prefs_group_session()}>
          <Toggle
            label={m.player_fullscreen_on_stream()}
            hint={m.player_fullscreen_on_stream_hint()}
            on={v.fullscreen}
            onChange={(on) => set({ fullscreen: on })}
          />
        </Group>
        <Group title={m.prefs_group_statistics()}>
          <Row label={m.player_stats_verbosity()} hint={m.player_stats_verbosity_cycle_hint({ keys: "Ctrl+Alt+Shift+S" })}>
            <Segmented
              label={m.player_stats_verbosity()}
              value={v.statsTier}
              options={[
                ["off", m.player_stats_verbosity_off()],
                ["compact", m.player_stats_verbosity_compact()],
                ["normal", m.player_stats_verbosity_normal()],
                ["detailed", m.player_stats_verbosity_detailed()],
              ]}
              onChange={(statsTier) => set({ statsTier })}
            />
          </Row>
        </Group>
        {!screen.streaming && (
          <Group title={m.prefs_group_interface()}>
            <Row label={m.browser_console_mode()} hint={m.browser_console_mode_hint()}>
              <Button size="sm" variant="secondary" onClick={() => actions.consoleMode(true)}>{m.browser_console_mode_switch()}</Button>
            </Row>
          </Group>
        )}
        <Group>
          <Toggle
            label={m.player_show_advanced()}
            hint={m.player_show_advanced_hint()}
            on={v.showAdvanced}
            onChange={(on) => set({ showAdvanced: on })}
          />
        </Group>
        {advanced(
          ["advancedStats", "hudPlacement", "statsScalePct", "exitHint"],
          <>
            <Toggle
              label={m.player_advanced_stats()}
              hint={m.player_advanced_stats_hint()}
              on={v.advancedStats}
              onChange={(on) => set({ advancedStats: on })}
            >
              <a href="https://docs.punktfunk.unom.io/docs/stats" target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">
                {m.player_stats_docs_link()}
              </a>
            </Toggle>
            <Row label={m.player_hud_placement()} hint={m.player_hud_placement_hint()}>
              <Segmented
                label={m.player_hud_placement()}
                value={v.hudPlacement}
                options={[
                  ["topLeading", m.player_hud_placement_top_leading()],
                  ["topTrailing", m.player_hud_placement_top_trailing()],
                  ["bottomLeading", m.player_hud_placement_bottom_leading()],
                  ["bottomTrailing", m.player_hud_placement_bottom_trailing()],
                ]}
                onChange={(hudPlacement) => set({ hudPlacement })}
              />
            </Row>
            <Row label={m.player_stats_scale_pct()} hint={m.browser_stats_scale_pct_hint()} htmlFor="pf-stats-size">
              <Select value={String(v.statsScalePct)} onValueChange={(value) => set({ statsScalePct: Number(value) })}>
                <SelectTrigger id="pf-stats-size"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATS_SCALES.map((p) => <SelectItem key={p} value={String(p)}>{m.common_percent({ value: p })}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <Toggle
              label={m.player_exit_hint()}
              hint={m.player_exit_hint_hint()}
              on={v.exitHint}
              onChange={(on) => set({ exitHint: on })}
            />
          </>,
        )}
      </Panel>

      <Panel value="display">
        <Group title={m.prefs_group_resolution()}>
          <Resolution v={v} set={set} />
          {v.width === 0 && (
            <Toggle
              label={m.browser_resize_stream()}
              hint={m.browser_resize_stream_hint()}
              on={v.resizeStream}
              onChange={(on) => set({ resizeStream: on })}
            />
          )}
          <Row label={m.player_refresh_hz()} htmlFor="pf-fps">
            <Select value={String(v.fps)} onValueChange={(value) => set({ fps: Number(value) })}>
              <SelectTrigger id="pf-fps"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RATES.map((f) => <SelectItem key={f} value={String(f)}>{m.common_hz({ value: f })}</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
        </Group>
        <Group title={m.prefs_group_picture()}>
          <Toggle
            label={m.player_bitrate_kbps_auto_switch()}
            hint={m.player_bitrate_kbps_auto_switch_hint()}
            on={v.bitrateKbps === 0}
            onChange={(on) => set({ bitrateKbps: on ? 0 : FIXED_START_KBPS })}
          />
          {v.bitrateKbps > 0 && (
            <Slider
              label={m.player_bitrate_kbps()}
              min={2}
              max={200}
              step={1}
              value={Math.round(v.bitrateKbps / 1000)}
              formatValue={(n) => m.common_mbits({ value: n })}
              onValueChange={(n) => set({ bitrateKbps: n * 1000 })}
            />
          )}
          <Toggle
            label={m.player_hdr_enabled()}
            hint={m.player_hdr_enabled_hint()}
            on={v.hdr}
            onChange={(on) => set({ hdr: on })}
          />
        </Group>
        {advanced(
          ["codec", "videoBackend"],
          <>
            <Row label={m.player_codec()} hint={m.player_codec_hint()}>
              <Segmented
                label={m.player_codec()}
                value={v.codec}
                options={[["auto", m.player_codec_auto()], ["hevc", "HEVC"], ["av1", "AV1"], ["h264", "H.264"]]}
                onChange={(codec) => set({ codec })}
              />
            </Row>
            <Row label={m.browser_video_backend()} hint={m.browser_video_backend_hint()}>
              <Segmented
                label={m.browser_video_backend()}
                value={v.videoBackend}
                options={[["auto", m.browser_video_backend_auto()], ["webgpu", "WebGPU"], ["webgl2", "WebGL2"]]}
                onChange={(videoBackend) => set({ videoBackend })}
              />
            </Row>
          </>,
        )}
      </Panel>

      <Panel value="input">
        <Group title={m.prefs_group_keyboard_mouse()}>
          <Row
            label={m.player_mouse_mode()}
            hint={
              v.pointer === "absolute"
                ? m.player_mouse_mode_desktop_hint()
                : m.browser_player_mouse_mode_capture_hint({ keys: "Esc" })
            }
          >
            <Segmented
              label={m.player_mouse_mode()}
              value={v.pointer}
              options={[["absolute", m.player_mouse_mode_desktop()], ["capture", m.player_mouse_mode_capture()]]}
              onChange={(pointer) => set({ pointer })}
            />
          </Row>
          <Toggle label={m.player_invert_scroll()} on={v.invertScroll} onChange={(on) => set({ invertScroll: on })} />
          <Toggle
            label={m.browser_player_capture_input()}
            hint={m.browser_player_capture_input_hint()}
            on={v.captureInput}
            onChange={(on) => set({ captureInput: on })}
          />
        </Group>
      </Panel>

      <Panel value="audio">
        <Group title={m.browser_prefs_group_playback()}>
          <Toggle label={m.browser_player_audio()} on={v.audio} onChange={(on) => set({ audio: on })} />
        </Group>
      </Panel>

      <Panel value="controllers">
        <Group title={m.browser_prefs_group_sticks()}>
          <Slider
            label={m.browser_player_deadzone()}
            min={0}
            max={40}
            step={1}
            value={Math.round(v.deadzone * 100)}
            formatValue={(n) => m.common_percent({ value: n })}
            onValueChange={(n) => set({ deadzone: n / 100 })}
          />
        </Group>
      </Panel>

      <Panel value="about">
        <Group title={m.about_stream_controls()}>
          {(tizen() ? [["Back", () => m.controls_open_menu()] as const, ...CONTROLS.filter(([k]) => k !== "Esc")] : CONTROLS).map(
            ([keys, text]) => (
              <Row key={keys} label={text()}>
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
              </Row>
            ),
          )}
        </Group>
        <Group title="punktfunk web">
          <Row label={m.about_version()}>
            <span className="font-mono text-sm text-muted-foreground">{__PF_VERSION__}</span>
          </Row>
          <Row label={m.about_docs()}>
            <a className="text-sm text-primary underline-offset-4 hover:underline" href="https://docs.punktfunk.unom.io/docs/browser-client" target="_blank" rel="noreferrer">
              {m.browser_about_guide()}
            </a>
          </Row>
          <Row label={m.about_source()}>
            <a className="text-sm text-primary underline-offset-4 hover:underline" href="https://github.com/punktfunk/client-web" target="_blank" rel="noreferrer">
              github.com/punktfunk/client-web
            </a>
          </Row>
          <Row label={m.browser_prefs_reset()} hint={m.browser_prefs_reset_hint()}>
            <Button size="sm" variant="secondary" onClick={() => set(DEFAULTS)}>{m.common_reset()}</Button>
          </Row>
        </Group>
      </Panel>
    </Tabs>
  );
}

/**
 * Aspect ratio over Resolution: the window, the family's sizes, then Custom…, which shows the
 * typed width and height. A size no family lists reads as Custom, whatever was picked.
 */
function Resolution({ v, set }: { v: Settings; set: SetFn }): JSX.Element {
  // Sticky once picked, so a typed size that equals a listed one stays on Custom.
  const [customPicked, setCustomPicked] = useState(false);
  const family = Math.max(0, aspectOf(v.width, v.height));
  const sizes = ASPECTS[family]?.sizes ?? [];
  const listed = v.width === 0 || sizes.some(([w, h]) => w === v.width && h === v.height);
  const custom = v.width !== 0 && (customPicked || !listed);
  const typed = (w: number, h: number) => {
    const [cw, ch] = customSize(w, h, v.codec);
    set({ width: cw, height: ch });
  };
  return (
    <>
      <Row label={m.player_resolution_aspect()} hint={m.player_resolution_aspect_hint()}>
        <Segmented
          label={m.player_resolution_aspect()}
          value={String(family)}
          options={ASPECTS.map((a, i) => [String(i), a.label] as const)}
          onChange={(i) => {
            setCustomPicked(false);
            const [w, h] = nearest(Number(i), v.height);
            set({ width: w, height: h });
          }}
        />
      </Row>
      <Row label={m.player_resolution()} hint={m.player_resolution_hint()} htmlFor="pf-size">
        <Select
          value={custom ? CUSTOM : `${v.width}x${v.height}`}
          onValueChange={(value) => {
            if (value === CUSTOM) {
              setCustomPicked(true);
              if (v.width === 0) set({ width: 1920, height: 1080 });
              return;
            }
            setCustomPicked(false);
            const [w, h] = value.split("x").map(Number);
            set({ width: w ?? 0, height: h ?? 0 });
          }}
        >
          <SelectTrigger id="pf-size"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="0x0">{m.browser_resolution_window()}</SelectItem>
            {sizes.map(([w, h]) => <SelectItem key={`${w}x${h}`} value={`${w}x${h}`}>{w} × {h}</SelectItem>)}
            <SelectItem value={CUSTOM}>{custom ? m.player_resolution_custom_size({ width: v.width, height: v.height }) : m.player_resolution_custom()}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      {custom && (
        <Row label={m.player_resolution_custom_row()} hint={m.browser_custom_size_hint()}>
          <div className="flex items-center gap-2">
            {/* Keyed on the stored side, so a size the rule clamped shows what was kept. */}
            <SizeField key={`w${v.width}`} label={m.player_resolution_width()} value={v.width} onCommit={(w) => typed(w, v.height)} />
            <span aria-hidden="true">×</span>
            <SizeField key={`h${v.height}`} label={m.player_resolution_height()} value={v.height} onCommit={(h) => typed(v.width, h)} />
          </div>
        </Row>
      )}
    </>
  );
}

/** One side of a typed size, committed on blur or Enter so a half-typed number is never clamped.
 *  It then shows the stored side: a new one remounts it by key, one the rule clamped back here. */
function SizeField({ label, value, onCommit }: { label: string; value: number; onCommit: (n: number) => void }): JSX.Element {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Number.parseInt(text, 10);
    if (n > 0 && n !== value) onCommit(n);
    setText(String(value));
  };
  return (
    <Input
      aria-label={label}
      className="w-24"
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
    />
  );
}

/** A tab's advanced rows: their own card under Show advanced, otherwise one button naming how
 *  many hold a changed value, which shows them. Nothing when none changed. */
function Advanced({
  show,
  changed,
  onShow,
  children,
}: {
  show: boolean;
  changed: number;
  onShow: () => void;
  children: ReactNode;
}): JSX.Element | null {
  if (show) return <Group title={m.prefs_advanced()}>{children}</Group>;
  if (changed === 0) return null;
  return (
    <Group>
      <Row label={m.prefs_advanced_changed({ count: changed })}>
        <Button size="sm" variant="secondary" onClick={onShow}>{m.browser_prefs_show_advanced()}</Button>
      </Row>
    </Group>
  );
}

/** One tab's panel. Its own cascade: a panel mounts when its tab is picked, long after the page
 *  around it arrived, so nothing above it is still driving. */
function Panel({ value, children }: { value: TabName; children: ReactNode }): JSX.Element {
  return (
    <TabsContent value={value}>
      <Stagger root className="flex flex-col gap-5">{children}</Stagger>
    </TabsContent>
  );
}

/** A card of related rows under a heading, a rule between rows. The rows rise in turn behind
 *  the card, as the console's lists do; `contents` keeps them the card's own flex items, so
 *  its gap and the rule between them still apply. A fragment's rows are rows of the card. */
function Group({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      {title && <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>}
      <Card className="flex flex-col gap-4 p-5">
        <Stagger gap={ROW_GAP} className="contents [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-4">
          {rows(children).map((child, i) => (
            <motion.div key={isValidElement(child) ? (child.key ?? i) : i} variants={ROW}>
              {child}
            </motion.div>
          ))}
        </Stagger>
      </Card>
    </section>
  );
}

/** `children` as a card's rows, one fragment level flattened: `advanced` hands its rows over in one. */
function rows(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((c) =>
    isValidElement<{ children?: ReactNode }>(c) && c.type === Fragment ? Children.toArray(c.props.children) : [c],
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
        options={[["off", m.common_off()], ["on", m.common_on()]]}
        onChange={(v) => onChange(v === "on")}
      />
    </Row>
  );
}

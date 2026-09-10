// The design harness: every `Screen` the shell can draw, without a host.
//
// `_e2e.ts` drives the engine against a real host, which is the right way to test behaviour and
// the wrong way to look at a screen. This mounts the shell alone and hands it a value from
// `ui/fixtures.ts` — the same set Storybook shows. `?s=<name>` picks one; nothing else on the
// page runs, so what it renders is exactly what the stylesheet and `shell.tsx` say and nothing
// the engine contributed. Dev-only: the build takes `index.html` as its one entry, so neither
// this nor `_e2e.html` reaches `dist/`.

import { noop, SCREENS, type ScreenName } from "./ui/fixtures.ts";
import { WebShell } from "./ui/shell.tsx";
import type { Screen } from "./ui/types.ts";

const shell = new WebShell(document.body);
let live: Screen = SCREENS["home"];
// Settings are the one screen with controls that must visibly respond, so the harness keeps a
// copy and re-renders. Everything else is static by design.
shell.mount({
  ...noop,
  setSettings(patch) {
    if (live.kind !== "settings") return;
    live = { ...live, values: { ...live.values, ...patch } };
    shell.render(live);
  },
});
const pick = (n: string | null): Screen => SCREENS[(n ?? "home") as ScreenName] ?? SCREENS["home"];
live = pick(new URLSearchParams(location.search).get("s"));
shell.render(live);

// What the screenshot driver enumerates, and what a person opening the page with no query gets
// told is available.
Object.assign(window, {
  pfScreens: Object.keys(SCREENS),
  pfShow: (n: string) => {
    live = pick(n);
    shell.render(live);
  },
});

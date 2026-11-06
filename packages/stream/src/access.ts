// This device's access to the host, as the chip and the notices say it.
//
// The preset is derived from the grant mask, never stored, and a full permanent session wears
// no chip. The words are the shared `grant_*` messages, as every native client says them.

import { words } from "./words.ts";

const GRANT_GAMEPAD = 1 << 0;
/** Every grant this build knows. Bits a newer host adds are dropped before labelling. */
const GRANT_ALL = 0x7f;
/** "Full control" as stored before the power grant existed. */
const GRANT_ALL_PRE_POWER = 0x3f;

type Preset = "full" | "controller" | "view" | "custom";

/** The preset a grant mask reads as. */
function presetOf(grants: number): Preset {
  const mask = (grants === GRANT_ALL_PRE_POWER ? GRANT_ALL : grants) & GRANT_ALL;
  if (mask === GRANT_ALL) return "full";
  if (mask === GRANT_GAMEPAD) return "controller";
  if (mask === 0) return "view";
  return "custom";
}

/** The preset a grant mask reads as, by name. */
export function presetLabel(grants: number): string {
  switch (presetOf(grants)) {
    case "full":
      return words.grant_level_full();
    case "controller":
      return words.grant_level_controller();
    case "view":
      return words.grant_level_view();
    case "custom":
      return words.grant_level_custom();
  }
}

/** Whole minutes: the wire carries whole seconds, so a seconds countdown would overclaim.
 *  `undefined` under a minute: each caller has a whole message for that. */
export function formatRemaining(secs: number): string | undefined {
  const mins = Math.floor(Math.max(0, secs) / 60);
  const hours = Math.floor(mins / 60);
  const minutes = mins % 60;
  if (!hours && !minutes) return undefined;
  if (!hours) return words.grant_remaining_minutes({ minutes });
  return minutes ? words.grant_remaining_hours_minutes({ hours, minutes }) : words.grant_remaining_hours({ hours });
}

/** The chip (`Controller only · ends in 1 h 58 m`); `undefined` for full, permanent access.
 *  `secsLeft` is `null` for permanent. */
export function chipText(grants: number, secsLeft: number | null): string | undefined {
  const level = presetLabel(grants);
  if (secsLeft === null) return presetOf(grants) === "full" ? undefined : level;
  const left = formatRemaining(secsLeft);
  return `${level} · ${left ? words.grant_chip_ends({ time: left }) : words.grant_chip_ends_soon()}`;
}

/** What a mid-session change says: a new level by name, else the host's T−5 / T−1 warning. */
export function updateNotice(prevGrants: number, grants: number, secsLeft: number | null): string | undefined {
  if (grants !== prevGrants) {
    switch (presetOf(grants)) {
      case "full":
        return words.grant_now_full();
      case "controller":
        return words.grant_now_controller();
      case "view":
        return words.grant_now_view();
      case "custom":
        return words.grant_now_custom();
    }
  }
  if (secsLeft === null || secsLeft <= 0) return undefined;
  const left = formatRemaining(secsLeft);
  return left ? words.grant_ends_in({ time: left }) : words.grant_ends_soon();
}

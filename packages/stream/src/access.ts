// This device's access to the host, as the chip and the notices say it.
//
// The words are the native clients' (`pf-client-core`'s `access.rs`), copied as Apple and
// Android copy them: the preset is derived from the grant mask, never stored, and a full
// permanent session wears no chip.

const GRANT_GAMEPAD = 1 << 0;
/** Every grant this build knows. Bits a newer host adds are dropped before labelling. */
const GRANT_ALL = 0x7f;
/** "Full control" as stored before the power grant existed. */
const GRANT_ALL_PRE_POWER = 0x3f;

/** The preset a grant mask reads as. */
export function presetLabel(grants: number): string {
  const mask = (grants === GRANT_ALL_PRE_POWER ? GRANT_ALL : grants) & GRANT_ALL;
  if (mask === GRANT_ALL) return "Full control";
  if (mask === GRANT_GAMEPAD) return "Controller only";
  if (mask === 0) return "View only";
  return "Custom";
}

/** Whole minutes: the wire carries whole seconds, so a seconds countdown would overclaim. */
export function formatRemaining(secs: number): string {
  const mins = Math.floor(Math.max(0, secs) / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h && !m) return "under 1 m";
  if (!h) return `${m} m`;
  return m ? `${h} h ${m} m` : `${h} h`;
}

/** The chip (`Controller only · ends in 1 h 58 m`); `undefined` for full, permanent access.
 *  `secsLeft` is `null` for permanent. */
export function chipText(grants: number, secsLeft: number | null): string | undefined {
  const label = presetLabel(grants);
  if (label === "Full control" && secsLeft === null) return undefined;
  return secsLeft === null ? label : `${label} · ends in ${formatRemaining(secsLeft)}`;
}

/** What a mid-session change says: a new level by name, else the host's T−5 / T−1 warning. */
export function updateNotice(prevGrants: number, grants: number, secsLeft: number | null): string | undefined {
  if (grants !== prevGrants) return `Access is now ${presetLabel(grants)}`;
  return secsLeft !== null && secsLeft > 0 ? `Access ends in ${formatRemaining(secsLeft)}` : undefined;
}

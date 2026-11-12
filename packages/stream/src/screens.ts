// Which host screen this device streams, and how: the host's `GET /display/targets` answer and
// the Screen section drawn from it. The TypeScript twin of `pf_client_core::display_targets`'s
// rows and note; `screen-rows-vectors.json` pins both. The pick is the device's own row on the
// host, so nothing here stores it.

import { words } from "./words.ts";

/** `"own"` or `{ monitor: connector }`, the host's spelling. */
export type DisplayTarget = "own" | { monitor: string };

/** One monitor, or the own screen, as the host lists it. Any field may be missing. */
export interface ScreenTarget {
  id?: string;
  label?: string;
  connector?: string | null;
  mode?: string | null;
  enabled?: boolean;
  in_use_by?: string | null;
}

/** `GET /display/targets` as the host sent it. A host that omits `may_choose` lets every
 *  device choose; `role` is read leniently, as core reads it. */
export interface ScreenTargets {
  locked?: boolean;
  may_choose?: boolean;
  host_default?: DisplayTarget;
  yours?: DisplayTarget | null;
  targets?: ReadonlyArray<ScreenTarget>;
  role?: unknown;
}

/** The body of `PUT /display/clients/{fp}`: the screen, and for a role its topology. */
export interface ScreenPick {
  screen: DisplayTarget;
  topology?: string;
}

/** One row of the Screen section, worded. Draw `label`, `detail` as its value, and `reason`,
 *  else `hint`, under it; `header` starts a group at this row. `pick` is absent on the checked
 *  row and on one that can't be picked. */
export interface ScreenRow {
  kind: "role" | "monitor" | "own";
  id: string;
  label: string;
  hint?: string;
  detail: string;
  header?: string;
  checked: boolean;
  pickable: boolean;
  reason?: string;
  pick?: ScreenPick;
}

const ROLES = ["only", "main", "second"] as const;
type Role = (typeof ROLES)[number];

const ROLE_WORDS: Record<Role, { topology: string; label: () => string; hint: () => string }> = {
  only: { topology: "exclusive", label: () => words.screen_role_only(), hint: () => words.screen_role_only_hint() },
  main: { topology: "primary", label: () => words.screen_role_main(), hint: () => words.screen_role_main_hint() },
  second: { topology: "extend", label: () => words.screen_role_second(), hint: () => words.screen_role_second_hint() },
};

const asRole = (v: unknown): Role | undefined => ROLES.find((r) => r === v);

/** `role` as core reads it: anything but an object is none, unknown words drop out. */
function roleOf(v: unknown): { current: Role; offered: Role[] } | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const offered = Array.isArray(o["offered"]) ? o["offered"].map(asRole) : [];
  return {
    current: asRole(o["yours"]) ?? asRole(o["host_default"]) ?? "only",
    offered: ROLES.filter((r) => offered.includes(r)),
  };
}

const same = (a: DisplayTarget, b: DisplayTarget): boolean =>
  a === "own" || b === "own" ? a === b : a.monitor === b.monitor;

function targetRow(t: ScreenTarget, current: DisplayTarget): ScreenRow {
  const id = t.id ?? "";
  const label = t.label ?? "";
  const screen: DisplayTarget = id === "own" ? "own" : { monitor: id };
  const reason = typeof t.in_use_by === "string" ? words.screen_in_use({ device: t.in_use_by }) : t.enabled === false ? words.screen_off() : undefined;
  return {
    kind: id === "own" ? "own" : "monitor",
    id,
    label: id === "own" ? words.screen_own() : label || id,
    detail: [t.connector === label ? null : t.connector, t.mode].filter(Boolean).join(" · "),
    checked: same(screen, current),
    pickable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    pick: { screen },
  };
}

/** Why nothing in the Screen section can be picked: the host's settings file, else the grant
 *  this device lacks. Shown even when there are no rows. */
export function screenNote(t: ScreenTargets): string | undefined {
  if (t.locked) return words.screen_locked_hint();
  if (t.may_choose === false) return words.screen_host_decides();
  return undefined;
}

/** The Screen section. With `role`: the offered roles as only, main, second, then the monitors
 *  under "Show a monitor". Without: the host's rows in its order. Under a note only the checked
 *  row stays, greyed. */
export function screenRows(t: ScreenTargets): ScreenRow[] {
  const current = t.yours ?? t.host_default ?? "own";
  const targets = t.targets ?? [];
  const role = roleOf(t.role);
  let rows: ScreenRow[] = role
    ? [
        ...role.offered.map((r): ScreenRow => ({
          kind: "role",
          id: r,
          label: ROLE_WORDS[r].label(),
          hint: ROLE_WORDS[r].hint(),
          detail: "",
          checked: current === "own" && r === role.current,
          pickable: true,
          pick: { screen: "own", topology: ROLE_WORDS[r].topology },
        })),
        ...targets
          .filter((x) => x.id !== "own")
          .map((x, i) => ({ ...targetRow(x, current), ...(i === 0 ? { header: words.screen_show_monitor() } : {}) })),
      ]
    : targets.map((x) => targetRow(x, current));
  if (screenNote(t) !== undefined) {
    rows = rows.filter((r) => r.checked).map(({ header: _, ...r }) => ({ ...r, pickable: false }));
  }
  return rows.map(({ pick, ...r }) => (r.checked || !r.pickable || !pick ? r : { ...r, pick }));
}

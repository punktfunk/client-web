// Who plays on a box with profiles, and whether that profile's seat can take a stream yet.
//
// A twin of `pf_client_core::profiles` — the decision (§10.1), the seat gate (§9.2) and the
// card's line — so a browser asks, wakes and waits exactly as the native clients do. The host
// refuses a dial to a seat that isn't up, so the gate runs before the dial, not after.

/** One row of `GET /api/v1/profiles/enumerate`, the fields this page reads. */
export interface ProfileRow {
  readonly id: string;
  readonly display_name: string;
  /** `#RRGGBB` behind the initials. */
  readonly accent?: string | null;
  /** Host-relative URL of the picture. */
  readonly avatar?: string | null;
  /** This device's old seat became this profile. */
  readonly legacy_seat?: boolean;
  /** Absent for a profile that plays on the box's own session. */
  readonly seat?: SeatRow | null;
}

export interface SeatRow {
  /** `ready`, `starting`, `stopped`, `occupied` or `unavailable`; a newer word reads as ready. */
  readonly state: string;
  /** The progress line while starting, or why while unavailable. */
  readonly detail?: string | null;
  /** The device playing on it while occupied. */
  readonly occupant?: string | null;
  readonly steam_sign_in?: unknown;
}

/** The pick this browser keeps for a box. It carries the name and the picture's URL, which a
 *  card shows. */
export interface ProfilePick {
  readonly id: string;
  readonly display_name: string;
  /** Host-relative URL of the picture. */
  readonly avatar?: string;
  /** The player asked for it to be remembered. The console applies only such a pick. */
  readonly remember?: boolean;
}

/** What to do before dialling. */
export interface ProfileDecision {
  /** Ask who is playing; the dial waits for the answer. */
  readonly picker: boolean;
  /** The id the hello carries; unset sends none. */
  readonly send?: string;
  /** A remembered profile the box no longer lists, for the picker's line. */
  readonly gone?: string;
  /** The saved pick afterwards; `null` clears it. */
  readonly remember: ProfilePick | null;
}

/** What to do with the picked profile's seat. */
export type SeatGate =
  | { readonly kind: "dial" }
  | { readonly kind: "wake" }
  | { readonly kind: "wait"; readonly detail?: string }
  | { readonly kind: "refuse"; readonly line: string };

/** How often the list is read again while a seat comes up. */
export const SEAT_POLL_MS = 2000;

/** The host's refusal of another profile's seat (its 403), in its own words. */
export const WAKE_REFUSED = "This device isn't allowed to start another profile's seat.";

export const pickOf = (p: ProfileRow): ProfilePick => ({
  id: p.id,
  display_name: p.display_name,
  ...(p.avatar ? { avatar: p.avatar } : {}),
});

/** The profile `wanted` names: its id, else its name in any case, when only one has it. */
export function findProfile(listed: readonly ProfileRow[], wanted: string): ProfileRow | undefined {
  const byId = listed.find((p) => p.id === wanted);
  if (byId) return byId;
  const named = listed.filter((p) => p.display_name.toLowerCase() === wanted.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}

/**
 * §10.1. `listed` is `null` for a box without profiles. `link` is a link's `as=`: it wins for
 * this connect and leaves the saved pick alone. A kept pick keeps its `remember`.
 */
export function pickerDecision(
  listed: readonly ProfileRow[] | null,
  remembered: ProfilePick | null,
  link?: string,
): ProfileDecision {
  if (!listed) return { picker: false, ...(link ? { send: link } : {}), remember: remembered };
  const still = remembered ? listed.find((p) => p.id === remembered.id) : undefined;
  const kept = still ? { ...pickOf(still), ...(remembered?.remember ? { remember: true } : {}) } : null;
  if (link) {
    const p = findProfile(listed, link);
    return p ? { picker: false, send: p.id, remember: kept } : { picker: true, remember: kept };
  }
  if (listed.length === 1) return { picker: false, send: listed[0]!.id, remember: kept };
  if (still) return { picker: false, send: still.id, remember: kept };
  if (!remembered) {
    const legacy = listed.find((p) => p.legacy_seat);
    if (legacy) return { picker: false, send: legacy.id, remember: pickOf(legacy) };
  }
  return { picker: true, ...(remembered ? { gone: remembered.display_name } : {}), remember: null };
}

/** §9.2: the gate for `p`'s seat, as the list shows it. */
export function seatGate(p: ProfileRow): SeatGate {
  const seat = p.seat;
  if (!seat) return { kind: "dial" };
  switch (seat.state) {
    case "stopped":
      return { kind: "wake" };
    case "starting":
      return { kind: "wait", ...(seat.detail ? { detail: seat.detail } : {}) };
    case "unavailable":
      return { kind: "refuse", line: seat.detail ?? "That profile can't play on this host right now." };
    default:
      return { kind: "dial" };
  }
}

/** The one line under a picker card, if any. */
export function profileNote(p: ProfileRow): string | undefined {
  const seat = p.seat;
  if (!seat) return undefined;
  switch (seat.state) {
    case "occupied":
      return seat.occupant ? `In use by ${seat.occupant}` : "In use";
    case "starting":
      return seat.detail ?? "Getting ready…";
    case "unavailable":
      return seat.detail ?? "Unavailable";
    default:
      return seat.steam_sign_in === true ? "Steam sign-in once" : undefined;
  }
}

/** Initials for a profile without a picture: the first letters of its first two words. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join("");
}

/** The line while a seat comes up. */
export const wakingLine = (name: string): string => `Getting ${name}'s desk ready…`;

/** The line a failed wake ends a seat wait with: a refusal as its own sentence, anything else
 *  under the desk it was for. */
export function wakeFailed(name: string, status: number | undefined, why: string): string {
  return status === 403 ? WAKE_REFUSED : `Couldn't wake ${name}'s desk — ${why}`;
}

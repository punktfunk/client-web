// What the engine says to a person. The sentences are the monorepo's messages (`l10n/messages`);
// the page that draws them installs its compiled ones with `setWords`, so this library carries
// no wording and no Paraglide. A message the page never installed reads as its key.

/** The messages the engine reads, by key, as the compiled `m` namespace exports them. */
export interface Words {
  grant_level_full(): string;
  grant_level_controller(): string;
  grant_level_view(): string;
  grant_level_custom(): string;
  grant_now_full(): string;
  grant_now_controller(): string;
  grant_now_view(): string;
  grant_now_custom(): string;
  grant_chip_ends(p: { time: string }): string;
  grant_chip_ends_soon(): string;
  grant_ends_in(p: { time: string }): string;
  grant_ends_soon(): string;
  grant_remaining_minutes(p: { minutes: number }): string;
  grant_remaining_hours(p: { hours: number }): string;
  grant_remaining_hours_minutes(p: { hours: number; minutes: number }): string;
  error_mgmt_refused(p: { code: number }): string;
  lib_end_game_done(p: { title: string }): string;
  lib_end_game_not_running(p: { title: string }): string;
  lib_end_game_unsupported(): string;
  lib_end_game_expired(): string;
  lib_end_game_failed(p: { title: string; why: string }): string;
  profile_wake_refused(): string;
  reject_seat_unavailable(): string;
  profile_in_use_by(p: { device: string }): string;
  profile_in_use(): string;
  profile_getting_ready(): string;
  profile_unavailable(): string;
  profile_steam_sign_in(): string;
  profile_waking(p: { name: string }): string;
  profile_wake_failed(p: { name: string; reason: string }): string;
  browser_too_many(): string;
  browser_sign_in_failed(): string;
  hosts_error_address_empty(): string;
  hosts_error_address_invalid(p: { address: string }): string;
  browser_host_https(): string;
  browser_no_plane(): string;
  browser_no_attestation(): string;
  browser_not_paired_host(): string;
  browser_bad_signature(): string;
  browser_cert_no_key(): string;
  browser_host_status(p: { status: number }): string;
  browser_bridge_unopened(): string;
  browser_cannot_decode(): string;
  browser_needs_https(): string;
  browser_plane_off(): string;
  browser_legacy_identity(): string;
  browser_link_other_host(): string;
  browser_device_key(): string;
  browser_wt_refused(): string;
  browser_reply_unreadable(): string;
  browser_udp_unreachable(p: { port: number | string }): string;
  reject_host_power(): string;
  reject_access_expired(): string;
  reject_approval_timeout(): string;
  browser_overlay_carrier_ws(): string;
  browser_notice_no_hdr(): string;
  browser_codec_fallback(p: { from: string; to: string }): string;
  browser_codec_fallback_pinned(p: { from: string; to: string }): string;
}

/** A message the host named by id (`apierr_<code>`, `seatline_…`, `launch_…`), filled from the
 *  `params` it sent. `undefined` for an id this build has no message for, or one that needs a
 *  value the host left out: the caller shows the host's English then. */
export type HostWords = (id: string, params?: Record<string, string> | null) => string | undefined;

let installed: Partial<Words> = {};
let hostWords: HostWords = () => undefined;

/** Install the page's messages: the compiled `m` namespace and, for the ids a host sends, a
 *  lookup by key. */
export function setWords(words: Words, host?: HostWords): void {
  installed = words;
  hostWords = host ?? (() => undefined);
}

/** The installed messages. */
export const words = new Proxy({} as Words, {
  get: (_, key: string) => (params?: unknown) => {
    const message = installed[key as keyof Words] as ((p?: unknown) => string) | undefined;
    return message ? message(params) : key;
  },
});

/** A launch verdict as `rust/session.rs` hands it over — JSON of the host's `english`, and its
 *  message `id` and `params` when it named one — as the sentence for the player. Anything that
 *  does not parse reads as it came. */
export function launchNotice(json: string): string {
  try {
    const said = JSON.parse(json) as { english?: string; id?: string; params?: Record<string, string> };
    return hostWord(said.id, said.params, said.english ?? "");
  } catch {
    return json;
  }
}

/** The host's message `id` in the page's language, else `english`. */
export function hostWord<E extends string | null | undefined>(
  id: string | null | undefined,
  params: Record<string, string> | null | undefined,
  english: E,
): string | E {
  return (id ? hostWords(id, params) : undefined) ?? english;
}

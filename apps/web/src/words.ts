// The page's words: the compiled messages, handed to the engine, which carries none of its own.
// Imported first by `app.ts`, before anything can say a sentence.

import { setWords } from "@punktfunk/stream";
import { m } from "./paraglide/messages.js";

/** The host's messages by id: its API errors, seat lines, launch verdicts and refusals. A host
 *  names one by a string, so these are looked up by key and are the only ones kept whole. */
const HOST: Record<string, (params: Record<string, string>) => string> = {};
for (const [path, module] of Object.entries(
  import.meta.glob("./paraglide/messages/{apierr,launch,seatline,reject}_*.js", { eager: true }),
)) {
  const id = path.slice(path.lastIndexOf("/") + 1, -".js".length);
  HOST[id] = (module as Record<string, (params: Record<string, string>) => string>)[id]!;
}

/**
 * The message `id` the host named, filled from its `params`; `undefined` for an id this build has
 * no message for, or one whose value the host left out. A page and a host a version apart
 * disagree on ids, so a miss is normal and the caller shows the host's English.
 */
export function hostMessage(id: string, params?: Record<string, string> | null): string | undefined {
  const message = Object.hasOwn(HOST, id) ? HOST[id] : undefined;
  if (!message) return undefined;
  let complete = true;
  const given = params ?? {};
  const read = new Proxy(given, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (!Object.hasOwn(target, key)) complete = false;
      return target[key];
    },
  });
  const text = message(read);
  return complete ? text : undefined;
}

/** The sentence for an API error `code`: the host message `apierr_<code>`, else `english`. */
export function apiText<E extends string | null | undefined>(
  code: string | null | undefined,
  params: Record<string, string> | null | undefined,
  english: E,
): string | E {
  return (code ? hostMessage(`apierr_${code}`, params) : undefined) ?? english;
}

// Picked one by one: handing over the whole namespace would keep every message in the bundle.
setWords(
  {
    grant_level_full: m.grant_level_full,
    grant_level_controller: m.grant_level_controller,
    grant_level_view: m.grant_level_view,
    grant_level_custom: m.grant_level_custom,
    grant_now_full: m.grant_now_full,
    grant_now_controller: m.grant_now_controller,
    grant_now_view: m.grant_now_view,
    grant_now_custom: m.grant_now_custom,
    grant_chip_ends: m.grant_chip_ends,
    grant_chip_ends_soon: m.grant_chip_ends_soon,
    grant_ends_in: m.grant_ends_in,
    grant_ends_soon: m.grant_ends_soon,
    grant_remaining_minutes: m.grant_remaining_minutes,
    grant_remaining_hours: m.grant_remaining_hours,
    grant_remaining_hours_minutes: m.grant_remaining_hours_minutes,
    error_mgmt_refused: m.error_mgmt_refused,
    lib_end_game_done: m.lib_end_game_done,
    lib_end_game_not_running: m.lib_end_game_not_running,
    lib_end_game_unsupported: m.lib_end_game_unsupported,
    lib_end_game_expired: m.lib_end_game_expired,
    lib_end_game_failed: m.lib_end_game_failed,
    lib_hidden_done: m.lib_hidden_done,
    lib_shown_done: m.lib_shown_done,
    lib_hide_failed: m.lib_hide_failed,
    lib_show_failed: m.lib_show_failed,
    profile_wake_refused: m.profile_wake_refused,
    reject_seat_unavailable: m.reject_seat_unavailable,
    profile_in_use_by: m.profile_in_use_by,
    profile_in_use: m.profile_in_use,
    profile_getting_ready: m.profile_getting_ready,
    profile_unavailable: m.profile_unavailable,
    profile_steam_sign_in: m.profile_steam_sign_in,
    profile_waking: m.profile_waking,
    profile_wake_failed: m.profile_wake_failed,
    browser_too_many: m.browser_too_many,
    browser_sign_in_failed: m.browser_sign_in_failed,
    hosts_error_address_empty: m.hosts_error_address_empty,
    hosts_error_address_invalid: m.hosts_error_address_invalid,
    browser_host_https: m.browser_host_https,
    browser_no_plane: m.browser_no_plane,
    browser_no_attestation: m.browser_no_attestation,
    browser_not_paired_host: m.browser_not_paired_host,
    browser_bad_signature: m.browser_bad_signature,
    browser_cert_no_key: m.browser_cert_no_key,
    browser_host_status: m.browser_host_status,
    browser_bridge_unopened: m.browser_bridge_unopened,
    browser_cannot_decode: m.browser_cannot_decode,
    browser_needs_https: m.browser_needs_https,
    browser_plane_off: m.browser_plane_off,
    browser_legacy_identity: m.browser_legacy_identity,
    browser_link_other_host: m.browser_link_other_host,
    browser_device_key: m.browser_device_key,
    browser_wt_refused: m.browser_wt_refused,
    browser_reply_unreadable: m.browser_reply_unreadable,
    browser_udp_unreachable: m.browser_udp_unreachable,
    reject_host_power: m.reject_host_power,
    reject_access_expired: m.reject_access_expired,
    reject_approval_timeout: m.reject_approval_timeout,
    browser_overlay_carrier_ws: m.browser_overlay_carrier_ws,
    browser_notice_no_hdr: m.browser_notice_no_hdr,
    browser_codec_fallback: m.browser_codec_fallback,
    browser_codec_fallback_pinned: m.browser_codec_fallback_pinned,
    screen_own: m.screen_own,
    screen_in_use: m.screen_in_use,
    screen_off: m.screen_off,
    screen_locked_hint: m.screen_locked_hint,
    screen_host_decides: m.screen_host_decides,
    screen_show_monitor: m.screen_show_monitor,
    screen_role_only: m.screen_role_only,
    screen_role_main: m.screen_role_main,
    screen_role_second: m.screen_role_second,
    screen_role_only_hint: m.screen_role_only_hint,
    screen_role_main_hint: m.screen_role_main_hint,
    screen_role_second_hint: m.screen_role_second_hint,
  },
  hostMessage,
);

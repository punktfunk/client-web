// Opening a profile that needs an unlock: a locked profile's PIN, or the password of a person's
// own account. A twin of `pf_client_core::unlock`, pinned by the same
// `profile-unlock-vectors.json`. A browser has no secure key store, so it holds no unlock key
// and every unlock is typed.

/** What opens a profile from this device, as `enumerate`'s `unlock` word says. */
export type UnlockNeed = "none" | "password" | "key" | "pin" | "pin_key";

/** The prompt's field: the profile's PIN, or the account password. */
export type UnlockForm = "pin" | "password";

/** The need `word` reads as: absent is none, a word a later host adds is the password. */
export function unlockNeed(word: unknown): UnlockNeed {
  if (word === undefined || word === null || word === "none") return "none";
  return word === "key" || word === "pin" || word === "pin_key" ? word : "password";
}

/** The prompt's form for `need`; `null` when nothing is asked. */
export function unlockForm(need: UnlockNeed): UnlockForm | null {
  if (need === "none") return null;
  return need === "pin" || need === "pin_key" ? "pin" : "password";
}

/** Before a dial: go, sign with this device's key, or prompt. A key the host signed out
 *  (`deleteKey`) goes first. This page holds none, so it passes `holdsKey` false. */
export function unlockGate(need: UnlockNeed, holdsKey = false): { gate: "dial" | "key" | "prompt"; deleteKey: boolean } {
  if (need === "none") return { gate: "dial", deleteKey: false };
  if (holdsKey && (need === "key" || need === "pin_key")) return { gate: "key", deleteKey: false };
  return { gate: "prompt", deleteKey: holdsKey };
}

/** After a `ProfileLocked` close, from the profile's fresh row: the key for a dial that carried
 *  no unlock (`sent` false), else the prompt. Never a dial on its own. */
export function afterRefusal(need: UnlockNeed, holdsKey: boolean, sent: boolean): "key" | "prompt" {
  return !sent && unlockGate(need, holdsKey).gate === "key" ? "key" : "prompt";
}

/** `typed` as the PIN the wire carries: 4 to 8 ASCII digits, a full-width digit read as its
 *  ASCII one. Nothing is trimmed. */
export function pinDigits(typed: string): { sent: string } | { error: "empty" | "shape" } {
  if (typed === "") return { error: "empty" };
  let sent = "";
  for (const ch of typed) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x30 && code <= 0x39) sent += ch;
    else if (code >= 0xff10 && code <= 0xff19) sent += String.fromCharCode(code - 0xff10 + 0x30);
    else return { error: "shape" };
  }
  return sent.length >= 4 && sent.length <= 8 ? { sent } : { error: "shape" };
}

/** Longest password the wire takes, in UTF-8 bytes. */
const PASSWORD_MAX = 512;

/** Why the wire refuses `typed` as an account password, or `null`. Never trimmed. */
export function passwordProblem(typed: string): "empty" | "too_long" | "bad_char" | null {
  if (typed === "") return "empty";
  const bytes = new TextEncoder().encode(typed);
  if (bytes.length > PASSWORD_MAX) return "too_long";
  // A lone surrogate encodes as U+FFFD, so the round trip differs.
  return typed.includes("\0") || new TextDecoder().decode(bytes) !== typed ? "bad_char" : null;
}

// The English messages for a test, read from the files `scripts/l10n-messages.mjs` copied for the
// web app. A test that asserts wording installs them; every other test reads message keys.

import { readFileSync } from "node:fs";
import { setWords, type Words } from "./words.ts";

const PARTS = ["common", "client", "browser", "host"];

const messages = new Map<string, string>();
for (const part of PARTS) {
  const file = new URL(`../../../apps/web/l10n/${part}/en.json`, import.meta.url);
  for (const [key, text] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)) {
    if (typeof text === "string") messages.set(key, text);
  }
}

/** Fill `{name}` from `params`. */
const fill = (text: string, params: Record<string, unknown> = {}): string =>
  text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));

/** The English text of message `id`, else `undefined`: no such message, or a value it reads is
 *  missing from `params`. */
export function english(id: string, params?: Record<string, string> | null): string | undefined {
  const text = messages.get(id);
  const given = params ?? {};
  if (text === undefined || [...text.matchAll(/\{(\w+)\}/g)].some((m) => !(m[1]! in given))) return undefined;
  return fill(text, given);
}

/** Install the English messages as the page's words. */
export function useEnglish(): void {
  const words = new Proxy({} as Words, {
    get: (_, id: string) => (params?: Record<string, unknown>) => {
      const text = messages.get(id);
      if (text === undefined) throw new Error(`no English message ${id}`);
      return fill(text, params);
    },
  });
  setWords(words, english);
}

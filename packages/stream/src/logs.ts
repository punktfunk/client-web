// The page's own log, for sending to a host when something went wrong.
//
// A browser keeps console output nowhere a page can read it back, so this keeps a copy: the last
// lines of `console.*`, the wasm module's included, from the moment it is installed. Nothing
// leaves the page until someone sends it.

import { tizenInfo } from "./platform.ts";

const MAX_LINES = 2000;
/** Under the host's 1 MiB cap, with room for the header. */
const MAX_BYTES = 900_000;
const lines: string[] = [];
let installed = false;

/** Keep the console from now on. Idempotent; call it before anything logs. */
export function captureLog(): void {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      lines.push(`${new Date().toISOString()} ${level.toUpperCase()} ${args.map(text).join(" ")}`);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      original(...args);
    };
  }
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => console.error("uncaught:", e.message));
  window.addEventListener("unhandledrejection", (e) => console.error("unhandled rejection:", e.reason));
}

/** What the page has logged, under the browser it ran in — and on a Samsung set, the set: what
 *  the host files as a client log. */
export function pageLog(): string {
  const body = lines.join("\n");
  const tail = body.length > MAX_BYTES ? body.slice(body.length - MAX_BYTES) : body;
  const device = tizenInfo();
  const where = typeof location === "undefined" ? "" : `\npage: ${location.protocol}//${location.host}${location.pathname}`;
  return `punktfunk web client\nuser agent: ${navigator.userAgent}${device ? `\ndevice: ${device}` : ""}${where}\n\n${tail}\n`;
}

function text(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

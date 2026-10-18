// A TV remote on the few DOM screens the console leaves to the web shell: the trust question and
// the quick menu over a stream. Four arrows, Enter and Back, no pointer.
//
// The arrows move focus between the focusable things on the screen that is showing — buttons,
// links, a field — in document order, which on a sheet is reading order. Enter is the browser's
// own click on a focused button. Back is the screen's own way back: what its "Back" or "Cancel"
// button does, so a person is never stuck on a sheet with a remote. Installed on a packaged page
// only; a browser keeps its tab order and its mouse.

import { tvBack } from "@punktfunk/stream";
import type { Actions, Screen } from "./types.ts";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable elements of the screen on show, in document order. */
function focusable(): HTMLElement[] {
  const screen = document.querySelector<HTMLElement>("[data-screen]");
  if (!screen) return [];
  return [...screen.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Move focus along the screen's focusable things. Wraps at both ends, as a D-pad expects. */
export function moveFocus(step: 1 | -1): boolean {
  const items = focusable();
  if (items.length === 0) return false;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next]!.focus();
  return true;
}

/** What Back does on each DOM screen a packaged page can show. */
function back(screen: Screen, actions: Actions): boolean {
  switch (screen.kind) {
    case "streaming":
      // The menu's own keys close it (`hud.tsx`); with it closed, Back opens it.
      if (!screen.menu) actions.openMenu(true);
      return true;
    case "waiting":
      actions.cancelRequest();
      return true;
    case "trust":
    case "connecting":
    case "pair":
    case "error":
    case "accept":
      actions.back();
      return true;
    case "settings":
      actions.openSettings(false);
      return true;
    default:
      return false;
  }
}

/** Drive the DOM screens by remote. Returns the uninstall. */
export function installRemote(current: () => Screen, actions: () => Actions): () => void {
  const onKey = (e: KeyboardEvent) => {
    const screen = current();
    if (screen.kind === "console" || screen.kind === "home" || screen.kind === "library") return;
    // A field keeps its arrows for the caret; Back still leaves the sheet.
    const t = e.target as HTMLElement | null;
    const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    if (tvBack(e)) {
      if (screen.kind === "streaming" && screen.menu) return;
      if (back(screen, actions())) e.preventDefault();
      return;
    }
    if (inField) return;
    // The menu has its own rows; the sheets use document order.
    if (screen.kind === "streaming") return;
    if (e.code === "ArrowRight" || e.code === "ArrowDown") {
      if (moveFocus(1)) e.preventDefault();
    } else if (e.code === "ArrowLeft" || e.code === "ArrowUp") {
      if (moveFocus(-1)) e.preventDefault();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

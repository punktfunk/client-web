// The JSON the page and the gamepad console exchange: `pf_console_ui::bridge`'s contract, which
// Android and Apple speak too. The shapes are serde's: an enum is externally tagged, so a unit
// variant is its name as a string and a struct variant is `{ Name: { …fields } }`.

/** `pf_console_push` kinds. The numbers are Apple's (`clients/apple/native/src/console.rs`). */
export const CONSOLE_PUSH = {
  HOSTS: 0,
  PAIR: 1,
  WAKE: 2,
  NOTICE: 3,
  LIBRARY_BEGIN: 5,
  LIBRARY_PHASE: 6,
  LIBRARY_GAMES: 7,
  LIBRARY_RUNNING: 9,
  LIBRARY_STALE: 10,
  SETTINGS: 11,
  PRESETS: 12,
  KNOWN_HOSTS: 13,
  PADS: 14,
  NAVIGATE: 15,
} as const;

/** `pf_console_state` bits. */
export const CONSOLE_STATE = {
  /** Off screen for a stream. */
  IN_STREAM: 1,
  /** A launch hold keeps it over the stream it dialled. */
  HOLDS_LAUNCH: 2,
  /** A field is open: printable keys are text. */
  EDITING: 4,
  /** Back here would leave it. */
  AT_ROOT: 8,
} as const;

/** A host as the console's Home draws it (`pf_console_ui::HostRow`). */
export interface ConsoleHostRow {
  /** The fingerprint when pinned, else `addr:port`. */
  key: string;
  id?: string | null;
  name: string;
  addr: string;
  port: number;
  fp_hex: string;
  paired: boolean;
  saved: boolean;
  online: boolean;
  mgmt_port: number;
  can_wake: boolean;
  /** Last successful connect, UNIX seconds. */
  last_used: number | null;
  os: string;
  pin: null;
  bound_preset: null;
  running?: string;
}

/** A title as the console's shelf draws it (`pf_console_ui::LibraryGame`). */
export interface ConsoleGame {
  id: string;
  title: string;
  store: string;
  launcher: boolean;
  icon: string;
  platform: string | null;
  developer?: string | null;
  year?: number | null;
  genres?: string[];
  running: boolean;
}

/** `pf_client_core::console::OverlayAction`. */
export type ConsoleAction =
  | {
      Launch: {
        addr: string;
        port: number;
        fp_hex: string;
        /** A library id; `null` streams the desktop. */
        launch: string | null;
        title: string;
        preset: string | null;
        request_access: boolean;
      };
    }
  | { CopyText: string }
  | "CancelConnect"
  | "ShowStream"
  | "Quit";

/** `pf_console_ui::ConsoleCmd`: a struct variant by name, or a unit one as a string. */
export type ConsoleCmd = string | Record<string, Record<string, unknown>>;

/** One thing the console raised. */
export type ConsoleEvent =
  | { action: ConsoleAction }
  | { cmd: ConsoleCmd }
  | { pulse: "move" | "confirm" | "boundary" }
  | { editing: boolean }
  | { edit_text: { label: string; text: string; digits: boolean } | null }
  | { announce: string }
  | { settings: Record<string, unknown> };

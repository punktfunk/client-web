// What asking the host to end a game came to (`POST /api/v1/game/end`), in the words every
// punktfunk client uses: the native clients' `GameEnd`, line for line.

export type GameEnd =
  | { kind: "ended" }
  /** 409: the host had nothing of this title left to end. */
  | { kind: "not-running" }
  /** 401/404: a host that predates ending games from a device. */
  | { kind: "unsupported" }
  /** 403: this device's access to the host expired. */
  | { kind: "expired" }
  | { kind: "failed"; why: string };

export function gameEndOf(status: number): GameEnd {
  if (status >= 200 && status < 300) return { kind: "ended" };
  if (status === 409) return { kind: "not-running" };
  if (status === 401 || status === 404) return { kind: "unsupported" };
  if (status === 403) return { kind: "expired" };
  return { kind: "failed", why: `the host refused it (${status})` };
}

/** The game is gone, so a stream that was playing it can end. */
export function gameGone(e: GameEnd): boolean {
  return e.kind === "ended" || e.kind === "not-running";
}

/** The player-facing line. */
export function gameEndNotice(e: GameEnd, title: string): string {
  switch (e.kind) {
    case "ended":
      return `Ended ${title}.`;
    case "not-running":
      return `${title} isn't running any more.`;
    case "unsupported":
      return "This host needs an update to end games from here.";
    case "expired":
      return "This device's access to the host has expired.";
    case "failed":
      return `Couldn't end ${title} \u2014 ${e.why}`;
  }
}

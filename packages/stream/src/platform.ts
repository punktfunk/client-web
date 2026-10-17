// Where the page runs, when that changes what it does.
//
// Two facts, both read from the runtime and never from the user agent: whether the page is
// packaged — served from somewhere that is not `http(s):`, which is what a TV app is — and
// whether it runs on Samsung's Tizen, where `window.tizen` exists. Everything a packaged page
// does differently keys off these: how it reaches the host, which interface it starts in, what
// it does when the set goes to standby. None of it is a setting, and none of it can be.

/** Samsung's Tizen web runtime, the parts this client reads. Present only on the set. */
interface TizenGlobals {
  tizen?: {
    application?: { getCurrentApplication(): { exit(): void } };
    tvinputdevice?: { registerKey(name: string): void };
    systeminfo?: { getCapability(key: string): unknown };
  };
  webapis?: {
    productinfo?: {
      getModel?(): string;
      getRealModel?(): string;
      getFirmware?(): string;
      getVersion?(): string;
    };
  };
}

/** The page is a packaged app rather than one a server sent: `file://` on a TV, `app://`
 *  elsewhere. A packaged page cannot `fetch` a self-signed host and has no address bar. */
export function packaged(): boolean {
  if (typeof location === "undefined") return false;
  return location.protocol !== "http:" && location.protocol !== "https:";
}

/** Samsung's Tizen, by the object the runtime installs — never by the user agent. */
export function tizen(): boolean {
  return typeof window !== "undefined" && "tizen" in window;
}

const globals = (): TizenGlobals => (typeof window === "undefined" ? {} : (window as unknown as TizenGlobals));

/** Something a Tizen call may throw on: a privilege the package lacks, an older set. The
 *  caller has a fallback either way. */
function tizenCall<T>(f: () => T | undefined): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** The set's model as Samsung's product info gives it (`G95SC`), when the runtime offers it. */
export function tizenModel(): string | undefined {
  const info = globals().webapis?.productinfo;
  return tizenCall(() => info?.getRealModel?.() || info?.getModel?.()) || undefined;
}

/** What a log needs to know about the set: model, Tizen version, firmware, and the Chromium
 *  behind the runtime. One line; absent off Tizen. */
export function tizenInfo(): string | undefined {
  if (!tizen()) return undefined;
  const g = globals();
  const model = tizenModel() ?? "unknown model";
  const version = tizenCall(() =>
    String(g.tizen?.systeminfo?.getCapability("http://tizen.org/feature/platform.version") ?? ""),
  );
  const firmware = tizenCall(() => g.webapis?.productinfo?.getFirmware?.());
  const chromium = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1];
  return [
    `Samsung ${model}`,
    version ? `Tizen ${version}` : "",
    firmware ? `firmware ${firmware}` : "",
    chromium ? `Chromium ${chromium}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Close the app, where the runtime lets a page do that. On a TV Back at the root must exit.
 *  `false` where it cannot — a browser tab — so the caller leaves the page as it is. */
export function exitApp(): boolean {
  const app = tizenCall(() => globals().tizen?.application?.getCurrentApplication());
  if (!app) return false;
  tizenCall(() => app.exit());
  return true;
}

/** Ask the set for a remote key it keeps to itself until asked: a colour key, a digit. `false`
 *  off a set, or when the set refuses the name. */
export function remoteKey(name: string): boolean {
  const input = globals().tizen?.tvinputdevice;
  if (!input) return false;
  return tizenCall(() => (input.registerKey(name), true)) ?? false;
}

/**
 * The name this device pairs under: the browser and the machine it runs on, which is what tells
 * two devices apart in the host's list. An iPad asks for the desktop site and says `Macintosh`;
 * its touch points give it away. A Samsung set names itself by model.
 */
export function deviceName(): string {
  if (tizen()) {
    const model = tizenModel();
    return model ? `Samsung ${model}` : "Samsung TV";
  }
  const ua = navigator.userAgent;
  const browser = ua.includes("Firefox")
    ? "Firefox"
    : ua.includes("Edg/")
      ? "Edge"
      : ua.includes("Chrome")
        ? "Chrome"
        : "Safari";
  const os = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
    ? "iPad"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  return os ? `${browser} on ${os}` : browser;
}

// The client, minus the drawing.
//
// Every decision lives here — which host, whether it is trusted, when to pair, what to send and
// when — and a `Ui` only renders the `Screen` this produces and calls back with an `Action`. That
// is what lets the same client wear the web-native shell or the gamepad console: swapping them is
// the one line in `pickUi` below, and neither holds any state to keep in sync.
//
// The order of the trust steps is the whole point and does not vary: reach the host, check its
// attestation against what pairing stored, load the device key, *then* dial. Each step can only
// fail in one direction, and a browser that has never paired simply has nothing to check.

import type { PunktfunkModule } from "./emscripten.js";
import * as pf from "./pf-connect.js";
import { decodeSupported, VideoPipe } from "./video.js";
import { ConsoleUi } from "./ui/console.js";
import { WebShell } from "./ui/shell.js";
import type { Screen, SessionStats, Ui } from "./ui/types.js";

/** `pf_cred_phase` and `pf_session_phase`, named. Kept beside the exports they mirror. */
const CRED = { EMPTY: 0, READY: 1, NEEDS_SIGNATURE: 2, PAIRING: 3, PAIRED: 4, FAILED: 5 } as const;
const SESSION = { IDLE: 0, OFFERED: 1, LIVE: 2, FAILED: 3 } as const;

/** How long `Offered` may last before we conclude the host refused the credential. It closes the
 *  session without a message, so nothing else says so. */
const OFFERED_GRACE_MS = 5000;

class App {
  private ui!: Ui;
  private screen: Screen = { kind: "picker", hosts: [] };
  private origin: string | null = null;
  private plane: pf.Plane | null = null;
  private video: VideoPipe | null = null;
  private pairing = false;
  private settled = false;
  private offeredSince = 0;
  private lastFrames = 0;
  private lastSecond = 0;
  private fps = 0;

  constructor(
    private readonly mod: PunktfunkModule,
    private readonly ui_canvas: HTMLCanvasElement,
    private readonly video_canvas: HTMLCanvasElement,
  ) {}

  start(ui: Ui): void {
    this.ui = ui;
    ui.mount({
      connect: (address) => void this.connect(address),
      pair: (pin) => this.pair(pin),
      retry: () => void this.connect(this.origin ?? ""),
      back: () => this.toPicker(),
      forget: (origin) => {
        pf.hosts.forget(origin);
        this.toPicker();
      },
      disconnect: () => this.disconnect(),
    });

    this.mod.__pfOnDeviceReady = () => this.dial();
    this.mod.__pfOnCtlReady = () => this.onControlStream();

    if (!decodeSupported()) {
      return this.show({
        kind: "error",
        head: "No WebCodecs",
        text: "This browser cannot decode video. Safari 17, Chrome 94 or a recent Firefox can.",
      });
    }
    this.toPicker();
    requestAnimationFrame(() => this.frame());
  }

  private show(screen: Screen): void {
    this.screen = screen;
    this.ui.render(screen);
  }

  private toPicker(error?: string): void {
    this.origin = null;
    this.plane = null;
    this.pairing = false;
    this.settled = false;
    this.offeredSince = 0;
    this.show({ kind: "picker", hosts: pf.hosts.list(), ...(error ? { error } : {}) });
  }

  // --- reaching a host -------------------------------------------------------------------
  private async connect(address: string): Promise<void> {
    let origin: string;
    try {
      origin = pf.originOf(address);
    } catch (e) {
      return this.show({ kind: "picker", hosts: pf.hosts.list(), error: message(e) });
    }
    this.origin = origin;
    this.show({ kind: "picker", hosts: pf.hosts.list(), busy: true });

    // Tell "certificate not accepted" apart from "nothing there" before saying anything: the two
    // are the same opaque error, and only one of them has a fix the user can follow.
    const state = await pf.reach(origin);
    if (state === "unreachable") {
      return this.show({
        kind: "error",
        head: "No answer",
        text: `Nothing responded at ${origin}. Check the address, and that the host is running.`,
      });
    }
    if (state === "blocked") {
      return this.show({ kind: "accept", origin, url: pf.acceptUrl(origin) });
    }

    try {
      this.plane = await pf.fetchPlane(origin);
    } catch (e) {
      return this.show({ kind: "error", head: "No browser plane", text: message(e) });
    }

    const known = pf.hosts.fingerprint(origin);
    if (known) {
      try {
        await pf.verify(this.plane, known);
      } catch (e) {
        // Refuse before dialling. A host that cannot prove it is the one we paired with may still
        // be reachable — that is exactly the case this exists to catch.
        return this.show({
          kind: "error",
          head: "This is not the same host",
          text: `${message(e)}. Forget it on the previous screen to connect anyway.`,
        });
      }
    }
    pf.hosts.remember(origin, {});
    this.show({ kind: "connecting", origin });
    // The key BEFORE the connection: the host may ask for a signature the moment the control
    // stream opens, and a key still coming out of IndexedDB would miss it.
    withStr(this.mod, [this.plane.cert_hash_sha256], (p) => this.mod._pf_device_init(p));
  }

  /** The device key is loaded and Rust holds its SPKI. Dial now, not before. */
  private dial(): void {
    if (!this.origin || !this.plane) return;
    const url = `https://${new URL(this.origin).hostname}:${this.plane.port}/stream`;
    const ok = withStr(this.mod, [url, this.plane.cert_hash_sha256], (u, _ul, h) =>
      this.mod._pf_wt_connect(u, h),
    );
    if (!ok) {
      this.show({
        kind: "error",
        head: "Refused",
        text: "This browser refused the WebTransport session.",
      });
    }
  }

  private onControlStream(): void {
    if (!this.origin) return;
    if (!pf.hosts.fingerprint(this.origin)) {
      // Never paired with this host. The stream would be refused unless it was started with
      // `serve --open`, so ask for the PIN rather than let it fail silently.
      return this.show({
        kind: "pair",
        origin: this.origin,
        message: "Enter the PIN this host is showing.",
      });
    }
    this.video = new VideoPipe(this.mod, this.video_canvas);
    this.video.attach();
    const [w, h] = this.size();
    this.mod._pf_session_hello(w, h, 60, 20000);
  }

  private pair(pin: string): void {
    if (!this.origin) return;
    const name = navigator.userAgent.includes("Firefox")
      ? "Firefox"
      : navigator.userAgent.includes("Chrome")
        ? "Chrome"
        : "Safari";
    this.pairing = true;
    withStr(this.mod, [pin, name], (p, pl, n, nl) => this.mod._pf_pair_begin(p, pl, n, nl));
    this.show({ kind: "pair", origin: this.origin, message: "Pairing…", busy: true });
  }

  private disconnect(): void {
    this.video?.close();
    this.video = null;
    this.mod._pf_wt_close?.();
    this.toPicker();
  }

  // --- the frame loop --------------------------------------------------------------------
  private size(): [number, number] {
    // Device pixels, capped at 2× — beyond that a 4K panel costs more than it shows.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.ui_canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.ui_canvas.clientHeight * dpr));
    if (this.ui_canvas.width !== w || this.ui_canvas.height !== h) {
      this.ui_canvas.width = w;
      this.ui_canvas.height = h;
    }
    return [w, h];
  }

  private frame(): void {
    const [w, h] = this.size();

    // Signing is asynchronous and the phase can change on either side of it, so this is polled
    // rather than pushed. One check per frame costs nothing next to the draw.
    if (this.mod._pf_cred_phase() === CRED.NEEDS_SIGNATURE) this.mod._pf_device_sign();
    this.pumpCredential();

    this.mod._pf_session_pump();
    this.video?.present();
    this.updateSession();
    this.ui.frame?.(w, h);
    requestAnimationFrame(() => this.frame());
  }

  private pumpCredential(): void {
    if (!this.pairing || this.settled || !this.plane || !this.origin) return;
    const phase = this.mod._pf_cred_phase();
    if (phase === CRED.PAIRED) {
      this.settled = true;
      const origin = this.origin;
      const plane = this.plane;
      // The fingerprint stored is the long-lived identity's, not the plane's throwaway
      // certificate, which is replaced every twelve days.
      void pf.hostFingerprint(plane).then((fp) => {
        if (fp) pf.hosts.remember(origin, { fingerprint: fp });
        this.show({ kind: "pair", origin, message: "Paired. Reconnecting…", busy: true });
        // The host closes after the ceremony, as it does for native clients; streaming is a
        // fresh connection.
        setTimeout(() => location.reload(), 1200);
      });
    } else if (phase === CRED.FAILED) {
      this.settled = true;
      this.show({
        kind: "pair",
        origin: this.origin,
        message: "Enter the PIN this host is showing.",
        error: "That PIN was refused.",
      });
    }
  }

  private updateSession(): void {
    const phase = this.mod._pf_session_phase();

    // Offered and going nowhere means the host did not accept the credential — most often
    // because it has since unpaired this browser. It just closes, so nothing else says so, and a
    // blank screen is the worst possible answer.
    if (phase === SESSION.OFFERED && !this.pairing) {
      this.offeredSince ||= performance.now();
      if (performance.now() - this.offeredSince > OFFERED_GRACE_MS && this.origin) {
        this.offeredSince = 0;
        this.pairing = false;
        this.settled = false;
        this.show({
          kind: "pair",
          origin: this.origin,
          message: "This host no longer knows this browser. Enter its PIN to pair again.",
        });
      }
      return;
    }
    if (phase !== SESSION.LIVE || !this.origin) return;
    this.offeredSince = 0;

    const now = performance.now();
    const frames = this.mod._pf_session_frames();
    if (now - this.lastSecond >= 1000) {
      this.fps = Math.round(((frames - this.lastFrames) * 1000) / (now - this.lastSecond));
      this.lastFrames = frames;
      this.lastSecond = now;
    }
    const v = this.video?.snapshot();
    const stats: SessionStats = {
      origin: this.origin,
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      fps: this.fps,
      accessUnits: frames,
      decoded: v?.decoded ?? 0,
      dropped: v?.dropped ?? 0,
      uploadMs: v?.uploadMs ?? 0,
      backend: v?.backend ?? null,
    };
    this.show({ kind: "streaming", stats });
  }
}

/** `stringToNewUTF8` mallocs. Every caller frees, because these run on a reconnect loop and a page
 *  that leaks a string per attempt eventually stops connecting. */
function withStr<T>(
  mod: PunktfunkModule,
  strings: string[],
  f: (...args: number[]) => T,
): T {
  const ptrs = strings.map((s) => mod.stringToNewUTF8(s));
  try {
    return f(...ptrs.flatMap((p, i) => [p, new TextEncoder().encode(strings[i]).length]));
  } finally {
    for (const p of ptrs) mod._free(p);
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Which interface to wear.
 *
 * `?ui=console` asks for the gamepad shell — the same `pf-console-ui` every other client draws,
 * which is what a TV or a controller wants. Anything else gets the web-native one, because a
 * browser is usually held by a mouse and a keyboard and the console cannot offer a text field.
 */
function pickUi(mod: PunktfunkModule, container: HTMLElement): Ui {
  const shell = new WebShell(container);
  const wanted = new URLSearchParams(location.search).get("ui");
  return wanted === "console" ? new ConsoleUi(mod, shell) : shell;
}

const mod = await PunktfunkWeb();
const uiCanvas = document.getElementById("pf-ui") as HTMLCanvasElement;
const videoCanvas = document.getElementById("pf-video") as HTMLCanvasElement;
const app = new App(mod, uiCanvas, videoCanvas);
app.start(pickUi(mod, document.body));

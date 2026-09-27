// The host's pointer, worn as the page's own cursor.
//
// One pointer on screen, never two. While the pointer is free the host leaves its cursor out of
// the picture and forwards the bitmap, which becomes the video canvas's CSS cursor: it moves at
// the browser's rate, not the stream's. Under pointer lock there is no local pointer, so the host
// draws it into the picture again. A host that cannot forward (gamescope, an older Windows
// driver) always draws it, and the local pointer hides instead.

import type { PunktfunkModule } from "./emscripten.ts";

/** `HOST_CAP_CURSOR` in `Welcome::host_caps`. */
const HOST_CAP_CURSOR = 0x08;
/** `CURSOR_VISIBLE`, and the page's own "a state has arrived" bit. */
const VISIBLE = 0x01;
const SEEN = 0x100;
/** Chrome ignores a cursor image larger than this, in CSS pixels. */
const MAX_CSS = 128;
/** Shapes kept by serial. A desktop cycles through a dozen; this bounds a host that never repeats. */
const MAX_SHAPES = 64;

interface Shape {
  bitmap: HTMLCanvasElement;
  hotX: number;
  hotY: number;
}

export class HostCursor {
  private readonly shapes = new Map<number, Shape>();
  /** What `_pf_cursor_render` last said, `null` before the first word of a session. */
  private sent: boolean | null = null;
  /** The shape last worn, kept while a new serial's bitmap is still on its way. */
  private worn: Shape | null = null;
  /** The shape and size the canvas's cursor was last built from. */
  private built: { shape: Shape; w: number; h: number } | null = null;

  /** Keep a bitmap the host sent. Called from the glue, possibly before the first frame. */
  shape(serial: number, w: number, h: number, hotX: number, hotY: number, rgba: Uint8Array): void {
    if (this.shapes.size >= MAX_SHAPES) this.shapes.clear();
    const bitmap = document.createElement("canvas");
    bitmap.width = w;
    bitmap.height = h;
    const data = new ImageData(new Uint8ClampedArray(rgba), w, h);
    bitmap.getContext("2d")?.putImageData(data, 0, 0);
    this.shapes.set(serial, { bitmap, hotX, hotY });
  }

  /**
   * Once a frame while live. `input` is whether this page drives the host's pointer at all, and
   * `desktop` whether it does so in absolute mode: only then does the local pointer stand for the
   * host's. `captured` is pointer lock. `streamWidth` is the picture's width in stream pixels,
   * which the host scaled the bitmap to.
   */
  tick(mod: PunktfunkModule, canvas: HTMLCanvasElement, input: boolean, desktop: boolean, captured: boolean, streamWidth: number): void {
    const forwarded = ((mod._pf_session_host_caps?.() ?? 0) & HOST_CAP_CURSOR) !== 0;
    // The host draws under lock, and when this page sends no pointer at all. A free local
    // pointer over a composited one is a frozen twin.
    const clientDraws = input && !captured;
    if (forwarded && clientDraws !== this.sent) {
      this.sent = clientDraws;
      mod._pf_cursor_render?.(clientDraws ? 1 : 0);
    }
    // Capture mode before the lock takes the arrow: a click is what captures.
    const css = input && desktop && !captured ? (forwarded ? this.css(mod, canvas, streamWidth) : "none") : "";
    if (css !== canvas.style.cursor) canvas.style.cursor = css;
  }

  /** The CSS `cursor` for the host's pointer at the size the picture is shown. */
  private css(mod: PunktfunkModule, canvas: HTMLCanvasElement, streamWidth: number): string {
    const flags = mod._pf_cursor_flags?.() ?? 0;
    // Nothing heard yet: the arrow, rather than no pointer at all.
    if (!(flags & SEEN)) return "";
    if (!(flags & VISIBLE)) return "none";
    const shape = this.shapes.get(mod._pf_cursor_serial?.() ?? 0) ?? this.worn;
    if (!shape) return "";
    this.worn = shape;
    // The same fit `input.ts` maps the pointer through: CSS pixels per stream pixel.
    const r = canvas.getBoundingClientRect();
    const cw = canvas.width || streamWidth;
    const ch = canvas.height || 1;
    const scale = (Math.min(r.width / cw, r.height / ch) * cw) / Math.max(1, streamWidth);
    const w = Math.max(1, Math.min(MAX_CSS, Math.round(shape.bitmap.width * scale)));
    const h = Math.max(1, Math.min(MAX_CSS, Math.round(shape.bitmap.height * scale)));
    const b = this.built;
    if (b && b.shape === shape && b.w === w && b.h === h && canvas.style.cursor) return canvas.style.cursor;
    this.built = { shape, w, h };
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d")?.drawImage(shape.bitmap, 0, 0, w, h);
    const hx = Math.min(w - 1, Math.round(shape.hotX * (w / shape.bitmap.width)));
    const hy = Math.min(h - 1, Math.round(shape.hotY * (h / shape.bitmap.height)));
    return `url(${out.toDataURL()}) ${hx} ${hy}, auto`;
  }

  /** A session ended: forget its shapes and give the canvas its pointer back. */
  reset(canvas: HTMLCanvasElement): void {
    this.shapes.clear();
    this.sent = null;
    this.worn = null;
    this.built = null;
    if (canvas.style?.cursor) canvas.style.cursor = "";
  }
}

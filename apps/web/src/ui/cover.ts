// A cover as the console takes it cheapest.
//
// The console decodes the covers it is handed in wasm, on the render thread: on a Samsung set
// that was 100 to 300 ms a cover, three covers a frame, for as long as a library took to fill.
// So the browser decodes and scales each cover instead — `createImageBitmap`, which decodes off
// the main thread and scales as it goes — and hands the console an uncompressed bitmap at the
// size it would have cached. The console's decode is then a copy. On the main thread, by
// measurement: moved into a Web Worker, the same page died during every library fill on a
// Samsung set, and nothing in the page's own heap said why.

/** The longest sides a cover is handed over at: two grid cells at the scale a 1080p surface
 *  gives, which is the size the console keeps. Never enlarged. */
const COVER_W = 480;
const COVER_H = 720;

/** The BMP's header: file header and a 40-byte info header. */
const HEAD = 54;

/** `rgba` as a plain bottom-up 32-bit BMP, the form every Skia reads with its standard codec.
 *  The fourth byte is unused there, so a cover's alpha is dropped: covers are opaque. */
export function bmp(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array {
  const row = width * 4;
  const out = new Uint8Array(HEAD + row * height);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, out.length, true);
  v.setUint32(10, HEAD, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 32, true);
  v.setUint32(34, row * height, true);
  for (let y = 0; y < height; y++) {
    const src = y * row;
    const dst = HEAD + (height - 1 - y) * row;
    for (let x = 0; x < row; x += 4) {
      out[dst + x] = rgba[src + x + 2]!;
      out[dst + x + 1] = rgba[src + x + 1]!;
      out[dst + x + 2] = rgba[src + x]!;
      out[dst + x + 3] = 255;
    }
  }
  return out;
}

/** The size `w`×`h` is handed over at: within [`COVER_W`]×[`COVER_H`], never larger. */
export function fit(w: number, h: number): [number, number] {
  const s = Math.min(1, COVER_W / Math.max(w, 1), COVER_H / Math.max(h, 1));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** One canvas for every cover, sized to the largest: a canvas and its buffers a cover is
 *  garbage a 2 GB set collects too late. */
let scratch: OffscreenCanvasRenderingContext2D | null = null;

/**
 * `blob` decoded and sized by the browser, as a BMP; `null` where the browser cannot, and the
 * caller hands over the encoded bytes as before.
 *
 * Decoded straight to [`COVER_W`] wide, so a full-size cover never exists in memory — a decoder
 * scales as it goes. Only the rare picture taller than 2:3 takes a second, smaller pass.
 */
export async function coverBytes(blob: Blob): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    let bitmap = await createImageBitmap(blob, { resizeWidth: COVER_W, resizeQuality: "high" });
    if (bitmap.height > COVER_H) {
      const [w, h] = fit(bitmap.width, bitmap.height);
      const smaller = await createImageBitmap(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
      bitmap.close();
      bitmap = smaller;
    }
    const { width: w, height: h } = bitmap;
    scratch ??= new OffscreenCanvas(COVER_W, COVER_H).getContext("2d", { willReadFrequently: true });
    if (!scratch) return null;
    scratch.drawImage(bitmap, 0, 0);
    bitmap.close();
    return bmp(w, h, scratch.getImageData(0, 0, w, h).data);
  } catch {
    return null;
  }
}

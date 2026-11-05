/**
 * "WhatsApp forward" degradation of a reference photo: downscale to a small long edge and
 * recompress as baseline JPEG more than once. Pure, so the R2 quality gate can be tested on it.
 */
import type { RgbaImage } from './metrics.ts';
import { decodeJpegBuffer, encodeJpeg, scaleImage } from './png.ts';

export interface DegradeOptions {
  /** Long edge after downscaling (px). Messaging apps land around 700–800. */
  maxEdge: number;
  /** JPEG quality of each pass (0..100). */
  quality: number;
  /** Number of encode/decode passes; forwards are recompressed at every hop. */
  passes: number;
}

export const WHATSAPP_LIKE: DegradeOptions = { maxEdge: 700, quality: 55, passes: 2 };

/** Returns the degraded pixels and the final JPEG bytes. */
export function degradeImage(img: RgbaImage, opts: DegradeOptions = WHATSAPP_LIKE): { image: RgbaImage; jpeg: Buffer } {
  const longEdge = Math.max(img.width, img.height);
  let current = longEdge > opts.maxEdge ? scaleImage(img, opts.maxEdge / longEdge) : img;
  let bytes = encodeJpeg(current, opts.quality);
  for (let i = 1; i < opts.passes; i++) {
    current = decodeJpegBuffer(bytes);
    bytes = encodeJpeg(current, opts.quality);
  }
  return { image: decodeJpegBuffer(bytes), jpeg: bytes };
}

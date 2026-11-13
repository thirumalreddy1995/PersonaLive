/**
 * Layout for review sheets that always show the persona's own photo (R6b, after the R6 visual
 * audit: sheets that compared configurations with each other never showed what "A" looks like).
 */
import type { Rect } from './metrics.ts';

/**
 * Native-resolution face crop of a capture: the box of the 468 mesh landmarks padded so the jaw,
 * the hairline, the ears and the top of the neck are in view, clipped to the frame.
 */
export function auditFaceRect(points: ArrayLike<number>, width: number, height: number): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 468; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: width, h: height };
  const w = x1 - x0;
  const h = y1 - y0;
  const X0 = Math.max(0, Math.floor(x0 - 0.3 * w));
  const X1 = Math.min(width, Math.ceil(x1 + 0.3 * w));
  const Y0 = Math.max(0, Math.floor(y0 - 0.35 * h));
  const Y1 = Math.min(height, Math.ceil(y1 + 0.25 * h));
  return { x: X0, y: Y0, w: Math.max(1, X1 - X0), h: Math.max(1, Y1 - Y0) };
}

/**
 * The part of a persona photo to show beside a face crop of the given aspect (width / height):
 * 60% of the photo's height, centred horizontally and a little above the middle (where a portrait
 * or an enrollment shot has the face), with the same aspect, clipped to the photo.
 */
export function referenceRect(imageWidth: number, imageHeight: number, aspect: number): Rect {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  let h = imageHeight * 0.6;
  let w = h * a;
  if (w > imageWidth) {
    w = imageWidth;
    h = w / a;
  }
  const x = Math.min(Math.max(0, imageWidth / 2 - w / 2), imageWidth - w);
  const y = Math.min(Math.max(0, imageHeight * 0.42 - h / 2), imageHeight - h);
  return { x, y, w, h };
}

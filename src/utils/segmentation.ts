/**
 * Segmentation masks (R4 §1): pure helpers around the MediaPipe multiclass selfie segmenter.
 *
 * The model's categories are 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes,
 * 5 accessories. The persona shader needs hair (ghost strands), body-skin (a hand in front of
 * the face), face-skin (where the persona may show) and accessories (glasses), so the four
 * confidence masks are packed into one RGBA8 image (R hair, G body-skin, B face-skin, A
 * accessories) and smoothed over time with an EMA before the renderer uploads them.
 *
 * This module has no MediaPipe dependency so the packing and the EMA are unit-testable; the
 * engine-side wrapper that owns the segmenter lives in segmenter.ts.
 */

export const SEG_SIZE = 256;
export const SEG_CATEGORY = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, accessories: 5 } as const;
/** EMA weight of each new segmentation (the segmenter runs every `segmentEvery` frames). */
export const SEG_EMA = 0.5;

export type NormRect = [number, number, number, number];

export interface PackedMasks {
  /** RGBA8, SEG_SIZE × SEG_SIZE, row 0 = top of the crop. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Updates applied so far (0 = never segmented). */
  updates: number;
  /** The crop the masks cover, in normalised source coordinates (x, y, w, h); [0, 0, 1, 1] = whole frame. */
  rect: NormRect;
}

export function emptyMasks(width = SEG_SIZE, height = SEG_SIZE): PackedMasks {
  return { data: new Uint8ClampedArray(width * height * 4), width, height, updates: 0, rect: [0, 0, 1, 1] };
}

/** Points the masks at a new crop; a different crop restarts the EMA (old pixels no longer line up). */
export function setMaskRect(m: PackedMasks, rect: NormRect): void {
  const same = rect.every((v, i) => Math.abs(v - m.rect[i]) < 1e-6);
  if (!same) {
    m.rect = [rect[0], rect[1], rect[2], rect[3]];
    m.updates = 0;
  }
}

/**
 * Square-ish face crop for the segmenter (R4): the face box expanded to cover hair and hands
 * around it, in normalised source coordinates, clamped to the frame. `face` is the face box in
 * normalised source coordinates; `aspect` is source width / height.
 */
export function faceCropRect(face: NormRect, aspect: number, expand = 2.1): NormRect {
  const cx = face[0] + face[2] / 2;
  const cy = face[1] + face[3] / 2 - face[3] * 0.12; // a little up: hair above the forehead
  // Square in pixels: side = expand × the larger face side (in pixels).
  const sidePx = expand * Math.max(face[2] * aspect, face[3]);
  let w = Math.min(1, sidePx / aspect);
  let h = Math.min(1, sidePx);
  let x = Math.min(Math.max(cx - w / 2, 0), 1 - w);
  let y = Math.min(Math.max(cy - h / 2, 0), 1 - h);
  if (!Number.isFinite(x + y + w + h) || w <= 0 || h <= 0) return [0, 0, 1, 1];
  return [x, y, w, h];
}

/**
 * Keeps the current crop while the new one is close (centre within 8% of the crop size, size
 * within 12%), so the EMA is not restarted by every small head movement.
 */
export function stableCrop(current: NormRect | null, next: NormRect): NormRect {
  if (!current) return next;
  const dc = Math.hypot(current[0] + current[2] / 2 - (next[0] + next[2] / 2), current[1] + current[3] / 2 - (next[1] + next[3] / 2));
  const size = Math.max(current[2], current[3]);
  const ratio = next[2] / current[2];
  return dc < 0.08 * size && ratio > 0.88 && ratio < 1.12 ? current : next;
}

/**
 * Packs the four confidence masks (float 0..1, row-major, `width × height`) into `target` with an
 * EMA against its previous content. The first update copies the masks as they are.
 */
export function packMasks(
  target: PackedMasks,
  hair: ArrayLike<number>,
  bodySkin: ArrayLike<number>,
  faceSkin: ArrayLike<number>,
  accessories: ArrayLike<number>,
  alpha = SEG_EMA
): PackedMasks {
  const n = target.width * target.height;
  const d = target.data;
  const first = target.updates === 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const h = hair[i] * 255, b = bodySkin[i] * 255, f = faceSkin[i] * 255, a = accessories[i] * 255;
    if (first) {
      d[p] = h; d[p + 1] = b; d[p + 2] = f; d[p + 3] = a;
    } else {
      d[p] += (h - d[p]) * alpha;
      d[p + 1] += (b - d[p + 1]) * alpha;
      d[p + 2] += (f - d[p + 2]) * alpha;
      d[p + 3] += (a - d[p + 3]) * alpha;
    }
  }
  target.updates++;
  return target;
}

/** Packs a category mask (one byte per pixel, SEG_CATEGORY values) as binary masks with the same EMA. */
export function packCategory(target: PackedMasks, category: ArrayLike<number>, alpha = SEG_EMA): PackedMasks {
  const n = target.width * target.height;
  const hair = new Float32Array(n), body = new Float32Array(n), face = new Float32Array(n), acc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = category[i];
    if (c === SEG_CATEGORY.hair) hair[i] = 1;
    else if (c === SEG_CATEGORY.bodySkin) body[i] = 1;
    else if (c === SEG_CATEGORY.faceSkin) face[i] = 1;
    else if (c === SEG_CATEGORY.accessories) acc[i] = 1;
  }
  return packMasks(target, hair, body, face, acc, alpha);
}

/** Bilinear sample of one packed channel (0 hair, 1 body-skin, 2 face-skin, 3 accessories) at normalised source coordinates. */
export function sampleMask(m: PackedMasks, channel: 0 | 1 | 2 | 3, u: number, v: number): number {
  // u, v are normalised source coordinates; outside the crop nothing is known (0).
  const cu = (u - m.rect[0]) / m.rect[2];
  const cv = (v - m.rect[1]) / m.rect[3];
  if (cu < 0 || cu > 1 || cv < 0 || cv > 1) return 0;
  const x = Math.min(Math.max(cu * m.width - 0.5, 0), m.width - 1);
  const y = Math.min(Math.max(cv * m.height - 0.5, 0), m.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, m.width - 1), y1 = Math.min(y0 + 1, m.height - 1);
  const fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number) => m.data[(yy * m.width + xx) * 4 + channel] / 255;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

/**
 * Share of the masked region (mask ≥ `threshold`) inside a face-oval polygon of a photo, with
 * the mask given at its own resolution and the polygon in photo pixels. Used by the persona
 * quality gate ("hair or glasses over N% of the face skin").
 */
export function maskedShareInPolygon(m: PackedMasks, channels: Array<0 | 1 | 2 | 3>, polygon: Array<{ x: number; y: number }>, photoWidth: number, photoHeight: number, threshold = 0.5): number {
  let inside = 0, masked = 0;
  for (let y = 0; y < m.height; y++) {
    const py = ((y + 0.5) / m.height) * photoHeight;
    for (let x = 0; x < m.width; x++) {
      const px = ((x + 0.5) / m.width) * photoWidth;
      if (!insidePolygon(polygon, px, py)) continue;
      inside++;
      let v = 0;
      for (const c of channels) v = Math.max(v, m.data[(y * m.width + x) * 4 + c] / 255);
      if (v >= threshold) masked++;
    }
  }
  return inside ? masked / inside : 0;
}

export function insidePolygon(poly: Array<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

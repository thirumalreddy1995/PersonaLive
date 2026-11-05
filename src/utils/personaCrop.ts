/**
 * Reference preprocessing (R2 §2): crop the persona photo to the face-oval bounds × 1.6, resize
 * so the long side is at most the texture size setting, and recompute the UVs for the crop.
 * Pure geometry here; the engine does the drawing.
 */
import { FACE_OVAL_RING } from '../../tools/realism/landmarks.ts';

export interface CropPlan {
  /** Source rectangle in photo pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output texture size in pixels. */
  width: number;
  height: number;
  /** Scale from source pixels to texture pixels. */
  scale: number;
}

/** Face-oval bounds of normalized landmarks, in photo pixels. */
export function faceOvalBounds(normalized: ArrayLike<number>, imageWidth: number, imageHeight: number) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of FACE_OVAL_RING) {
    const x = normalized[i * 2] * imageWidth;
    const y = normalized[i * 2 + 1] * imageHeight;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * @param expand   crop size as a multiple of the face-oval bounds (plan: 1.6)
 * @param maxEdge  longest texture edge (setting: 512 / 1024 / 2048); the crop is never upscaled
 */
export function planCrop(normalized: ArrayLike<number>, imageWidth: number, imageHeight: number, maxEdge: number, expand = 1.6): CropPlan {
  const b = faceOvalBounds(normalized, imageWidth, imageHeight);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  let sw = b.width * expand;
  let sh = b.height * expand;
  let sx = cx - sw / 2;
  let sy = cy - sh / 2;
  // Clamp to the photo.
  if (sx < 0) sx = 0;
  if (sy < 0) sy = 0;
  if (sx + sw > imageWidth) sw = imageWidth - sx;
  if (sy + sh > imageHeight) sh = imageHeight - sy;
  sw = Math.max(1, Math.round(sw));
  sh = Math.max(1, Math.round(sh));
  sx = Math.round(sx);
  sy = Math.round(sy);
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  return { sx, sy, sw, sh, width, height, scale: width / sw };
}

/** Normalized landmarks of the photo → normalized UVs inside the crop. */
export function cropUvs(normalized: ArrayLike<number>, imageWidth: number, imageHeight: number, plan: CropPlan): Float32Array {
  const out = new Float32Array(normalized.length);
  for (let i = 0; i < normalized.length; i += 2) {
    out[i] = (normalized[i] * imageWidth - plan.sx) / plan.sw;
    out[i + 1] = (normalized[i + 1] * imageHeight - plan.sy) / plan.sh;
  }
  return out;
}

/**
 * Symmetric de-light (R3c item 2, flag symmetricDelight).
 *
 * In face-aligned coordinates (the mesh itself), the persona's mid-band luminance between the 2%
 * low pass and the active relight radius is split into the part that is mirror-symmetric about the
 * face midline and the part that is not. The symmetric part (eye sockets, nose, cheek hollows) is
 * form and stays; the asymmetric part is the photo's key light and is divided out. Everything is
 * evaluated per mesh vertex (468 samples; the band is 2–8% of the face wide, so vertex spacing is
 * fine enough) and handed to the shader as a per-vertex gain in linear light.
 *
 * Pure module: mirror pairs from the canonical model, integral-image band luma, the gains.
 */
import { CANONICAL_FACE_MODEL, CANONICAL_FACE_VERTEX_COUNT } from './canonicalFaceModel.ts';

/** Band scales (share of face width) the per-vertex luma is precomputed at. */
export const DELIGHT_SCALES = [0.02, 0.04, 0.06, 0.08];
export const DELIGHT_GAIN_MIN = 0.5;
export const DELIGHT_GAIN_MAX = 2;

let cachedPairs: Int16Array | null = null;

/** For every canonical vertex, the index of its mirror image across the x = 0 plane (itself on the midline). */
export function mirrorPairs(): Int16Array {
  if (cachedPairs) return cachedPairs;
  const n = CANONICAL_FACE_VERTEX_COUNT;
  const m = CANONICAL_FACE_MODEL;
  const pairs = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = -m[i * 3], y = m[i * 3 + 1], z = m[i * 3 + 2];
    let best = i, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      const d = (m[j * 3] - x) ** 2 + (m[j * 3 + 1] - y) ** 2 + (m[j * 3 + 2] - z) ** 2;
      if (d < bestD) { bestD = d; best = j; }
    }
    pairs[i] = best;
  }
  cachedPairs = pairs;
  return pairs;
}

/** Summed-area table of linear luma (row-major, (w+1)×(h+1)). */
export function integralLuma(data: ArrayLike<number>, width: number, height: number): Float64Array {
  const W = width + 1;
  const out = new Float64Array(W * (height + 1));
  const lin = (v: number) => Math.pow(v / 255, 2.2);
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      row += 0.2126 * lin(data[p]) + 0.7152 * lin(data[p + 1]) + 0.0722 * lin(data[p + 2]);
      out[(y + 1) * W + x + 1] = out[y * W + x + 1] + row;
    }
  }
  return out;
}

/** Mean luma of the square of half-size `r` around (cx, cy), clipped to the image. */
export function boxMean(integral: Float64Array, width: number, height: number, cx: number, cy: number, r: number): number {
  const W = width + 1;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(height, Math.ceil(cy + r));
  const area = (x1 - x0) * (y1 - y0);
  if (area <= 0) return 0;
  const s = integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0];
  return s / area;
}

/**
 * Per-vertex mean luma at each scale: `result[s][v]` for scale DELIGHT_SCALES[s]. `uv` are the
 * persona landmarks normalised to the texture; `faceWidthPx` is the face width in texture pixels.
 */
export function vertexBandLuma(data: ArrayLike<number>, width: number, height: number, uv: ArrayLike<number>, faceWidthPx: number, scales = DELIGHT_SCALES): Float32Array[] {
  const integral = integralLuma(data, width, height);
  return scales.map((s) => {
    const out = new Float32Array(CANONICAL_FACE_VERTEX_COUNT);
    const r = Math.max(1, s * faceWidthPx);
    for (let v = 0; v < CANONICAL_FACE_VERTEX_COUNT; v++) out[v] = boxMean(integral, width, height, uv[v * 2] * width, uv[v * 2 + 1] * height, r);
    return out;
  });
}

/** Per-vertex luma at an arbitrary scale by linear interpolation between the precomputed ones. */
export function lumaAtScale(bands: Float32Array[], scale: number, scales = DELIGHT_SCALES): Float32Array {
  const s = Math.min(Math.max(scale, scales[0]), scales[scales.length - 1]);
  let i = 0;
  while (i < scales.length - 2 && scales[i + 1] < s) i++;
  const t = (s - scales[i]) / (scales[i + 1] - scales[i]);
  const out = new Float32Array(bands[i].length);
  for (let v = 0; v < out.length; v++) out[v] = bands[i][v] + (bands[i + 1][v] - bands[i][v]) * t;
  return out;
}

/**
 * Gains that remove the asymmetric part of log(L_fine / L_coarse) per vertex: 1 on the midline,
 * exp(−asym) elsewhere, clamped to [DELIGHT_GAIN_MIN, DELIGHT_GAIN_MAX].
 */
export function symmetricDelightGains(fine: Float32Array, coarse: Float32Array, pairs: Int16Array = mirrorPairs()): Float32Array {
  const n = fine.length;
  const band = new Float32Array(n);
  for (let v = 0; v < n; v++) band[v] = Math.log(Math.max(fine[v], 1e-4) / Math.max(coarse[v], 1e-4));
  const gains = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const asym = (band[v] - band[pairs[v]]) / 2;
    gains[v] = Math.min(DELIGHT_GAIN_MAX, Math.max(DELIGHT_GAIN_MIN, Math.exp(-asym)));
  }
  return gains;
}

/**
 * Persona de-light (R3b, flag personaDelight).
 *
 * At persona load, fits a smooth low-order shading field over the persona photo's face skin (a
 * 2nd-order polynomial per RGB channel in face coordinates, in linear light) and divides it out,
 * keeping the mean skin colour. The photo's key/fill light and its colour cast go; mid-scale form
 * (nose, cheekbones, eye sockets) stays because a quadratic cannot follow it. The correction fades
 * to nothing outside the face oval so hair and background stay untouched.
 *
 * Pure module (no DOM): operates on an RGBA byte array with landmark pixel positions.
 */

export const LEFT_EYE_RING = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const RIGHT_EYE_RING = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const LEFT_BROW_RING = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
export const RIGHT_BROW_RING = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
export const OUTER_LIP_RING = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
export const FACE_OVAL_RING = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
  234, 127, 162, 21, 54, 103, 67, 109,
];

/** Correction fades from full at FADE_IN × the oval radius to nothing at FADE_OUT × it. */
export const DELIGHT_FADE_IN = 1.15;
export const DELIGHT_FADE_OUT = 1.6;
/** Per-channel correction clamp (the field is never trusted beyond a 3× swing). */
export const DELIGHT_MAX_GAIN = 3;

export interface DelightResult {
  /** Skin pixels the fit used. */
  pixels: number;
  /** Max / min of the fitted luma field over the skin mask (1 = the photo was already flat). */
  range: number;
  /** Fitted coefficients per channel: [1, u, v, u², uv, v²] in oval-normalised face coordinates. */
  coefficients: [number[], number[], number[]];
}

interface Pt {
  x: number;
  y: number;
}

function ring(points: ArrayLike<number>, indices: number[]): Pt[] {
  return indices.map((i) => ({ x: points[i * 2], y: points[i * 2 + 1] }));
}

function centroid(poly: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of poly) { x += p.x; y += p.y; }
  return { x: x / poly.length, y: y / poly.length };
}

function scalePoly(poly: Pt[], factor: number): Pt[] {
  const c = centroid(poly);
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * factor, y: c.y + (p.y - c.y) * factor }));
}

/** Even-odd point-in-polygon test. */
export function insidePolygon(poly: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function srgbToLinear(v: number): number {
  return Math.pow(v / 255, 2.2);
}

function linearToSrgb(v: number): number {
  return Math.round(Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2) * 255);
}

/** Solves A x = b for a small dense symmetric system by Gaussian elimination with partial pivoting. */
export function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Builds the skin mask (face oval minus eyes ×2, brows ×1.4, outer lips ×1.5) and the oval frame.
 * Returns the mask as Uint8Array (1 = skin) plus the oval centre and half-axes.
 */
export function skinMaskForDelight(points: ArrayLike<number>, width: number, height: number) {
  const oval = ring(points, FACE_OVAL_RING);
  const holes = [
    scalePoly(ring(points, LEFT_EYE_RING), 2.0),
    scalePoly(ring(points, RIGHT_EYE_RING), 2.0),
    scalePoly(ring(points, LEFT_BROW_RING), 1.4),
    scalePoly(ring(points, RIGHT_BROW_RING), 1.4),
    scalePoly(ring(points, OUTER_LIP_RING), 1.5),
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of oval) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const ax = Math.max(1, (maxX - minX) / 2), ay = Math.max(1, (maxY - minY) / 2);
  const inner = scalePoly(oval, 0.95);
  const mask = new Uint8Array(width * height);
  const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(width - 1, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(height - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!insidePolygon(inner, x + 0.5, y + 0.5)) continue;
      let hole = false;
      for (const h of holes) if (insidePolygon(h, x + 0.5, y + 0.5)) { hole = true; break; }
      if (!hole) mask[y * width + x] = 1;
    }
  }
  return { mask, cx, cy, ax, ay };
}

/**
 * Fits and divides out the shading field in place. `points` are landmark pixel positions in this
 * image (468 × 2 at least). Returns null (image untouched) when the fit has too few pixels.
 */
export function delightPersona(data: Uint8ClampedArray | Uint8Array, width: number, height: number, points: ArrayLike<number>): DelightResult | null {
  const { mask, cx, cy, ax, ay } = skinMaskForDelight(points, width, height);
  // Sample every k-th skin pixel for the fit (≤ ~40k samples) and reject outliers by luma.
  const total = mask.reduce((a, b) => a + b, 0);
  if (total < 500) return null;
  const stride = Math.max(1, Math.floor(total / 40000));
  const lum: number[] = [];
  const idx: number[] = [];
  let seen = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (seen++ % stride) continue;
    const p = i * 4;
    const l = 0.2126 * srgbToLinear(data[p]) + 0.7152 * srgbToLinear(data[p + 1]) + 0.0722 * srgbToLinear(data[p + 2]);
    lum.push(l);
    idx.push(i);
  }
  const sorted = [...lum].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const lo = median * 0.3, hi = median * 3;
  // Normal equations for the basis [1, u, v, u², uv, v²], one right-hand side per channel.
  const ata = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  const atb: [number[], number[], number[]] = [new Array(6).fill(0), new Array(6).fill(0), new Array(6).fill(0)];
  let used = 0;
  for (let s = 0; s < idx.length; s++) {
    if (lum[s] < lo || lum[s] > hi) continue;
    const i = idx[s];
    const u = ((i % width) + 0.5 - cx) / ax;
    const v = (Math.floor(i / width) + 0.5 - cy) / ay;
    const basis = [1, u, v, u * u, u * v, v * v];
    const p = i * 4;
    const rgb = [srgbToLinear(data[p]), srgbToLinear(data[p + 1]), srgbToLinear(data[p + 2])];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) ata[r][c] += basis[r] * basis[c];
      for (let ch = 0; ch < 3; ch++) atb[ch][r] += basis[r] * rgb[ch];
    }
    used++;
  }
  if (used < 300) return null;
  const coef: number[][] = [];
  for (let ch = 0; ch < 3; ch++) {
    const x = solveLinear(ata, atb[ch]);
    if (!x) return null;
    coef.push(x);
  }
  const field = (c: number[], u: number, v: number) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;
  // Mean of each channel's field over the skin mask: the correction keeps it.
  const mean = [0, 0, 0];
  let n = 0;
  let fMin = Infinity, fMax = 0;
  for (let i = 0; i < mask.length; i += stride) {
    if (!mask[i]) continue;
    const u = ((i % width) + 0.5 - cx) / ax;
    const v = (Math.floor(i / width) + 0.5 - cy) / ay;
    let l = 0;
    for (let ch = 0; ch < 3; ch++) {
      const f = field(coef[ch], u, v);
      mean[ch] += f;
      l += [0.2126, 0.7152, 0.0722][ch] * f;
    }
    fMin = Math.min(fMin, l);
    fMax = Math.max(fMax, l);
    n++;
  }
  for (let ch = 0; ch < 3; ch++) mean[ch] /= Math.max(1, n);
  if (mean.some((m) => !(m > 1e-4))) return null;
  // Apply: linear × clamp(mean / field) blended toward 1 outside the oval.
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5 - cy) / ay;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5 - cx) / ax;
      const r = Math.sqrt(u * u + v * v);
      if (r >= DELIGHT_FADE_OUT) continue;
      const w = r <= DELIGHT_FADE_IN ? 1 : (DELIGHT_FADE_OUT - r) / (DELIGHT_FADE_OUT - DELIGHT_FADE_IN);
      const p = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const f = field(coef[ch], u, v);
        const gain = Math.min(DELIGHT_MAX_GAIN, Math.max(1 / DELIGHT_MAX_GAIN, mean[ch] / Math.max(f, 1e-4)));
        const g = 1 + (gain - 1) * w;
        data[p + ch] = linearToSrgb(srgbToLinear(data[p + ch]) * g);
      }
    }
  }
  return { pixels: used, range: fMin > 0 ? fMax / fMin : Infinity, coefficients: coef as [number[], number[], number[]] };
}

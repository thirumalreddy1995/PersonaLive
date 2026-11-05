/**
 * Realism review metrics (docs/REALISM_PLAN.md, "Metrics").
 *
 * Pure functions over RGBA pixel buffers and landmark arrays in the same pixel space, so they run
 * in Node for the capture tool and in the unit tests. Trends between runs matter more than the
 * absolute values.
 */
import { FACE_OVAL_RING, INNER_LIP_RING, LMK, OUTER_LIP_RING } from './landmarks.ts';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Landmark array in pixels: [x0, y0, x1, y1, ...] with 478 points. */
export type Landmarks = ArrayLike<number>;

export type Mask = Uint8Array;

// --- Geometry -------------------------------------------------------------------------------------

export function lm(points: Landmarks, index: number): Point {
  return { x: points[index * 2], y: points[index * 2 + 1] };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface FaceSize {
  width: number;
  height: number;
  center: Point;
  /** Unit vector pointing from the chin to the top of the forehead (follows head roll). */
  up: Point;
}

export function faceSize(points: Landmarks): FaceSize {
  const top = lm(points, LMK.TOP);
  const chin = lm(points, LMK.CHIN);
  const left = lm(points, LMK.LEFT_TEMPLE);
  const right = lm(points, LMK.RIGHT_TEMPLE);
  const height = Math.max(1, dist(top, chin));
  return {
    width: Math.max(1, dist(left, right)),
    height,
    center: { x: (top.x + chin.x) / 2, y: (top.y + chin.y) / 2 },
    up: { x: (top.x - chin.x) / height, y: (top.y - chin.y) / height },
  };
}

export function polygonFromRing(points: Landmarks, ring: ReadonlyArray<number>): Point[] {
  return ring.map((i) => lm(points, i));
}

export function polygonCentroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

export function scalePolygon(poly: Point[], factor: number, about: Point = polygonCentroid(poly)): Point[] {
  return poly.map((p) => ({ x: about.x + (p.x - about.x) * factor, y: about.y + (p.y - about.y) * factor }));
}

export function boundsOf(poly: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function expandRect(r: Rect, factorX: number, factorY = factorX): Rect {
  const w = r.w * factorX;
  const h = r.h * factorY;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

export function clampRect(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

// --- Masks ----------------------------------------------------------------------------------------

/** Even-odd scanline fill of a polygon into a 0/1 mask. */
export function rasterizePolygon(poly: Point[], width: number, height: number): Mask {
  const mask = new Uint8Array(width * height);
  if (poly.length < 3) return mask;
  const b = boundsOf(poly);
  const y0 = Math.max(0, Math.floor(b.y));
  const y1 = Math.min(height - 1, Math.ceil(b.y + b.h));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i];
      const c = poly[(i + 1) % n];
      if (a.y === c.y) continue;
      if (sy < Math.min(a.y, c.y) || sy >= Math.max(a.y, c.y)) continue;
      xs.push(a.x + ((sy - a.y) * (c.x - a.x)) / (c.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i] - 0.5));
      const xb = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = xa; x <= xb; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}

export function diskMask(center: Point, radius: number, width: number, height: number): Mask {
  const mask = new Uint8Array(width * height);
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(center.x - radius));
  const x1 = Math.min(width - 1, Math.ceil(center.x + radius));
  const y0 = Math.max(0, Math.floor(center.y - radius));
  const y1 = Math.min(height - 1, Math.ceil(center.y + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - center.x;
      const dy = y + 0.5 - center.y;
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** Pixels within `thickness/2` of the closed polyline. */
export function polylineMask(poly: Point[], width: number, height: number, thickness: number): Mask {
  const mask = new Uint8Array(width * height);
  const half = thickness / 2;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - half));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + half));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - half));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + half));
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - a.x;
        const py = y + 0.5 - a.y;
        const t = Math.max(0, Math.min(1, (px * vx + py * vy) / len2));
        const dx = px - t * vx;
        const dy = py - t * vy;
        if (dx * dx + dy * dy <= half * half) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

export function maskSubtract(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && !b[i] ? 1 : 0;
  return out;
}

export function maskCount(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

// --- Pixel statistics -----------------------------------------------------------------------------

export function luminance(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  }
  return out;
}

export function meanInMask(values: ArrayLike<number>, mask: Mask): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      s += values[i];
      n++;
    }
  }
  return n ? s / n : 0;
}

export function meanRgb(img: RgbaImage, mask: Mask): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const d = img.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    r += d[o];
    g += d[o + 1];
    b += d[o + 2];
    n++;
  }
  return n ? [r / n, g / n, b / n] : null;
}

/** Variance of the 4-neighbour Laplacian over mask pixels (image border excluded). */
export function laplacianVariance(lum: Float32Array, width: number, height: number, mask: Mask): number {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const v = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - width] - lum[i + width];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = s / n;
  return s2 / n - mean * mean;
}

/** Sobel gradient magnitude (border pixels are 0). */
export function sobelMagnitude(lum: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -lum[i - width - 1] + lum[i - width + 1] - 2 * lum[i - 1] + 2 * lum[i + 1] - lum[i + width - 1] + lum[i + width + 1];
      const gy =
        -lum[i - width - 1] - 2 * lum[i - width] - lum[i - width + 1] + lum[i + width - 1] + 2 * lum[i + width] + lum[i + width + 1];
      out[i] = Math.hypot(gx, gy);
    }
  }
  return out;
}

// --- Colour ---------------------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB (0..255) to CIE L*a*b* under D65. */
export function rgbToLab([r, g, b]: [number, number, number]): [number, number, number] {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005). */
export function ciede2000(lab1: [number, number, number], lab2: [number, number, number]): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const h = deg(Math.atan2(b, a));
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else {
    const sum = h1p + h2p;
    if (Math.abs(h1p - h2p) <= 180) hbp = sum / 2;
    else hbp = sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2;
  }
  const T =
    1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const RC = 2 * Math.sqrt(Cbp7 / (Cbp7 + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;
  const l = dLp / SL;
  const c = dCp / SC;
  const h = dHp / SH;
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}

export function deltaE(img1: RgbaImage, mask1: Mask, img2: RgbaImage, mask2: Mask): number | null {
  const a = meanRgb(img1, mask1);
  const b = meanRgb(img2, mask2);
  if (!a || !b) return null;
  return ciede2000(rgbToLab(a), rgbToLab(b));
}

// --- Face regions ---------------------------------------------------------------------------------

export interface FaceRegions {
  size: FaceSize;
  oval: Point[];
  ovalBox: Rect;
  /** Face interior (oval shrunk to 90%). */
  inside: Mask;
  /** Ring just outside the oval (105%..130%): hair, ears, collar. */
  outsideRing: Mask;
  /** 3 px band along the blend boundary (oval). */
  boundary: Mask;
  /** 3 px band along the 92% oval, i.e. just inside the boundary. */
  insideBand: Mask;
  cheekLeft: Mask;
  cheekRight: Mask;
  neck: Mask;
  earLeft: Mask;
  earRight: Mask;
  foreheadUpper: Mask;
  foreheadLower: Mask;
  /** Forehead rectangle between the brow line and landmark 10 (texture-slide region). */
  foreheadRect: Rect;
}

export function faceRegions(points: Landmarks, width: number, height: number): FaceRegions {
  const size = faceSize(points);
  const oval = polygonFromRing(points, FACE_OVAL_RING);
  const ovalBox = boundsOf(oval);
  const centroid = polygonCentroid(oval);
  const inside = rasterizePolygon(scalePolygon(oval, 0.9, centroid), width, height);
  const outsideRing = maskSubtract(
    rasterizePolygon(scalePolygon(oval, 1.3, centroid), width, height),
    rasterizePolygon(scalePolygon(oval, 1.05, centroid), width, height)
  );
  const boundary = polylineMask(oval, width, height, 3);
  const insideBand = polylineMask(scalePolygon(oval, 0.92, centroid), width, height, 3);

  const r = size.width * 0.05;
  const up = size.up;
  const outward = (from: number, to: number) => {
    const a = lm(points, from);
    const b = lm(points, to);
    const d = dist(a, b) || 1;
    return { x: (a.x - b.x) / d, y: (a.y - b.y) / d };
  };
  const chin = lm(points, LMK.CHIN);
  const neckCenter = { x: chin.x - up.x * size.height * 0.22, y: chin.y - up.y * size.height * 0.22 };
  const lt = lm(points, LMK.LEFT_TEMPLE);
  const rt = lm(points, LMK.RIGHT_TEMPLE);
  const ol = outward(LMK.LEFT_TEMPLE, LMK.RIGHT_TEMPLE);
  const or = outward(LMK.RIGHT_TEMPLE, LMK.LEFT_TEMPLE);
  const earOffset = size.width * 0.09;
  const top = lm(points, LMK.TOP);
  const glabella = lm(points, LMK.GLABELLA);
  const fore = { x: top.x - glabella.x, y: top.y - glabella.y };
  const foreheadLowerC = { x: glabella.x + fore.x * 0.6, y: glabella.y + fore.y * 0.6 };
  const foreheadUpperC = { x: top.x + fore.x * 0.55, y: top.y + fore.y * 0.55 };
  const fr = size.width * 0.045;

  const lx = lm(points, LMK.RIGHT_TEMPLE_UPPER).x;
  const rx = lm(points, LMK.LEFT_TEMPLE_UPPER).x;
  const fx0 = Math.min(lx, rx);
  const fx1 = Math.max(lx, rx);
  const fy0 = Math.min(top.y, glabella.y);
  const fy1 = Math.max(top.y, glabella.y);
  const foreheadRect = clampRect(
    { x: fx0 + (fx1 - fx0) * 0.1, y: fy0, w: (fx1 - fx0) * 0.8, h: Math.max(8, (fy1 - fy0) * 0.9) },
    width,
    height
  );

  return {
    size,
    oval,
    ovalBox,
    inside,
    outsideRing,
    boundary,
    insideBand,
    cheekLeft: diskMask(lm(points, LMK.LEFT_CHEEK), r, width, height),
    cheekRight: diskMask(lm(points, LMK.RIGHT_CHEEK), r, width, height),
    neck: diskMask(neckCenter, r, width, height),
    earLeft: diskMask({ x: lt.x + ol.x * earOffset, y: lt.y + ol.y * earOffset }, r * 0.7, width, height),
    earRight: diskMask({ x: rt.x + or.x * earOffset, y: rt.y + or.y * earOffset }, r * 0.7, width, height),
    foreheadUpper: diskMask(foreheadUpperC, fr, width, height),
    foreheadLower: diskMask(foreheadLowerC, fr, width, height),
    foreheadRect,
  };
}

// --- Metrics --------------------------------------------------------------------------------------

export interface SkinToneMatch {
  /** ΔE between the persona cheeks (output) and the wearer's neck (driver). */
  cheekVsNeck: number;
  /** ΔE between the persona cheeks (output) and the wearer's ears (driver), averaged. */
  cheekVsEars: number;
  /** Same cheek-vs-neck ΔE measured on the driver alone: the wearer's own natural difference. */
  driverCheekVsNeck: number;
}

export function skinToneMatch(output: RgbaImage, driver: RgbaImage, points: Landmarks): SkinToneMatch | null {
  const r = faceRegions(points, output.width, output.height);
  const cheekOut = meanRgb(output, orMask(r.cheekLeft, r.cheekRight));
  const cheekDrv = meanRgb(driver, orMask(r.cheekLeft, r.cheekRight));
  const neck = meanRgb(driver, r.neck);
  const earL = meanRgb(driver, r.earLeft);
  const earR = meanRgb(driver, r.earRight);
  if (!cheekOut || !cheekDrv || !neck) return null;
  const ears = [earL, earR].filter((e): e is [number, number, number] => !!e);
  const cheekLab = rgbToLab(cheekOut);
  const earDeltas = ears.map((e) => ciede2000(cheekLab, rgbToLab(e)));
  return {
    cheekVsNeck: ciede2000(cheekLab, rgbToLab(neck)),
    cheekVsEars: earDeltas.length ? earDeltas.reduce((a, b) => a + b, 0) / earDeltas.length : NaN,
    driverCheekVsNeck: ciede2000(rgbToLab(cheekDrv), rgbToLab(neck)),
  };
}

export function orMask(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

export interface SharpnessMatch {
  ratio: number;
  inside: number;
  outside: number;
}

/** Laplacian variance inside the face divided by the same in a ring just outside it. Target ≈ 1. */
export function sharpnessMatch(img: RgbaImage, points: Landmarks, lum = luminance(img)): SharpnessMatch {
  const r = faceRegions(points, img.width, img.height);
  const inside = laplacianVariance(lum, img.width, img.height, r.inside);
  const outside = laplacianVariance(lum, img.width, img.height, r.outsideRing);
  return { ratio: outside > 0 ? inside / outside : NaN, inside, outside };
}

export interface SeamScore {
  ratio: number;
  boundary: number;
  inside: number;
}

/** Mean gradient magnitude along the blend boundary over the same just inside it. Lower is better. */
export function seamScore(img: RgbaImage, points: Landmarks, lum = luminance(img)): SeamScore {
  const r = faceRegions(points, img.width, img.height);
  const grad = sobelMagnitude(lum, img.width, img.height);
  const boundary = meanInMask(grad, r.boundary);
  const inside = meanInMask(grad, r.insideBand);
  return { ratio: inside > 0 ? boundary / inside : NaN, boundary, inside };
}

export interface MouthFidelity {
  /** Mean lip-landmark error as a percentage of face width. */
  lipErrorPct: number;
  lipErrorPx: number;
  points: number;
}

/** Lip landmark error between the landmarks re-detected on the output and the driver's. */
export function mouthFidelity(outputLandmarks: Landmarks | null, driverLandmarks: Landmarks): MouthFidelity | null {
  if (!outputLandmarks) return null;
  const idx = [...OUTER_LIP_RING, ...INNER_LIP_RING];
  let s = 0;
  for (const i of idx) s += dist(lm(outputLandmarks, i), lm(driverLandmarks, i));
  const px = s / idx.length;
  const width = faceSize(driverLandmarks).width;
  return { lipErrorPct: (px / width) * 100, lipErrorPx: px, points: idx.length };
}

export interface ForeheadToneStep {
  output: number;
  driver: number;
  /** output − driver; a real forehead has no band, so this should approach 0. */
  delta: number;
}

export function foreheadToneStep(output: RgbaImage, driver: RgbaImage, points: Landmarks): ForeheadToneStep | null {
  const r = faceRegions(points, output.width, output.height);
  const o = deltaE(output, r.foreheadUpper, output, r.foreheadLower);
  const d = deltaE(driver, r.foreheadUpper, driver, r.foreheadLower);
  if (o === null || d === null) return null;
  return { output: o, driver: d, delta: o - d };
}

export interface BurstFrame {
  output: RgbaImage;
  driver: RgbaImage;
  landmarks: Landmarks;
}

export interface Flicker {
  output: number;
  driver: number;
  /** output − driver mean absolute luminance change per frame inside the face. */
  delta: number;
  pairs: number;
}

export function flicker(frames: BurstFrame[]): Flicker | null {
  if (frames.length < 2) return null;
  let out = 0;
  let drv = 0;
  let pairs = 0;
  let prevOut = luminance(frames[0].output);
  let prevDrv = luminance(frames[0].driver);
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    const w = f.output.width;
    const h = f.output.height;
    const mask = faceRegions(f.landmarks, w, h).inside;
    const curOut = luminance(f.output);
    const curDrv = luminance(f.driver);
    let so = 0;
    let sd = 0;
    let n = 0;
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      so += Math.abs(curOut[p] - prevOut[p]);
      sd += Math.abs(curDrv[p] - prevDrv[p]);
      n++;
    }
    if (n) {
      out += so / n;
      drv += sd / n;
      pairs++;
    }
    prevOut = curOut;
    prevDrv = curDrv;
  }
  if (!pairs) return null;
  return { output: out / pairs, driver: drv / pairs, delta: (out - drv) / pairs, pairs };
}

export interface Flow {
  dx: number;
  dy: number;
  /** Textured blocks that contributed. */
  blocks: number;
}

/**
 * Block-matching optical flow: for every `block`×`block` tile of `rect` in `prev` with enough
 * texture, the integer shift within ±`search` that best matches `next` (SAD). Returns the mean
 * shift and, via `perBlock`, each block's shift.
 */
export function blockMatchFlow(
  prev: Float32Array,
  next: Float32Array,
  width: number,
  height: number,
  rect: Rect,
  opts: { block?: number; search?: number; minTexture?: number; perBlock?: Flow[] } = {}
): Flow {
  const block = opts.block ?? 8;
  const search = opts.search ?? 8;
  const minTexture = opts.minTexture ?? 6;
  const r = clampRect(rect, width, height);
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let by = r.y; by + block <= r.y + r.h; by += block) {
    for (let bx = r.x; bx + block <= r.x + r.w; bx += block) {
      // Texture check: mean absolute gradient inside the block.
      let g = 0;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block - 1; x++) g += Math.abs(prev[y * width + x + 1] - prev[y * width + x]);
      }
      g /= block * (block - 1);
      if (g < minTexture) continue;
      let best = Infinity;
      let bdx = 0;
      let bdy = 0;
      for (let dy = -search; dy <= search; dy++) {
        if (by + dy < 0 || by + dy + block > height) continue;
        for (let dx = -search; dx <= search; dx++) {
          if (bx + dx < 0 || bx + dx + block > width) continue;
          let sad = 0;
          let y = 0;
          for (; y < block && sad < best; y++) {
            const pi = (by + y) * width + bx;
            const ni = (by + y + dy) * width + bx + dx;
            for (let x = 0; x < block; x++) sad += Math.abs(prev[pi + x] - next[ni + x]);
          }
          // An early exit leaves `sad` as a lower bound, so ties only count when fully summed.
          const complete = y === block;
          if (sad < best || (complete && sad === best && dx * dx + dy * dy < bdx * bdx + bdy * bdy)) {
            best = sad;
            bdx = dx;
            bdy = dy;
          }
        }
      }
      sx += bdx;
      sy += bdy;
      count++;
      opts.perBlock?.push({ dx: bdx, dy: bdy, blocks: 1 });
    }
  }
  return { dx: count ? sx / count : 0, dy: count ? sy / count : 0, blocks: count };
}

export interface TextureSlide {
  /** Mean |persona forehead block flow − wearer head flow| in px per frame. ~0 = texture moves with the head. */
  residualPx: number;
  pairs: number;
  blocks: number;
}

export function textureSlide(frames: BurstFrame[], opts: { search?: number } = {}): TextureSlide | null {
  if (frames.length < 2) return null;
  let residual = 0;
  let blocks = 0;
  let pairs = 0;
  let prevOut = luminance(frames[0].output);
  let prevDrv = luminance(frames[0].driver);
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    const w = f.output.width;
    const h = f.output.height;
    const regions = faceRegions(frames[i - 1].landmarks, w, h);
    const curOut = luminance(f.output);
    const curDrv = luminance(f.driver);
    // The wearer's head motion: flow over the whole face box on the driver frame.
    const head = blockMatchFlow(prevDrv, curDrv, w, h, regions.ovalBox, { search: opts.search });
    const perBlock: Flow[] = [];
    // Skin is smooth: accept weakly textured blocks on the forehead (camera noise still locks).
    blockMatchFlow(prevOut, curOut, w, h, regions.foreheadRect, { search: opts.search, minTexture: 2, perBlock });
    if (head.blocks && perBlock.length) {
      for (const b of perBlock) residual += Math.hypot(b.dx - head.dx, b.dy - head.dy);
      blocks += perBlock.length;
      pairs++;
    }
    prevOut = curOut;
    prevDrv = curDrv;
  }
  if (!blocks) return null;
  return { residualPx: residual / blocks, pairs, blocks };
}

/** Topmost row per column where the persona layer's alpha exceeds `threshold`; null where none. */
export function personaTopEdge(overlay: RgbaImage, x0: number, x1: number, threshold = 128): Array<number | null> {
  const out: Array<number | null> = [];
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(overlay.width, Math.ceil(x1));
  for (let x = xa; x < xb; x++) {
    let top: number | null = null;
    for (let y = 0; y < overlay.height; y++) {
      if (overlay.data[(y * overlay.width + x) * 4 + 3] >= threshold) {
        top = y;
        break;
      }
    }
    out.push(top);
  }
  return out;
}

export interface HairlineAlignment {
  meanPx: number;
  columns: number;
}

/** Mean |persona top edge − hair boundary| over columns where both exist (plan R4 supplies the hair mask). */
export function hairlineAlignment(personaEdge: Array<number | null>, hairEdge: Array<number | null>): HairlineAlignment | null {
  let s = 0;
  let n = 0;
  for (let i = 0; i < Math.min(personaEdge.length, hairEdge.length); i++) {
    const p = personaEdge[i];
    const h = hairEdge[i];
    if (p === null || h === null) continue;
    s += Math.abs(p - h);
    n++;
  }
  return n ? { meanPx: s / n, columns: n } : null;
}

/** Mean absolute frame-to-frame change of a per-frame scalar series (e.g. mean edge position). */
export function jitter(series: number[]): number {
  if (series.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < series.length; i++) s += Math.abs(series[i] - series[i - 1]);
  return s / (series.length - 1);
}

export function meanOf(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

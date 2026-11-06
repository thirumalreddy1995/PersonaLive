/**
 * Auto-radius loop (R3c item 1, flag autoRadius).
 *
 * The relight low-pass radius trades identity (large radius keeps more of the persona's own
 * shading) against lighting fidelity (the persona photo's light leaks). Each persona starts at
 * AUTO_RADIUS_MIN and the radius is raised toward AUTO_RADIUS_MAX while the output's measured
 * side-shading gap and cheek-vs-neck gap stay close to the wearer's own, and lowered when they
 * drift away. The measurements come from the same asynchronous readbacks as the camera match;
 * the loop is hysteresis-smoothed so the radius never pumps.
 *
 * Pure module: readback-pixel sampling, Lab patch means and the control step.
 */
import { ciede2000, rgbToLab, type Lab } from './color.ts';

export const AUTO_RADIUS_MIN = 0.02;
export const AUTO_RADIUS_MAX = 0.08;
/** Raise the radius while both smoothed excesses are below this (L for the side gap, ΔE for the neck gap). */
export const AUTO_RADIUS_RAISE_BELOW = 1.5;
/** Lower it once either smoothed excess is above this; between the two nothing moves (hysteresis). */
export const AUTO_RADIUS_LOWER_ABOVE = 2.5;
export const AUTO_RADIUS_STEP_UP = 0.002;
export const AUTO_RADIUS_STEP_DOWN = 0.004;
/** EMA weight of each new measurement. */
export const AUTO_RADIUS_EMA = 0.25;
/** Readbacks for the loop are issued every this many frames. */
export const AUTO_RADIUS_EVERY = 15;
/** Patch radius as a share of face width and the neck patch's offset below the chin as a share of face height. */
export const PATCH_RADIUS_SHARE = 0.05;
export const NECK_OFFSET_SHARE = 0.22;

export interface AutoRadiusState {
  radius: number;
  /** Smoothed |side gap(output) − side gap(wearer)| in L; null until the first measurement. */
  sideExcess: number | null;
  /** Smoothed |cheek-vs-neck ΔE(output) − ΔE(wearer)|. */
  neckExcess: number | null;
  updates: number;
}

export function initialAutoRadius(radius = AUTO_RADIUS_MIN): AutoRadiusState {
  return { radius, sideExcess: null, neckExcess: null, updates: 0 };
}

export interface ShadingSample {
  /** Left-cheek minus right-cheek lightness (L) on the output and on the wearer. */
  sideOut: number;
  sideDrv: number;
  /** Cheek-vs-neck ΔE on the output and on the wearer. */
  neckOut: number;
  neckDrv: number;
}

/** One control step; `hold` records the measurement without moving the radius (fast head motion). */
export function stepAutoRadius(s: AutoRadiusState, m: ShadingSample, opts: { hold?: boolean } = {}): AutoRadiusState {
  const ema = (prev: number | null, v: number) => (prev === null ? v : prev + (v - prev) * AUTO_RADIUS_EMA);
  const sideExcess = ema(s.sideExcess, Math.abs(m.sideOut - m.sideDrv));
  const neckExcess = ema(s.neckExcess, Math.abs(m.neckOut - m.neckDrv));
  let radius = s.radius;
  if (!opts.hold) {
    const worst = Math.max(sideExcess, neckExcess);
    if (worst < AUTO_RADIUS_RAISE_BELOW) radius = Math.min(AUTO_RADIUS_MAX, radius + AUTO_RADIUS_STEP_UP);
    else if (worst > AUTO_RADIUS_LOWER_ABOVE) radius = Math.max(AUTO_RADIUS_MIN, radius - AUTO_RADIUS_STEP_DOWN);
  }
  return { radius, sideExcess, neckExcess, updates: s.updates + 1 };
}

/**
 * How a readback window maps display pixels to its READBACK_SIZE² pixel grid.
 * `x0,y0,w,h` is the display-space rectangle the window covers; `flipY` when row 0 of the data is
 * the bottom of that rectangle (GL default-framebuffer copies); `mirrorX` when the data's x runs
 * opposite to the display's (the driver frame is shown mirrored).
 */
export interface ReadbackMapping {
  x0: number;
  y0: number;
  w: number;
  h: number;
  size: number;
  flipY: boolean;
  mirrorX: boolean;
}

export function toReadback(m: ReadbackMapping, x: number, y: number): { px: number; py: number } {
  let u = (x - m.x0) / m.w;
  let v = (y - m.y0) / m.h;
  if (m.mirrorX) u = 1 - u;
  if (m.flipY) v = 1 - v;
  return { px: u * m.size, py: v * m.size };
}

export interface PatchMean {
  /** Mean RGB (0..255) as stored: premultiplied by alpha on the persona layer. */
  rgb: [number, number, number];
  /** Mean alpha 0..1. */
  alpha: number;
  n: number;
}

/** Mean RGBA over a disk of the readback data (all pixels, premultiplied as stored); null when the disk is off the window. */
export function patchMean(data: ArrayLike<number>, size: number, cx: number, cy: number, r: number): PatchMean | null {
  let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      const p = (y * size + x) * 4;
      sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; sa += data[p + 3]; n++;
    }
  }
  if (n < 4) return null;
  return { rgb: [sr / n, sg / n, sb / n], alpha: sa / (255 * n), n };
}

/** Mean Lab of the opaque pixels in a disk of the readback data; null when none. */
export function patchMeanLab(data: ArrayLike<number>, size: number, cx: number, cy: number, r: number, minAlpha = 200): Lab | null {
  let sr = 0, sg = 0, sb = 0, n = 0;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      const p = (y * size + x) * 4;
      if (data[p + 3] < minAlpha) continue;
      sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; n++;
    }
  }
  if (n < 4) return null;
  return rgbToLab([sr / n, sg / n, sb / n]);
}

/**
 * Lab of a persona-layer patch composited over the driver at the same display position:
 * premultiplied layer colour + driver colour × (1 − alpha), which is what the output canvas shows.
 * Where the layer is transparent (the neck) this is simply the driver.
 */
export function compositedPatchLab(layer: ArrayLike<number>, layerMap: ReadbackMapping, under: ArrayLike<number>, underMap: ReadbackMapping, x: number, y: number, radiusPx: number): Lab | null {
  const l = toReadback(layerMap, x, y);
  const u = toReadback(underMap, x, y);
  const L = patchMean(layer, layerMap.size, l.px, l.py, (radiusPx / layerMap.w) * layerMap.size);
  const U = patchMean(under, underMap.size, u.px, u.py, (radiusPx / underMap.w) * underMap.size);
  if (!L || !U) return null;
  const k = 1 - L.alpha;
  return rgbToLab([L.rgb[0] + U.rgb[0] * k, L.rgb[1] + U.rgb[1] * k, L.rgb[2] + U.rgb[2] * k]);
}

export interface ShadingPatches {
  left: { x: number; y: number };
  right: { x: number; y: number };
  neck: { x: number; y: number };
  radius: number;
}

/** Cheek and neck patch centres in display pixels from the smoothed landmarks (468 × 2). */
export function shadingPatches(points: ArrayLike<number>, faceWidth: number, faceHeight: number, leftCheek = 280, rightCheek = 50, chin = 152): ShadingPatches {
  return {
    left: { x: points[leftCheek * 2], y: points[leftCheek * 2 + 1] },
    right: { x: points[rightCheek * 2], y: points[rightCheek * 2 + 1] },
    neck: { x: points[chin * 2], y: points[chin * 2 + 1] + NECK_OFFSET_SHARE * faceHeight },
    radius: PATCH_RADIUS_SHARE * faceWidth,
  };
}

export interface ShadingMeasure {
  /** Left minus right cheek L. */
  side: number;
  /** Cheek (mean of both) vs neck ΔE; null when the neck patch was not readable (outside the window or transparent). */
  neck: number | null;
  cheek: Lab;
}

/**
 * Samples the three patches on one readback. With `under` (the driver readback) the data is the
 * persona layer and every patch is composited over the driver first, so the measurement matches
 * the output canvas; without it the data is opaque (the driver). Null when a cheek is unreadable.
 */
export function measureShading(data: ArrayLike<number>, mapping: ReadbackMapping, patches: ShadingPatches, under?: { data: ArrayLike<number>; mapping: ReadbackMapping }): ShadingMeasure | null {
  const sample = (x: number, y: number): Lab | null => {
    if (under) return compositedPatchLab(data, mapping, under.data, under.mapping, x, y, patches.radius);
    const p = toReadback(mapping, x, y);
    return patchMeanLab(data, mapping.size, p.px, p.py, (patches.radius / mapping.w) * mapping.size);
  };
  const L = sample(patches.left.x, patches.left.y);
  const R = sample(patches.right.x, patches.right.y);
  if (!L || !R) return null;
  const cheek: Lab = [(L[0] + R[0]) / 2, (L[1] + R[1]) / 2, (L[2] + R[2]) / 2];
  const N = sample(patches.neck.x, patches.neck.y);
  return { side: L[0] - R[0], neck: N ? ciede2000(cheek, N) : null, cheek };
}

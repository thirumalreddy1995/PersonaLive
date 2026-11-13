/**
 * R6b (flag photoLighting): adaptive lighting normalisation of a persona photo at load, and the
 * per-frame skin-tone budget of the illumination relight.
 *
 * The illumination relight keeps the persona's own colours and only moves the light, so whatever
 * light is baked into the photo stays unless it is removed first. At load:
 *
 * 1. A smooth shading field (2nd order per RGB channel, linear light) is fitted over the photo's face
 *    skin, rejecting beard, hair and glare by brightness (as the R3b de-light does).
 * 2. A mirror map (face midline, from the mesh's symmetric landmark pairs, so a turned photo is
 *    mirrored anatomically) compares the field with itself across the face. Lighting from one side
 *    and coloured fill light are asymmetric; beard, brows, make-up and the face's own form are
 *    mostly symmetric. The mean mirror difference (ΔE) is the photo's lighting asymmetry.
 * 3. Only the asymmetric part is divided out: gain = sqrt(field(mirror) / field) per channel, raised
 *    to a per-photo strength that is 0 for an evenly lit photo (it stays untouched) and 1 for a
 *    harshly side-lit one.
 *
 * The mean skin colour also gives a colour-cast score (hue far from natural skin, or oversaturated),
 * which raises that persona's hue match. `toneBudgetFloor` is the per-frame guard: the smallest
 * tone-match exponent that keeps the face's mean skin within a ΔE00 budget of the wearer's.
 *
 * Pure module (no DOM): RGBA byte arrays and landmark pixel positions.
 */
import { ciede2000, type Lab } from './color.ts';
import { mirrorPairs } from './faceSymmetry.ts';
import { skinMaskForDelight, solveLinear } from './personaDelight.ts';

/** Mean mirror asymmetry (CIE76 ΔE of the fitted field) below which a photo is left untouched. */
export const LIGHT_ASYM_START = 4;
/** Asymmetry at which the symmetrising correction is applied in full. */
export const LIGHT_ASYM_FULL = 10;
/** The symmetrising correction fades between these multiples of the face-oval radius. */
export const LIGHT_FADE: readonly [number, number] = [0.7, 1.3];
/** Per-channel limit of the symmetrising gain (the field is never trusted beyond a 2× swing). */
export const LIGHT_GAIN_MAX = 2;
/** Natural skin hue (CIE Lab hue angle, degrees) and the deviation band that counts as a colour cast. */
export const SKIN_HUE_CENTRE = 54;
export const SKIN_HUE_CAST: readonly [number, number] = [10, 20];
/** Skin chroma band that counts as an oversaturated (coloured-light) cast. */
export const SKIN_CHROMA_CAST: readonly [number, number] = [30, 42];
/** Default face-to-wearer mean skin difference allowed by the tone budget (CIEDE2000). */
export const TONE_BUDGET_DEFAULT = 2.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** CIE Lab (D65) of a linear-light RGB colour in 0..1 (the shader's pow-2.2 space). */
export function linearToLab(c: readonly number[]): Lab {
  const R = Math.max(0, c[0]);
  const G = Math.max(0, c[1]);
  const B = Math.max(0, c[2]);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DECODE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = Math.pow(i / 255, 2.2);
  return t;
})();
const ENCODE_STEPS = 4096;
const ENCODE = (() => {
  const t = new Uint8Array(ENCODE_STEPS + 1);
  for (let i = 0; i <= ENCODE_STEPS; i++) t[i] = Math.round(Math.pow(i / ENCODE_STEPS, 1 / 2.2) * 255);
  return t;
})();
const encode = (v: number) => ENCODE[Math.round(clamp(v, 0, 1) * ENCODE_STEPS)];

/** A 2nd-order field per channel in oval-normalised coordinates u = (x − cx) / ax, v = (y − cy) / ay. */
export interface ShadingFit {
  coef: [number[], number[], number[]];
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  /** Inlier sample positions (u, v interleaved). */
  samples: Float32Array;
  /** Mean linear colour of the inlier skin pixels. */
  mean: [number, number, number];
}

const basis = (u: number, v: number) => [1, u, v, u * u, u * v, v * v];
const poly = (c: readonly number[], u: number, v: number) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;

/** The fitted field's linear colour at (u, v). */
export function fieldAt(fit: Pick<ShadingFit, 'coef'>, u: number, v: number): [number, number, number] {
  return [poly(fit.coef[0], u, v), poly(fit.coef[1], u, v), poly(fit.coef[2], u, v)];
}

/** Least squares of the 6-term quadratic basis: one solve per right-hand side. */
function fitQuadratic(us: ArrayLike<number>, vs: ArrayLike<number>, rhs: ArrayLike<number>[]): number[][] | null {
  const ata = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  const atb = rhs.map(() => new Array<number>(6).fill(0));
  for (let s = 0; s < us.length; s++) {
    const b = basis(us[s], vs[s]);
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) ata[r][c] += b[r] * b[c];
      for (let k = 0; k < rhs.length; k++) atb[k][r] += b[r] * rhs[k][s];
    }
  }
  const out: number[][] = [];
  for (const b of atb) {
    const x = solveLinear(ata.map((row) => [...row]), b);
    if (!x || x.some((n) => !Number.isFinite(n))) return null;
    out.push(x);
  }
  return out;
}

/**
 * Fits the photo's smooth skin shading: face oval minus eyes, brows and lips, every k-th pixel
 * (≤ ~40k samples), outliers by brightness (beard, hair, glare: below 0.3× or above 3× the median).
 */
export function fitShading(data: ArrayLike<number>, width: number, height: number, points: ArrayLike<number>): ShadingFit | null {
  const { mask, cx, cy, ax, ay } = skinMaskForDelight(points, width, height);
  let total = 0;
  for (let i = 0; i < mask.length; i++) total += mask[i];
  if (total < 500) return null;
  const stride = Math.max(1, Math.floor(total / 40000));
  const idx: number[] = [];
  const lum: number[] = [];
  let seen = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen++ % stride) continue;
    const p = i * 4;
    idx.push(i);
    lum.push(0.2126 * DECODE[data[p]] + 0.7152 * DECODE[data[p + 1]] + 0.0722 * DECODE[data[p + 2]]);
  }
  const sorted = [...lum].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const us: number[] = [];
  const vs: number[] = [];
  const ch: [number[], number[], number[]] = [[], [], []];
  const mean: [number, number, number] = [0, 0, 0];
  for (let s = 0; s < idx.length; s++) {
    if (lum[s] < median * 0.3 || lum[s] > median * 3) continue;
    const i = idx[s];
    const p = i * 4;
    us.push(((i % width) + 0.5 - cx) / ax);
    vs.push((Math.floor(i / width) + 0.5 - cy) / ay);
    for (let c = 0; c < 3; c++) {
      const value = DECODE[data[p + c]];
      ch[c].push(value);
      mean[c] += value;
    }
  }
  if (us.length < 300) return null;
  const coef = fitQuadratic(us, vs, ch);
  if (!coef) return null;
  const samples = new Float32Array(us.length * 2);
  for (let s = 0; s < us.length; s++) {
    samples[s * 2] = us[s];
    samples[s * 2 + 1] = vs[s];
  }
  return { coef: coef as [number[], number[], number[]], cx, cy, ax, ay, samples, mean: [mean[0] / us.length, mean[1] / us.length, mean[2] / us.length] };
}

/**
 * A quadratic map from a face point to its mirror image across the midline, in the fit's
 * normalised coordinates, fitted on the landmarks and their canonical mirror pairs (so a turned
 * face is mirrored anatomically, not about a vertical line). Null when the landmarks are degenerate.
 */
export function mirrorMap(points: ArrayLike<number>, frame: Pick<ShadingFit, 'cx' | 'cy' | 'ax' | 'ay'>, count = 468): [number[], number[]] | null {
  const pairs = mirrorPairs();
  const n = Math.min(count, pairs.length, Math.floor(points.length / 2));
  const us = new Float64Array(n);
  const vs = new Float64Array(n);
  const mu = new Float64Array(n);
  const mv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = pairs[i];
    us[i] = (points[i * 2] - frame.cx) / frame.ax;
    vs[i] = (points[i * 2 + 1] - frame.cy) / frame.ay;
    mu[i] = (points[j * 2] - frame.cx) / frame.ax;
    mv[i] = (points[j * 2 + 1] - frame.cy) / frame.ay;
  }
  const m = fitQuadratic(us, vs, [mu, mv]);
  return m ? [m[0], m[1]] : null;
}

export interface LightingAssessment {
  /** Mean mirror ΔE (CIE76) of the fitted field over the cheeks, forehead and jaw. */
  asymmetry: number;
  /** Its lightness and chroma parts. */
  asymmetryL: number;
  asymmetryAb: number;
  /** Mean skin colour (Lab), its hue angle (degrees) and chroma. */
  lab: Lab;
  hue: number;
  chroma: number;
  /** 0..1 strength of the symmetrising correction (lightingStrength of the asymmetry). */
  strength: number;
  /** 0..1 colour-cast score (castStrength of the mean skin colour). */
  cast: number;
}

/** 0 for an evenly lit photo, 1 for a harshly side-lit one. */
export function lightingStrength(asymmetry: number): number {
  return smoothstep(LIGHT_ASYM_START, LIGHT_ASYM_FULL, asymmetry);
}

/** 0 for natural skin, up to 1 for a hue far from skin (green, magenta, deep red) or oversaturated light. */
export function castStrength(lab: Lab): number {
  const chroma = Math.hypot(lab[1], lab[2]);
  if (chroma < 4) return 0;
  const hue = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  let dh = Math.abs(hue - SKIN_HUE_CENTRE) % 360;
  if (dh > 180) dh = 360 - dh;
  return Math.max(smoothstep(SKIN_CHROMA_CAST[0], SKIN_CHROMA_CAST[1], chroma), smoothstep(SKIN_HUE_CAST[0], SKIN_HUE_CAST[1], dh));
}

/** Measures the field's mirror asymmetry (points off the midline whose mirror lies inside the oval). */
export function assessLighting(fit: ShadingFit, map: [number[], number[]]): LightingAssessment {
  let sum = 0;
  let sumL = 0;
  let sumAb = 0;
  let n = 0;
  for (let s = 0; s < fit.samples.length; s += 2) {
    const u = fit.samples[s];
    const v = fit.samples[s + 1];
    if (Math.abs(u) < 0.15) continue;
    const mu = poly(map[0], u, v);
    const mv = poly(map[1], u, v);
    if (mu * mu + mv * mv > 1.1 || Math.abs(mu) < 0.1) continue;
    const a = linearToLab(fieldAt(fit, u, v).map((x) => Math.max(1e-4, x)));
    const b = linearToLab(fieldAt(fit, mu, mv).map((x) => Math.max(1e-4, x)));
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    sumL += Math.abs(a[0] - b[0]);
    sumAb += Math.hypot(a[1] - b[1], a[2] - b[2]);
    n++;
  }
  const asymmetry = n ? sum / n : 0;
  const lab = linearToLab(fit.mean);
  return {
    asymmetry,
    asymmetryL: n ? sumL / n : 0,
    asymmetryAb: n ? sumAb / n : 0,
    lab,
    hue: (Math.atan2(lab[2], lab[1]) * 180) / Math.PI,
    chroma: Math.hypot(lab[1], lab[2]),
    strength: lightingStrength(asymmetry),
    cast: castStrength(lab),
  };
}

/**
 * Divides the asymmetric part of the photo's lighting out of `data` in place, with the per-photo
 * strength, fading out toward the face oval (LIGHT_FADE). Returns the assessment (the image
 * is untouched when the strength is ~0), or null when the face could not be fitted.
 */
export function normalizePhotoLighting(data: Uint8ClampedArray | Uint8Array, width: number, height: number, points: ArrayLike<number>): LightingAssessment | null {
  const fit = fitShading(data, width, height, points);
  if (!fit) return null;
  const map = mirrorMap(points, fit);
  if (!map) return null;
  const a = assessLighting(fit, map);
  const s = a.strength;
  if (s < 0.01) return a;
  const { cx, cy, ax, ay } = fit;
  const lnMax = Math.log(LIGHT_GAIN_MAX);
  const x0 = Math.max(0, Math.floor(cx - ax * LIGHT_FADE[1]));
  const x1 = Math.min(width - 1, Math.ceil(cx + ax * LIGHT_FADE[1]));
  const y0 = Math.max(0, Math.floor(cy - ay * LIGHT_FADE[1]));
  const y1 = Math.min(height - 1, Math.ceil(cy + ay * LIGHT_FADE[1]));
  for (let y = y0; y <= y1; y++) {
    const v = (y + 0.5 - cy) / ay;
    for (let x = x0; x <= x1; x++) {
      const u = (x + 0.5 - cx) / ax;
      const r = Math.sqrt(u * u + v * v);
      if (r >= LIGHT_FADE[1]) continue;
      // Full over the face, half at the oval (the relight matches the boundary to the wearer, and the
      // fitted field is least certain there), none from 1.3× the oval out.
      const w = 1 - smoothstep(LIGHT_FADE[0], LIGHT_FADE[1], r);
      const mu = poly(map[0], u, v);
      const mv = poly(map[1], u, v);
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const f = Math.max(1e-4, poly(fit.coef[c], u, v));
        const fm = Math.max(1e-4, poly(fit.coef[c], mu, mv));
        // sqrt(fm / f)^s, limited to ±ln 2, faded out beyond the oval.
        const lg = clamp(0.5 * (Math.log(fm) - Math.log(f)), -lnMax, lnMax) * s * w;
        data[p + c] = encode(DECODE[data[p + c]] * Math.exp(lg));
      }
    }
  }
  return a;
}

/**
 * The local half of the tone budget: the largest log-ratio per channel (linear light) by which the
 * persona's large-scale skin colour may differ from the wearer's at the same place. Around skin
 * lightness (L* 40..70) one unit of log luma is ~(L* + 16) / 3 ≈ 22 L*, ~21 ΔE00, so budget / 25
 * keeps a pure brightness difference at ~0.85 × the budget in ΔE00. 0 = off.
 */
export function toneClampFor(budget: number): number {
  return budget > 0 ? budget / 25 : 0;
}

/**
 * The tone budget: the smallest exponent floor f (0..1) on the illumination relight's brightness
 * and hue matches at the face centre (base exponents `lumaBase`, `hueBase`) for which the face's
 * mean skin, persona · (wearer / persona)^max(base, f) per part, lies within `budget` (CIEDE2000)
 * of the wearer's mean skin. 0 when the budget is off or already met. Ratios are clamped like the
 * shader's (0.25..4).
 */
export function toneBudgetFloor(persona: readonly number[], wearer: readonly number[], budget: number, lumaBase: number, hueBase: number): number {
  if (!(budget > 0)) return 0;
  const luma = (c: readonly number[]) => Math.max(0.002, 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
  const lp = luma(persona);
  const lw = luma(wearer);
  const lr = clamp(lw / lp, 0.25, 4);
  const cr = [0, 1, 2].map((i) => clamp(Math.max(0.002, wearer[i]) / lw / Math.max(0.002, persona[i] / lp), 0.25, 4));
  const target = linearToLab(wearer);
  const gap = (f: number) => {
    const eL = Math.max(lumaBase, f);
    const eC = Math.max(hueBase, f);
    const out = [0, 1, 2].map((i) => persona[i] * Math.pow(lr, eL) * Math.pow(cr[i], eC));
    return ciede2000(linearToLab(out), target);
  };
  if (gap(0) <= budget) return 0;
  if (gap(1) > budget) return 1;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 14; it++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) <= budget) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * R6b (identity): the pure parts of three mesh changes that keep more of the persona on the wearer.
 *
 * - Proportions (flag personaProportions): the persona's interior feature layout (nose, mouth and,
 *   when the persona's own eyes are drawn, the eye spacing) relative to the eyes, transferred onto
 *   the wearer's tracked mesh. The outer face oval stays on the wearer's landmarks.
 * - Jaw extension (flag jawExtension): where the persona photo has a beard below the jaw line, the
 *   lower face rings are pushed outward (in screen space and in the persona UVs alike), so the
 *   beard is drawn over the wearer's jaw instead of ending at the face oval.
 * - Eyelid pass-through (flag lidPassThrough): as the wearer's lids lower (blink or downward gaze)
 *   the eye pass-through widens over the upper lid, so the persona's open-eye lid crease does not
 *   stay as a pale arc above the wearer's lowered lid.
 *
 * Pure (no DOM), so the tests can run it.
 */
import { CANONICAL_FACE_MODEL } from './canonicalFaceModel.ts';
import { eyeFadeWeights, type FaceTopology } from './faceMesh.ts';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Hermite step from e0 to e1 (0 below e0, 1 above e1), like GLSL smoothstep. */
export const smoothstep = smooth;

/** Mesh vertices (the 478 tracked points include 10 iris points that are not part of the surface). */
export const MESH_POINTS = 468;
const NOSE_TIP = 1;

// ------------------------------------------------------------------------------------------------
// Eye frame: a subject-centred frame (origin between the eyes, x from the subject's right eye to
// the left one, y toward the chin, unit = inter-ocular distance). It is the same for a mirrored and
// an un-mirrored image of the same face, so the persona photo and the mirrored camera compare.
// ------------------------------------------------------------------------------------------------

export interface EyeFrame {
  ox: number;
  oy: number;
  /** Unit x axis (subject's right eye → left eye). */
  ux: number;
  uy: number;
  /** Unit y axis (toward the chin). */
  vx: number;
  vy: number;
  /** Inter-ocular distance (eye centre to eye centre). */
  iod: number;
}

export function eyeFrame(p: ArrayLike<number>): EyeFrame | null {
  const rx = (p[33 * 2] + p[133 * 2]) / 2;
  const ry = (p[33 * 2 + 1] + p[133 * 2 + 1]) / 2;
  const lx = (p[362 * 2] + p[263 * 2]) / 2;
  const ly = (p[362 * 2 + 1] + p[263 * 2 + 1]) / 2;
  const dx = lx - rx;
  const dy = ly - ry;
  const iod = Math.hypot(dx, dy);
  if (!(iod > 1e-6)) return null;
  const ux = dx / iod;
  const uy = dy / iod;
  const ox = (rx + lx) / 2;
  const oy = (ry + ly) / 2;
  // The y axis is the perpendicular that points toward the nose tip (a mirror flips the other one).
  let vx = -uy;
  let vy = ux;
  if ((p[NOSE_TIP * 2] - ox) * vx + (p[NOSE_TIP * 2 + 1] - oy) * vy < 0) {
    vx = -vx;
    vy = -vy;
  }
  return { ox, oy, ux, uy, vx, vy, iod };
}

/** The first `count` points in the eye frame (IOD units). Null when the eyes are degenerate. */
export function normalizeShape(p: ArrayLike<number>, count = MESH_POINTS, out?: Float32Array): Float32Array | null {
  const f = eyeFrame(p);
  if (!f) return null;
  const o = out && out.length >= count * 2 ? out : new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = p[i * 2] - f.ox;
    const y = p[i * 2 + 1] - f.oy;
    o[i * 2] = (x * f.ux + y * f.uy) / f.iod;
    o[i * 2 + 1] = (x * f.vx + y * f.vy) / f.iod;
  }
  return o;
}

/**
 * Points that move little with expression (eye corners, nose bridge and tip, forehead, temples,
 * cheekbones at the ears): the per-frame affine from the wearer's neutral shape to the current
 * landmarks is fitted on them, so it carries head pose, scale and foreshortening, not expression.
 */
export const STABLE_POINTS: ReadonlyArray<number> = [33, 133, 362, 263, 168, 6, 197, 195, 5, 4, 10, 151, 9, 21, 251, 127, 356, 234, 454];

/** Least-squares 2D affine dst ≈ [a b; c d]·src + [tx ty] over the points `idx`: [a, b, c, d, tx, ty]. */
export function fitAffine(src: ArrayLike<number>, dst: ArrayLike<number>, idx: ReadonlyArray<number>): [number, number, number, number, number, number] | null {
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0;
  let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
  const n = idx.length;
  for (const i of idx) {
    const x = src[i * 2];
    const y = src[i * 2 + 1];
    const X = dst[i * 2];
    const Y = dst[i * 2 + 1];
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    bx0 += x * X; bx1 += y * X; bx2 += X;
    by0 += x * Y; by1 += y * Y; by2 += Y;
  }
  // Normal equations M·[a b tx] = bx with M = [[sxx sxy sx] [sxy syy sy] [sx sy n]].
  const m = [sxx, sxy, sx, sxy, syy, sy, sx, sy, n];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (!(Math.abs(det) > 1e-12)) return null;
  const solve = (b0: number, b1: number, b2: number): [number, number, number] => {
    const d0 = b0 * (m[4] * m[8] - m[5] * m[7]) - m[1] * (b1 * m[8] - m[5] * b2) + m[2] * (b1 * m[7] - m[4] * b2);
    const d1 = m[0] * (b1 * m[8] - m[5] * b2) - b0 * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * b2 - b1 * m[6]);
    const d2 = m[0] * (m[4] * b2 - b1 * m[7]) - m[1] * (m[3] * b2 - b1 * m[6]) + b0 * (m[3] * m[7] - m[4] * m[6]);
    return [d0 / det, d1 / det, d2 / det];
  };
  const [a, b, tx] = solve(bx0, bx1, bx2);
  const [c, d, ty] = solve(by0, by1, by2);
  return [a, b, c, d, tx, ty];
}

/**
 * The wearer's neutral shape in the eye frame: a running mean of frontal frames with a relaxed
 * face (the engine decides which frames qualify). Ready after `minSamples`; after `window`
 * samples it becomes an EMA so a long session follows slow changes (posture, camera height).
 */
export class NeutralShapeCalibrator {
  private mean: Float64Array;
  private n = 0;
  constructor(readonly minSamples = 12, readonly window = 60, readonly count = MESH_POINTS) {
    this.mean = new Float64Array(count * 2);
  }

  add(normalized: ArrayLike<number>) {
    this.n++;
    const w = 1 / Math.min(this.n, this.window);
    for (let i = 0; i < this.count * 2; i++) this.mean[i] += (normalized[i] - this.mean[i]) * w;
  }

  get samples(): number {
    return this.n;
  }

  get ready(): boolean {
    return this.n >= this.minSamples;
  }

  shape(out?: Float32Array): Float32Array | null {
    if (!this.ready) return null;
    const o = out && out.length >= this.count * 2 ? out : new Float32Array(this.count * 2);
    for (let i = 0; i < this.count * 2; i++) o[i] = this.mean[i];
    return o;
  }

  reset() {
    this.n = 0;
    this.mean.fill(0);
  }
}

/** Largest proportion shift (IOD units) any vertex takes: keeps a very different face from tearing the mesh. */
export const PROPORTION_MAX_SHIFT = 0.12;

/** persona − wearer per vertex in the eye frame, each vector clamped to `maxShift`. */
export function proportionOffsets(persona: ArrayLike<number>, wearer: ArrayLike<number>, count = MESH_POINTS, maxShift = PROPORTION_MAX_SHIFT, out?: Float32Array): Float32Array {
  const o = out && out.length >= count * 2 ? out : new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    let dx = persona[i * 2] - wearer[i * 2];
    let dy = persona[i * 2 + 1] - wearer[i * 2 + 1];
    const len = Math.hypot(dx, dy);
    if (len > maxShift) {
      dx *= maxShift / len;
      dy *= maxShift / len;
    }
    o[i * 2] = dx;
    o[i * 2 + 1] = dy;
  }
  return o;
}

/**
 * Per-vertex strength of the proportion transfer: 0 on the face oval and the ring inside it,
 * rising to 1 four rings in, so the outline stays on the wearer. With the wearer's real eyes
 * showing, the eye rings and the ring around them stay too (the pass-through must sit on the real eye).
 */
export function proportionWeights(topology: FaceTopology, realEyes: boolean): Float32Array {
  const n = Math.min(topology.vertexCount, MESH_POINTS);
  const out = new Float32Array(topology.vertexCount);
  for (let v = 0; v < n; v++) {
    const d = topology.ovalRingDistance[v];
    let w = d < 0 ? 1 : smooth(1, 4, d);
    if (realEyes) {
      const e = topology.eyeRingDistance[v];
      if (e >= 0) w *= smooth(1, 3, e);
    }
    // The inner lip ring borders the mouth hole, through which the camera shows the real mouth: it
    // stays on the wearer, the outer lip contour moves half way, the skin around it fully.
    const z = topology.lipZones[v];
    if (z < 2) w *= z <= 0 ? 0 : 0.5 * z;
    out[v] = w;
  }
  return out;
}

/**
 * Adds the proportion offsets to `positions` (screen pixels): offset · weight · strength, mapped by
 * the linear part [a b; c d] of the eye-frame → screen affine. The lip band returns to the wearer's
 * positions as the real mouth opens (`lipFade`), so the pass-through stays on the real lips.
 */
export function applyProportions(
  positions: Float32Array,
  offsets: ArrayLike<number>,
  weights: ArrayLike<number>,
  lipWeights: ArrayLike<number>,
  lipFade: number,
  linear: readonly [number, number, number, number],
  strength: number,
  count = MESH_POINTS
) {
  const [a, b, c, d] = linear;
  const s = clamp(strength, 0, 1);
  if (s <= 0) return;
  for (let v = 0; v < count; v++) {
    const w = s * weights[v] * (1 - clamp(lipFade, 0, 1) * clamp(lipWeights[v] ?? 0, 0, 1));
    if (w <= 0) continue;
    const dx = offsets[v * 2];
    const dy = offsets[v * 2 + 1];
    positions[v * 2] += w * (a * dx + b * dy);
    positions[v * 2 + 1] += w * (c * dx + d * dy);
  }
}

// ------------------------------------------------------------------------------------------------
// Jaw extension
// ------------------------------------------------------------------------------------------------

/** The lower face oval, ear to ear through the chin. */
export const LOWER_JAW_OVAL: ReadonlyArray<number> = [132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361];
/** Share of the jaw displacement each ring takes (ring 0 = the oval). */
export const JAW_TAPER: ReadonlyArray<number> = [1, 0.75, 0.45, 0.2];
/**
 * Deepest beard (IOD units below the jaw line) the extension follows. The R4 masks remove the
 * persona over body skin (hands, and the neck alike), so a beard pushed onto the neck is cut out
 * along the mask edge; 0.18 reaches the wearer's jaw silhouette and the band just inside it.
 */
export const JAW_MAX_DEPTH = 0.18;

/** Canonical model coordinates (x = lateral, positive toward the subject's left; y = up; z = depth). */
function canonicalUp(i: number): number {
  return CANONICAL_FACE_MODEL[i * 3 + 1];
}
function canonicalLateral(i: number): number {
  return CANONICAL_FACE_MODEL[i * 3];
}

export interface JawPlan {
  /** Vertices that move. */
  vertex: Int32Array;
  /** Index into LOWER_JAW_OVAL of the jaw point each vertex follows. */
  oval: Int32Array;
  /** Share of that jaw point's displacement (JAW_TAPER by ring). */
  taper: Float32Array;
}

/**
 * Which vertices the jaw extension moves: the lower face (below the nose tip in the canonical
 * model) within three rings of the oval, each following its nearest lower-jaw point.
 */
export function jawPlan(topology: FaceTopology): JawPlan {
  const verts: number[] = [];
  const ovals: number[] = [];
  const tapers: number[] = [];
  const noseUp = canonicalUp(NOSE_TIP);
  const n = Math.min(topology.vertexCount, MESH_POINTS);
  for (let v = 0; v < n; v++) {
    const d = topology.ovalRingDistance[v];
    if (d < 0 || d >= JAW_TAPER.length) continue;
    if (canonicalUp(v) > noseUp) continue;
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < LOWER_JAW_OVAL.length; k++) {
      const j = LOWER_JAW_OVAL[k];
      const dd = Math.hypot(canonicalUp(v) - canonicalUp(j), canonicalLateral(v) - canonicalLateral(j));
      if (dd < bestD) {
        bestD = dd;
        best = k;
      }
    }
    if (best < 0) continue;
    verts.push(v);
    ovals.push(best);
    tapers.push(JAW_TAPER[d]);
  }
  return { vertex: Int32Array.from(verts), oval: Int32Array.from(ovals), taper: Float32Array.from(tapers) };
}

/** sRGB 0..255 at an image pixel, or null outside the image. */
export type RgbSampler = (x: number, y: number) => [number, number, number] | null;

const toLinear = (c: number) => Math.pow(c / 255, 2.2);
function linearLuma(rgb: [number, number, number]): number {
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
}
/** (r − b) / (r + g + b) in linear light: high for skin, low for hair, beard and grey or blue backgrounds. */
function redness(rgb: [number, number, number]): number {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  return (r - b) / Math.max(1e-4, r + g + b);
}

/**
 * How far the beard reaches below each LOWER_JAW_OVAL point in a persona photo, in IOD units
 * (0 = no beard). Walks outward from each jaw point (away from the face centre) and follows the run
 * of beard pixels: much darker than the cheek skin and much less red. A run must start within
 * 0.2 IOD of the jaw line. The result is smoothed along the jaw.
 */
export function beardDepths(sample: RgbSampler, pts: ArrayLike<number>, opts: { maxDepth?: number; step?: number } = {}): Float32Array {
  const out = new Float32Array(LOWER_JAW_OVAL.length);
  const f = eyeFrame(pts);
  if (!f) return out;
  const maxDepth = opts.maxDepth ?? JAW_MAX_DEPTH;
  const step = opts.step ?? 0.03;
  // Cheek skin reference (both cheeks, below the eyes).
  const refs = [50, 280, 205, 425, 117, 346];
  let lum = 0;
  let red = 0;
  let k = 0;
  for (const i of refs) {
    const c = sample(pts[i * 2], pts[i * 2 + 1]);
    if (!c) continue;
    lum += linearLuma(c);
    red += redness(c);
    k++;
  }
  if (!k) return out;
  lum /= k;
  red /= k;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < MESH_POINTS; i++) {
    cx += pts[i * 2];
    cy += pts[i * 2 + 1];
  }
  cx /= MESH_POINTS;
  cy /= MESH_POINTS;
  const isBeard = (c: [number, number, number] | null) => !!c && linearLuma(c) < 0.45 * lum && redness(c) < 0.65 * red;
  const raw = new Float32Array(LOWER_JAW_OVAL.length);
  for (let j = 0; j < LOWER_JAW_OVAL.length; j++) {
    const i = LOWER_JAW_OVAL[j];
    const px = pts[i * 2];
    const py = pts[i * 2 + 1];
    let dx = px - cx;
    let dy = py - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    dx /= len;
    dy /= len;
    let depth = 0;
    let started = false;
    let misses = 0;
    for (let t = 0; t <= maxDepth + 1e-9; t += step) {
      const hit = isBeard(sample(px + dx * t * f.iod, py + dy * t * f.iod));
      if (hit) {
        started = true;
        depth = t;
        misses = 0;
      } else if (started) {
        if (++misses > 1) break;
      } else if (t > 0.2) {
        break;
      }
    }
    raw[j] = started ? depth : 0;
  }
  // Smooth along the jaw (the ends keep their own value).
  for (let j = 0; j < raw.length; j++) {
    const a = raw[Math.max(0, j - 1)];
    const b = raw[j];
    const c = raw[Math.min(raw.length - 1, j + 1)];
    // The two ends of the jaw line sit at cheek height by the ears, where hair and sideburns also
    // read as beard and the photo's background lies just beyond: they taper to no push.
    const end = Math.min(j, raw.length - 1 - j);
    const taper = end >= 3 ? 1 : end / 3;
    out[j] = clamp(0.25 * a + 0.5 * b + 0.25 * c, 0, maxDepth) * taper;
  }
  return out;
}

/**
 * Share of the jaw push each side of the face takes, from how foreshortened it is: the nose
 * bridge (168) to the outer eye corner on each side, against the longer of the two. Frontal: both
 * 1. A side compressed to 60% of the other (a turn of roughly 35°) takes none, so the far jaw is
 * never pushed past its silhouette. [right side (33), left side (263)].
 */
export function jawSideScale(points: ArrayLike<number>): [number, number] {
  const d = (a: number, b: number) => Math.hypot(points[a * 2] - points[b * 2], points[a * 2 + 1] - points[b * 2 + 1]);
  const dR = d(168, 33);
  const dL = d(168, 263);
  const m = Math.max(dR, dL, 1e-6);
  return [smooth(0.6, 0.95, dR / m), smooth(0.6, 0.95, dL / m)];
}

/**
 * Pushes the planned vertices of `points` (pixels: screen positions or persona-texture pixels)
 * outward from the face centre by taper · depth · IOD of their jaw point, times the turn factor
 * min(jawSideScale): full on a frontal face, none from a turn of roughly 35°. On a turned head the
 * oval already follows the jaw silhouette, and a push there meets the masks' jaw/neck edge as a
 * hard notch. `count` points form the centroid; IOD and the turn come from the same points, so the
 * screen and each keyframe's UVs use their own scale and turn.
 */
export function applyJawExtension(points: Float32Array, plan: JawPlan, depths: ArrayLike<number>, count = MESH_POINTS): boolean {
  const f = eyeFrame(points);
  if (!f) return false;
  const [sideR, sideL] = jawSideScale(points);
  const turn = Math.min(sideR, sideL);
  if (turn <= 0) return true;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i++) {
    cx += points[i * 2];
    cy += points[i * 2 + 1];
  }
  cx /= count;
  cy /= count;
  // Directions from the original positions, before any vertex moves.
  const moves = new Float32Array(plan.vertex.length * 2);
  for (let k = 0; k < plan.vertex.length; k++) {
    const v = plan.vertex[k];
    const amount = plan.taper[k] * (depths[plan.oval[k]] ?? 0) * f.iod * turn;
    if (amount <= 0) continue;
    const dx = points[v * 2] - cx;
    const dy = points[v * 2 + 1] - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    moves[k * 2] = (dx / len) * amount;
    moves[k * 2 + 1] = (dy / len) * amount;
  }
  for (let k = 0; k < plan.vertex.length; k++) {
    const v = plan.vertex[k];
    points[v * 2] += moves[k * 2];
    points[v * 2 + 1] += moves[k * 2 + 1];
  }
  return true;
}

// ------------------------------------------------------------------------------------------------
// Seam fade (flag seamFade)
// ------------------------------------------------------------------------------------------------

/**
 * The sides of the face (canonical lateral beyond 4, between the mouth corners and the brows,
 * within three rings of the oval): where a turned enrollment shot's far side can sit on its
 * silhouette, so its UVs land on the wall or hair behind the persona.
 */
export function sideRegionVertices(topology: FaceTopology): Int32Array {
  const out: number[] = [];
  const n = Math.min(topology.vertexCount, MESH_POINTS);
  for (let v = 0; v < n; v++) {
    const d = topology.ovalRingDistance[v];
    if (d < 0 || d > 3) continue;
    const x = canonicalLateral(v);
    const y = canonicalUp(v);
    if (Math.abs(x) > 4 && y > -3.5 && y < 4.6) out.push(v);
  }
  return Int32Array.from(out);
}

/**
 * Per-vertex weight that fades the persona where a photo's UVs fall off its face skin on the
 * sides (sideRegionVertices): the share of skin-coloured pixels in a small patch around the UV,
 * mapped 0.25..0.65 → 0..1. 1 everywhere else. `uvPx` are the photo's landmark pixels.
 */
export function silhouetteWeights(sample: RgbSampler, uvPx: ArrayLike<number>, topology: FaceTopology, side: ArrayLike<number> = sideRegionVertices(topology)): Float32Array {
  const out = new Float32Array(topology.vertexCount).fill(1);
  const f = eyeFrame(uvPx);
  if (!f) return out;
  let lum = 0;
  let red = 0;
  let k = 0;
  for (const i of [50, 280, 205, 425, 117, 346]) {
    const c = sample(uvPx[i * 2], uvPx[i * 2 + 1]);
    if (!c) continue;
    lum += linearLuma(c);
    red += redness(c);
    k++;
  }
  if (!k) return out;
  lum /= k;
  red /= k;
  const r = 0.05 * f.iod;
  const offsets: Array<[number, number]> = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]];
  for (let s = 0; s < side.length; s++) {
    const v = side[s];
    let skin = 0;
    let seen = 0;
    for (const [dx, dy] of offsets) {
      const c = sample(uvPx[v * 2] + dx, uvPx[v * 2 + 1] + dy);
      seen++;
      if (c && redness(c) > 0.55 * red && linearLuma(c) > 0.25 * lum && linearLuma(c) < 2.5 * lum) skin++;
    }
    out[v] = smooth(0.25, 0.65, skin / Math.max(1, seen));
  }
  return out;
}

/** True when any jaw depth is large enough to matter (a clean-shaven persona leaves the mesh alone). */
export function hasBeard(depths: ArrayLike<number>, min = 0.05): boolean {
  for (let i = 0; i < depths.length; i++) if (depths[i] >= min) return true;
  return false;
}

// ------------------------------------------------------------------------------------------------
// Eyelid pass-through
// ------------------------------------------------------------------------------------------------

/** How many rings past the eye pass-through radius the upper-lid band reaches when the lid is lowered. */
export const LID_BAND_RINGS = 2.5;

/**
 * Upper-lid band weights per eye: the part of a wider eye pass-through (radius + LID_BAND_RINGS)
 * that lies above the eye (canonical model), split by eye. LEFT = the subject's left eye (263/362).
 */
export function upperLidBands(topology: FaceTopology, baseRadius: number, extra = LID_BAND_RINGS): { left: Float32Array; right: Float32Array } {
  const base = eyeFadeWeights(topology, baseRadius);
  const wide = eyeFadeWeights(topology, baseRadius + extra);
  const left = new Float32Array(topology.vertexCount);
  const right = new Float32Array(topology.vertexCount);
  const leftUp = (canonicalUp(263) + canonicalUp(362)) / 2;
  const rightUp = (canonicalUp(33) + canonicalUp(133)) / 2;
  const n = Math.min(topology.vertexCount, MESH_POINTS);
  for (let v = 0; v < n; v++) {
    const band = Math.max(0, wide[v] - base[v]);
    if (band <= 0) continue;
    const isLeft = canonicalLateral(v) > 0;
    const eyeUp = isLeft ? leftUp : rightUp;
    if (canonicalUp(v) <= eyeUp + 0.15) continue;
    (isLeft ? left : right)[v] = band;
  }
  return { left, right };
}

/** base + closureLeft · left band + closureRight · right band, capped at 1. */
export function lidPassThroughWeights(base: ArrayLike<number>, bands: { left: ArrayLike<number>; right: ArrayLike<number> }, closureLeft: number, closureRight: number, out: Float32Array): Float32Array {
  const cl = clamp(closureLeft, 0, 1);
  const cr = clamp(closureRight, 0, 1);
  for (let v = 0; v < out.length; v++) out[v] = Math.min(1, (base[v] ?? 0) + cl * (bands.left[v] ?? 0) + cr * (bands.right[v] ?? 0));
  return out;
}

/**
 * Per-eye lid closure 0..1 from the eye aspect ratio against the wearer's own open-eye ratio
 * (tracked: rises fast, decays slowly), raised by downward gaze, smoothed over ~2 frames.
 */
export class LidClosure {
  private open: [number, number] = [0, 0];
  private value: [number, number] = [0, 0];

  /**
   * `blink` and `lookDown` are MediaPipe's eyeBlink / eyeLookDown blendshapes per eye ([left,
   * right], 0..1) when the tracker provides them: they follow a lowered lid more reliably than
   * the aspect ratio and the iris position alone.
   */
  update(earLeft: number, earRight: number, gazeY: number, blink?: readonly [number, number], lookDown?: readonly [number, number], headDown = 0): [number, number] {
    const ears = [earLeft, earRight];
    const gaze = smooth(0.1, 0.4, gazeY) * 0.9;
    for (let e = 0; e < 2; e++) {
      const ear = ears[e];
      if (!(ear > 0)) continue;
      if (this.open[e] === 0) this.open[e] = ear;
      else this.open[e] += (ear - this.open[e]) * (ear > this.open[e] ? 0.2 : 0.002);
      const closed = smooth(0.1, 0.45, 1 - ear / Math.max(1e-4, this.open[e]));
      const bs = Math.max(smooth(0.25, 0.7, blink?.[e] ?? 0), smooth(0.2, 0.6, lookDown?.[e] ?? 0) * 0.9);
      // Chin down: the camera sees more of the upper lid even with the eyes looking ahead.
      const target = Math.max(closed, gaze, bs, clamp(headDown, 0, 1) * 0.9);
      // Close fast, open a little slower: a lowered lid must not show the persona's crease for a frame.
      this.value[e] += (target - this.value[e]) * (target > this.value[e] ? 0.7 : 0.4);
    }
    return [this.value[0], this.value[1]];
  }

  reset() {
    this.open = [0, 0];
    this.value = [0, 0];
  }
}

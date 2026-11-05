/**
 * Rigid-pose stabilisation for the upper face (realism flag `rigidForehead`, R2).
 *
 * The Face Landmarker's facial transformation matrix maps MediaPipe's canonical face model into
 * camera space. Projecting the canonical forehead through that matrix gives forehead positions
 * that move rigidly with the head, free of the per-landmark jitter the tracked forehead points
 * carry (there is little texture on a forehead for the landmarker to lock on to). The pipeline:
 *
 *   1. decompose the matrix into rotation (quaternion) and translation and smooth those 7 numbers
 *      with One Euro filters;
 *   2. project the canonical model with the smoothed pose, then fit a 2D similarity (scale and
 *      translation) from a stable subset (nose bridge, eye corners, temples) onto this frame's
 *      tracked landmarks, which absorbs the unknown focal length and keeps the rigid points on
 *      the real face;
 *   3. learn a slow per-vertex offset while the head is near frontal, so the wearer's own forehead
 *      shape (higher, lower, wider than the canonical model) is matched without per-frame noise;
 *   4. forehead vertices take the rigid position, brow vertices take the rigid position plus a
 *      smoothed expression offset, everything else keeps the tracked landmarks.
 *
 * Pure except for the filters' timestamps, so it is unit-tested with synthetic poses.
 */
import { CANONICAL_FACE_MODEL, CANONICAL_FACE_VERTEX_COUNT } from './canonicalFaceModel.ts';
import { OneEuroFilter } from './faceMath.ts';

/** Brow vertices (both brows, MediaPipe indices). */
export const BROW_VERTICES: ReadonlyArray<number> = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 300, 293, 334, 296, 336, 285, 295, 282, 283, 276];

/** Vertices that barely move with expression: nose bridge and tip, eye corners, temples. */
export const RIGID_FIT_VERTICES: ReadonlyArray<number> = [6, 168, 197, 195, 5, 4, 1, 2, 33, 133, 362, 263, 234, 454, 127, 356];

/** Eye rings (MediaPipe indices): the rigid region starts just above the upper lids. */
const EYE_RING_VERTICES: ReadonlyArray<number> = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];

/** Canonical height above which a vertex counts as upper face (just above the upper eyelids). */
const FOREHEAD_MIN_Y = Math.max(...EYE_RING_VERTICES.map((v) => CANONICAL_FACE_MODEL[v * 3 + 1])) + 0.1;

/**
 * Upper-face vertices driven by the rigid pose: everything in the canonical model above the
 * eyelids (forehead, glabella, upper nose bridge) except the brows (rigid + expression offset)
 * and the fit vertices (they anchor the similarity and stay tracked).
 */
export const FOREHEAD_VERTICES: ReadonlyArray<number> = Array.from({ length: CANONICAL_FACE_VERTEX_COUNT }, (_, v) => v).filter(
  (v) => CANONICAL_FACE_MODEL[v * 3 + 1] > FOREHEAD_MIN_Y && !BROW_VERTICES.includes(v) && !RIGID_FIT_VERTICES.includes(v)
);

export interface RigidPose {
  /** Unit quaternion [x, y, z, w] of the head rotation (camera space). */
  q: [number, number, number, number];
  /** Translation in camera space (cm). */
  t: [number, number, number];
}

/**
 * Reads MediaPipe's 4×4 facial transformation matrix. The JS API hands over a flat array of 16
 * numbers; the face sits in front of the camera at a negative z, which tells row-major from
 * column-major apart without guessing.
 */
export function decomposeTransform(data: ArrayLike<number>): RigidPose | null {
  if (data.length !== 16) return null;
  const rowMajor = data[11] < 0 || data[14] >= 0;
  const m = (r: number, c: number) => (rowMajor ? data[r * 4 + c] : data[c * 4 + r]);
  const t: [number, number, number] = [m(0, 3), m(1, 3), m(2, 3)];
  if (!Number.isFinite(t[0]) || !Number.isFinite(t[1]) || !Number.isFinite(t[2])) return null;
  // Rotation → quaternion (Shepperd), with the scale removed from each column first.
  const col = (c: number) => {
    const x = m(0, c);
    const y = m(1, c);
    const z = m(2, c);
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  const [c0, c1, c2] = [col(0), col(1), col(2)];
  const r00 = c0[0], r10 = c0[1], r20 = c0[2];
  const r01 = c1[0], r11 = c1[1], r21 = c1[2];
  const r02 = c2[0], r12 = c2[1], r22 = c2[2];
  const trace = r00 + r11 + r22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, 0.25 * s];
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
  }
  return { q: normalizeQuat(q), t };
}

export function normalizeQuat(q: [number, number, number, number]): [number, number, number, number] {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Rotates a point by a unit quaternion. */
export function rotate(q: [number, number, number, number], p: [number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  const [px, py, pz] = p;
  // t = 2 * cross(q.xyz, p); p' = p + w*t + cross(q.xyz, t)
  const tx = 2 * (y * pz - z * py);
  const ty = 2 * (z * px - x * pz);
  const tz = 2 * (x * py - y * px);
  return [px + w * tx + (y * tz - z * ty), py + w * ty + (z * tx - x * tz), pz + w * tz + (x * ty - y * tx)];
}

/** Yaw, pitch and roll (degrees) of a pose, for the debug panel. */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function poseAngles(q: [number, number, number, number]): { yaw: number; pitch: number; roll: number } {
  const [x, y, z, w] = q;
  const sinp = 2 * (w * x - y * z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, sinp)));
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
  const roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  const d = 180 / Math.PI;
  return { yaw: yaw * d, pitch: pitch * d, roll: roll * d };
}

/**
 * Projects the canonical model under a pose into "unit focal" image coordinates
 * (x right, y down, perspective division by the distance to the camera). Writes 468 × xy.
 */
export function projectCanonical(pose: RigidPose, out: Float32Array, model: Float32Array = CANONICAL_FACE_MODEL) {
  for (let v = 0; v < CANONICAL_FACE_VERTEX_COUNT; v++) {
    const p = rotate(pose.q, [model[v * 3], model[v * 3 + 1], model[v * 3 + 2]]);
    const x = p[0] + pose.t[0];
    const y = p[1] + pose.t[1];
    const z = p[2] + pose.t[2];
    const depth = Math.max(1e-3, -z);
    out[v * 2] = x / depth;
    out[v * 2 + 1] = -y / depth;
  }
}

export interface Similarity {
  s: number;
  tx: number;
  ty: number;
}

/** Least-squares scale + translation mapping src onto dst over the given vertex indices. */
export function fitSimilarity(src: ArrayLike<number>, dst: ArrayLike<number>, indices: ReadonlyArray<number>): Similarity {
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (const i of indices) {
    sx += src[i * 2];
    sy += src[i * 2 + 1];
    dx += dst[i * 2];
    dy += dst[i * 2 + 1];
  }
  const n = indices.length;
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num = 0, den = 0;
  for (const i of indices) {
    const ax = src[i * 2] - sx;
    const ay = src[i * 2 + 1] - sy;
    num += ax * (dst[i * 2] - dx) + ay * (dst[i * 2 + 1] - dy);
    den += ax * ax + ay * ay;
  }
  const s = den > 0 ? num / den : 1;
  return { s, tx: dx - s * sx, ty: dy - s * sy };
}

export interface StabilizerOptions {
  /** One Euro parameters for the pose (quaternion + translation). */
  poseMinCutoff?: number;
  poseBeta?: number;
  /** One Euro parameters for the brow expression offsets. */
  browMinCutoff?: number;
  browBeta?: number;
  /** Time constant (s) of the per-vertex shape offset learned while the head is near frontal. */
  shapeTau?: number;
  /** |yaw| and |pitch| (degrees) below which the shape offset keeps learning. */
  frontalDeg?: number;
  /** Learn the per-vertex shape offset at all (false: the forehead is the rigid model alone). */
  learnShape?: boolean;
  /** |yaw| (degrees) up to which the rigid forehead has full weight, and where it has faded out to the tracked points. */
  yawFadeStartDeg?: number;
  yawFadeEndDeg?: number;
}

/**
 * Per-frame stabiliser. `update()` takes the raw transform and the raw tracked landmarks in the
 * same pixel space the smoothed landmarks use, and returns rigid positions for every vertex;
 * `apply()` overwrites the forehead and brow entries of a landmark array with them.
 */
export class RigidPoseStabilizer {
  private readonly poseFilters: OneEuroFilter[];
  private readonly browFilters = new Map<number, [OneEuroFilter, OneEuroFilter]>();
  private readonly projected = new Float32Array(CANONICAL_FACE_VERTEX_COUNT * 2);
  /** Per-vertex offset in projected (unit-focal) units, scaled by the fitted similarity when applied. */
  private readonly shapeOffset = new Float32Array(CANONICAL_FACE_VERTEX_COUNT * 2);
  private shapeFrames = 0;
  private lastTime: number | null = null;
  public readonly rigid = new Float32Array(CANONICAL_FACE_VERTEX_COUNT * 2);
  public lastPose: RigidPose | null = null;
  public lastFit: Similarity | null = null;
  /**
   * Weight of the rigid positions in apply(): 1 near frontal, fading to 0 across the yaw band.
   * On a yaw turn the canonical model (and the frontal shape offset) no longer matches the wearer's
   * forehead and the rigid points drift against the real head motion (clip B slide 0.3 → 1.2 px per
   * frame), while the nod and hand clips that the stabiliser was built for stay near frontal.
   */
  public lastWeight = 1;
  private readonly opts: Required<StabilizerOptions>;

  constructor(opts: StabilizerOptions = {}) {
    this.opts = {
      poseMinCutoff: opts.poseMinCutoff ?? 1.2,
      poseBeta: opts.poseBeta ?? 0.05,
      browMinCutoff: opts.browMinCutoff ?? 1.5,
      browBeta: opts.browBeta ?? 0.05,
      shapeTau: opts.shapeTau ?? 1.0,
      frontalDeg: opts.frontalDeg ?? 12,
      learnShape: opts.learnShape ?? true,
      yawFadeStartDeg: opts.yawFadeStartDeg ?? 15,
      yawFadeEndDeg: opts.yawFadeEndDeg ?? 30,
    };
    this.poseFilters = Array.from({ length: 7 }, () => new OneEuroFilter(this.opts.poseMinCutoff, this.opts.poseBeta, 1.0));
  }

  /** Changes the filter parameters in place; turning shape learning off also clears the learned offset. */
  configure(opts: StabilizerOptions) {
    Object.assign(this.opts, opts);
    for (const f of this.poseFilters) f.setParams(this.opts.poseMinCutoff, this.opts.poseBeta);
    for (const pair of this.browFilters.values()) for (const f of pair) f.setParams(this.opts.browMinCutoff, this.opts.browBeta);
    if (!this.opts.learnShape) {
      this.shapeOffset.fill(0);
      this.shapeFrames = 0;
    }
  }

  reset() {
    for (const f of this.poseFilters) f.reset();
    this.browFilters.clear();
    this.shapeOffset.fill(0);
    this.shapeFrames = 0;
    this.lastTime = null;
    this.lastPose = null;
    this.lastFit = null;
    this.lastWeight = 1;
  }

  /**
   * @param transform  the 16 numbers of the facial transformation matrix
   * @param tracked    raw tracked landmarks (478 × xy) in the target pixel space
   * @param timestamp  ms
   * @param mirrorX    true when `tracked` is horizontally mirrored relative to the camera image
   * @returns false when the transform is unusable (nothing is written)
   */
  update(transform: ArrayLike<number>, tracked: ArrayLike<number>, timestamp: number, mirrorX = false): boolean {
    const raw = decomposeTransform(transform);
    if (!raw) return false;
    // Keep the quaternion on the same hemisphere as the filtered one so the filter never averages q with -q.
    const prev = this.lastPose;
    let q = raw.q;
    if (prev && q[0] * prev.q[0] + q[1] * prev.q[1] + q[2] * prev.q[2] + q[3] * prev.q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    const f = this.poseFilters;
    const pose: RigidPose = {
      q: normalizeQuat([f[0].filter(q[0], timestamp), f[1].filter(q[1], timestamp), f[2].filter(q[2], timestamp), f[3].filter(q[3], timestamp)]),
      t: [f[4].filter(raw.t[0], timestamp), f[5].filter(raw.t[1], timestamp), f[6].filter(raw.t[2], timestamp)],
    };
    this.lastPose = pose;

    projectCanonical(pose, this.projected);
    // A mirrored driver (webcam preview) flips x; a positive-scale similarity cannot, so flip here.
    if (mirrorX) for (let v = 0; v < CANONICAL_FACE_VERTEX_COUNT; v++) this.projected[v * 2] = -this.projected[v * 2];
    const fit = fitSimilarity(this.projected, tracked, RIGID_FIT_VERTICES);
    this.lastFit = fit;

    // Learn the wearer's forehead shape (tracked − rigid, in projected units) while near frontal.
    const angles = poseAngles(pose.q);
    this.lastWeight = 1 - smoothstep(this.opts.yawFadeStartDeg, this.opts.yawFadeEndDeg, Math.abs(angles.yaw));
    const dt = this.lastTime === null ? 1 / 30 : Math.max(1e-3, (timestamp - this.lastTime) / 1000);
    this.lastTime = timestamp;
    if (this.opts.learnShape && Math.abs(angles.yaw) < this.opts.frontalDeg && Math.abs(angles.pitch) < this.opts.frontalDeg && fit.s > 0) {
      const a = this.shapeFrames === 0 ? 1 : 1 - Math.exp(-dt / this.opts.shapeTau);
      for (const v of FOREHEAD_VERTICES) {
        const ox = (tracked[v * 2] - fit.tx) / fit.s - this.projected[v * 2];
        const oy = (tracked[v * 2 + 1] - fit.ty) / fit.s - this.projected[v * 2 + 1];
        this.shapeOffset[v * 2] += (ox - this.shapeOffset[v * 2]) * a;
        this.shapeOffset[v * 2 + 1] += (oy - this.shapeOffset[v * 2 + 1]) * a;
      }
      this.shapeFrames++;
    }

    for (let v = 0; v < CANONICAL_FACE_VERTEX_COUNT; v++) {
      this.rigid[v * 2] = fit.s * (this.projected[v * 2] + this.shapeOffset[v * 2]) + fit.tx;
      this.rigid[v * 2 + 1] = fit.s * (this.projected[v * 2 + 1] + this.shapeOffset[v * 2 + 1]) + fit.ty;
    }
    return true;
  }

  /**
   * Overwrites forehead vertices with the rigid positions and brow vertices with rigid + smoothed
   * expression offset. `smoothed` is the array the warp reads (478 × xy, same pixel space).
   */
  apply(smoothed: Float32Array, timestamp: number) {
    if (!this.lastPose) return;
    const w = this.lastWeight;
    for (const v of FOREHEAD_VERTICES) {
      smoothed[v * 2] += (this.rigid[v * 2] - smoothed[v * 2]) * w;
      smoothed[v * 2 + 1] += (this.rigid[v * 2 + 1] - smoothed[v * 2 + 1]) * w;
    }
    for (const v of BROW_VERTICES) {
      let pair = this.browFilters.get(v);
      if (!pair) {
        pair = [new OneEuroFilter(this.opts.browMinCutoff, this.opts.browBeta, 1.0), new OneEuroFilter(this.opts.browMinCutoff, this.opts.browBeta, 1.0)];
        this.browFilters.set(v, pair);
      }
      const ox = pair[0].filter(smoothed[v * 2] - this.rigid[v * 2], timestamp);
      const oy = pair[1].filter(smoothed[v * 2 + 1] - this.rigid[v * 2 + 1], timestamp);
      smoothed[v * 2] += (this.rigid[v * 2] + ox - smoothed[v * 2]) * w;
      smoothed[v * 2 + 1] += (this.rigid[v * 2 + 1] + oy - smoothed[v * 2 + 1]) * w;
    }
  }
}

/**
 * Face mesh topology & kinematics helpers built on the MediaPipe 478-point face landmark layout.
 *
 * Everything in this file is pure (no DOM, no MediaPipe runtime) so it can be unit-tested with
 * `node --test`. The MediaPipe connection tables are passed in rather than imported so the
 * topology builder is independent of the WASM bundle.
 */
import { calculateEyeAspectRatio, calculateMouthAspectRatio, estimateHeadPose, Point2D } from './faceMath.ts';

export interface Connection {
  start: number;
  end: number;
}

/** Well-known landmark indices in the MediaPipe face mesh. */
export const LM = {
  NOSE_TIP: 1,
  NOSE_BRIDGE: 6,
  CHIN: 152,
  FOREHEAD: 10,
  LEFT_CHEEK: 280,
  RIGHT_CHEEK: 50,
  // Subject's right eye (appears on the left of an un-mirrored image)
  RIGHT_EYE: { outer: 33, inner: 133, top1: 160, top2: 158, bottom1: 144, bottom2: 153 },
  // Subject's left eye
  LEFT_EYE: { outer: 263, inner: 362, top1: 387, top2: 385, bottom1: 373, bottom2: 380 },
  MOUTH: { upperInner: 13, lowerInner: 14, cornerRight: 61, cornerLeft: 291 },
  RIGHT_IRIS_CENTER: 468,
  LEFT_IRIS_CENTER: 473,
} as const;

/** Ordered polygon rings (counter-clockwise in image space) for the mesh holes. */
export const LEFT_EYE_RING = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const RIGHT_EYE_RING = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const INNER_LIP_RING = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
/** Outer lip contour (vermilion border), ordered around the mouth. */
export const OUTER_LIP_RING = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
/** Lip-band weight of the first tessellation ring outside the outer lip contour (feather ≈ 8–10% of mouth width). */
export const LIP_FEATHER_RING1 = 0.55;

/**
 * Three-cycles in the tessellation graph that are NOT mesh faces (they enclose another vertex).
 * Derived once from the MediaPipe tessellation; see buildFaceTopology().
 */
export const SEPARATING_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  [49, 64, 129],
  [279, 294, 358],
];

export interface FaceTopology {
  /** Triangle index list covering the skin surface (eyes and inner mouth left as holes). */
  triangles: Uint16Array;
  /** Triangle fans that fill the two eye holes (used when persona eyes should replace the wearer's). */
  eyeTriangles: Uint16Array;
  /** Per-vertex opacity in [0,1]: 0 on the face oval, rising to 1 a few rings inward (edge feathering). */
  featherWeights: Float32Array;
  /**
   * 1 on the lip band (inner and outer lip rings), LIP_FEATHER_RING1 one ring outside it, 0
   * elsewhere, so the shader can fade the persona lips out as the mouth opens ("keep my real mouth")
   * with a feather of about one tessellation ring past the persona's lip colour.
   */
  lipWeights: Float32Array;
  /**
   * Lip zone per vertex: 0 on the inner lip ring, 1 on the outer lip contour, 2 one tessellation
   * ring outside it, 3 everywhere else. Interpolated in the shader, values between 1 and 2 are the
   * band just outside the wearer's vermilion border where fuller persona lips spill.
   */
  lipZones: Float32Array;
  /** BFS ring distance of every vertex from the eye rings (0 on the rings; -1 if unreachable). */
  eyeRingDistance: Int16Array;
  /** BFS ring distance of every vertex from the face oval (0 on the oval; -1 if unreachable). */
  ovalRingDistance: Int16Array;
  /** Number of vertices referenced (468 mesh points; iris points are not part of the surface). */
  vertexCount: number;
}

/**
 * Builds a renderable triangle list from the MediaPipe tessellation edge table.
 *
 * MediaPipe only ships edges (connections). For a planar triangulation every face is a 3-cycle of
 * the edge graph, so we enumerate 3-cycles and drop the known separating triangles.
 */
export function buildFaceTopology(
  tessellation: Connection[],
  faceOval: Connection[],
  vertexCount = 468,
  separating: ReadonlyArray<readonly [number, number, number]> = SEPARATING_TRIANGLES
): FaceTopology {
  const adjacency: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
  for (const { start, end } of tessellation) {
    if (start >= vertexCount || end >= vertexCount) continue;
    adjacency[start].add(end);
    adjacency[end].add(start);
  }

  const banned = new Set(separating.map((t) => [...t].sort((a, b) => a - b).join(',')));
  const tris: number[] = [];
  for (let a = 0; a < vertexCount; a++) {
    for (const b of adjacency[a]) {
      if (b <= a) continue;
      for (const c of adjacency[a]) {
        if (c <= b) continue;
        if (!adjacency[b].has(c)) continue;
        if (banned.has(`${a},${b},${c}`)) continue;
        tris.push(a, b, c);
      }
    }
  }

  // Feather weights: BFS ring distance from the face-oval vertices.
  const distance = new Int16Array(vertexCount).fill(-1);
  const queue: number[] = [];
  for (const { start, end } of faceOval) {
    for (const v of [start, end]) {
      if (v < vertexCount && distance[v] === -1) {
        distance[v] = 0;
        queue.push(v);
      }
    }
  }
  while (queue.length) {
    const v = queue.shift()!;
    for (const n of adjacency[v]) {
      if (distance[n] === -1) {
        distance[n] = distance[v] + 1;
        queue.push(n);
      }
    }
  }
  const featherWeights = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const d = distance[v];
    // Smooth 5-step sigmoid curve from outer face oval into the interior
    featherWeights[v] =
      d < 0 ? 1 : d === 0 ? 0 : d === 1 ? 0.22 : d === 2 ? 0.5 : d === 3 ? 0.78 : d === 4 ? 0.92 : 1;
  }

  const eyeTriangles = [...fanTriangles(LEFT_EYE_RING), ...fanTriangles(RIGHT_EYE_RING)];

  // Lip band: 1 on the lip rings, LIP_FEATHER_RING1 one ring outside them (the persona's lip colour
  // usually spills past the wearer's vermilion border), 0 beyond.
  const lipRingDistance = ringDistance(adjacency, [...INNER_LIP_RING, ...OUTER_LIP_RING], vertexCount);
  const lipWeights = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) lipWeights[v] = lipRingDistance[v] === 0 ? 1 : lipRingDistance[v] === 1 ? LIP_FEATHER_RING1 : 0;
  const lipZones = new Float32Array(vertexCount).fill(3);
  for (let v = 0; v < vertexCount; v++) if (lipRingDistance[v] === 1) lipZones[v] = 2;
  for (const v of OUTER_LIP_RING) if (v < vertexCount) lipZones[v] = 1;
  for (const v of INNER_LIP_RING) if (v < vertexCount) lipZones[v] = 0;

  const eyeRingDistance = ringDistance(adjacency, [...LEFT_EYE_RING, ...RIGHT_EYE_RING], vertexCount);

  return {
    triangles: new Uint16Array(tris),
    eyeTriangles: new Uint16Array(eyeTriangles),
    featherWeights,
    lipWeights,
    lipZones,
    eyeRingDistance,
    ovalRingDistance: distance,
    vertexCount,
  };
}

/** Tone-match weight is this at the face centre (the persona keeps its own complexion there) ... */
export const TONE_WEIGHT_CENTRE = 0.3;
/** ... rising to 1 on the face oval over this many tessellation rings. */
export const TONE_WEIGHT_RINGS = 10;

/**
 * Per-vertex weight of the R3 tone match: 1 on the face boundary (skin meets the neck and ears
 * without a colour step), falling to TONE_WEIGHT_CENTRE a few rings inward.
 */
/** Rings from the face oval over which the R4 two-band blend fades the low frequencies (~12% of face width). */
export const WIDE_FEATHER_RINGS = 7;

/** Per-vertex wide feather for the two-band boundary blend (R4 §3): 0 on the oval, 1 from WIDE_FEATHER_RINGS inward. */
export function wideFeatherWeights(topology: FaceTopology): Float32Array {
  const out = new Float32Array(topology.vertexCount);
  for (let v = 0; v < topology.vertexCount; v++) {
    const d = topology.ovalRingDistance[v];
    if (d < 0) { out[v] = 1; continue; }
    const t = clamp(d / WIDE_FEATHER_RINGS, 0, 1);
    out[v] = t * t * (3 - 2 * t);
  }
  return out;
}

export function toneWeights(topology: FaceTopology): Float32Array {
  const out = new Float32Array(topology.vertexCount);
  for (let v = 0; v < topology.vertexCount; v++) {
    const d = topology.ovalRingDistance[v];
    out[v] = d < 0 ? TONE_WEIGHT_CENTRE : 1 - (1 - TONE_WEIGHT_CENTRE) * Math.min(d, TONE_WEIGHT_RINGS) / TONE_WEIGHT_RINGS;
  }
  return out;
}

/**
 * Closed-lip mask weight for an interpolated lip zone (see FaceTopology.lipZones): 0 inside the
 * wearer's lip ring, rising to 1 just past the outer contour and fading back to 0 by the second
 * ring outside. Mirrors the shader; used by the 2D fallback and the tests.
 */
export function closedLipMaskForZone(zone: number): number {
  const rise = smoothstep(1.0, 1.3, zone);
  const fall = 1 - smoothstep(2.0, 3.0, zone);
  return rise * fall;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** BFS hop count from a set of seed vertices over the tessellation graph (-1 when unreachable). */
function ringDistance(adjacency: Set<number>[], seeds: number[], vertexCount: number): Int16Array {
  const distance = new Int16Array(vertexCount).fill(-1);
  const queue: number[] = [];
  for (const v of seeds) {
    if (v < vertexCount && distance[v] === -1) {
      distance[v] = 0;
      queue.push(v);
    }
  }
  while (queue.length) {
    const v = queue.shift()!;
    for (const n of adjacency[v]) {
      if (distance[n] === -1) {
        distance[n] = distance[v] + 1;
        queue.push(n);
      }
    }
  }
  return distance;
}

/**
 * Eye pass-through weights: how much of the persona to remove around each eye hole so the wearer's
 * own lids and lashes show. `radius` is in tessellation rings: 0 = nothing (the hole stays at the
 * eye contour), 1 = the first ring outside the contour fades to zero ("just past the lash line"),
 * 2 = two rings. Fractions interpolate.
 */
export function eyeFadeWeights(topology: FaceTopology, radius: number): Float32Array {
  const out = new Float32Array(topology.vertexCount);
  if (radius <= 0) return out;
  for (let v = 0; v < topology.vertexCount; v++) {
    const d = topology.eyeRingDistance[v];
    if (d < 0) continue;
    out[v] = clamp(radius - d, 0, 1);
  }
  return out;
}

/**
 * How much of the persona lip band to fade for a given mouth openness (MAR): 0 up to `start`,
 * 1 from `end` (the R1 fixed thresholds by default; R3 places them above the wearer's resting
 * aperture, see restMouth.ts).
 */
export function lipFadeForMar(mar: number, closedFade = 0, start = 0.02, end = 0.1): number {
  const t = clamp((mar - start) / Math.max(1e-6, end - start), 0, 1);
  const s = t * t * (3 - 2 * t);
  return closedFade + (1 - closedFade) * s;
}

/** Triangle fan covering a simple polygon ring. */
export function fanTriangles(ring: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < ring.length - 1; i++) out.push(ring[0], ring[i], ring[i + 1]);
  return out;
}

export interface LandmarkKinematics {
  earLeft: number;
  earRight: number;
  mar: number;
  mouthWidthRatio: number;
  yaw: number;
  pitch: number;
  roll: number;
  gazeX: number;
  gazeY: number;
  faceWidth: number;
  faceHeight: number;
  center: Point2D;
}

/**
 * Computes eye/mouth aspect ratios, head pose and gaze from landmark pixel positions.
 * `points` is a flat [x0, y0, x1, y1, ...] array in image space (y down).
 */
export function computeKinematics(points: Float32Array, neutralMouthWidth: number | null): LandmarkKinematics {
  const p = (i: number): Point2D => ({ x: points[i * 2], y: points[i * 2 + 1] });

  const l = LM.LEFT_EYE;
  const r = LM.RIGHT_EYE;
  const earLeft = calculateEyeAspectRatio(p(l.outer), p(l.top1), p(l.top2), p(l.inner), p(l.bottom2), p(l.bottom1));
  const earRight = calculateEyeAspectRatio(p(r.outer), p(r.top1), p(r.top2), p(r.inner), p(r.bottom2), p(r.bottom1));

  const m = LM.MOUTH;
  const mar = calculateMouthAspectRatio(p(m.upperInner), p(m.lowerInner), p(m.cornerRight), p(m.cornerLeft));
  const mouthWidth = Math.hypot(p(m.cornerLeft).x - p(m.cornerRight).x, p(m.cornerLeft).y - p(m.cornerRight).y);

  const nose = p(LM.NOSE_TIP);
  const chin = p(LM.CHIN);
  const forehead = p(LM.FOREHEAD);
  const eyeR = p(r.outer);
  const eyeL = p(l.outer);
  const pose = estimateHeadPose(
    { ...nose, z: 0 },
    { ...chin, z: 0 },
    { ...eyeR, z: 0 },
    { ...eyeL, z: 0 }
  );

  // Gaze: iris centre offset relative to the eye corners, averaged across both eyes.
  const gaze = (iris: number, inner: number, outer: number, top: number, bottom: number) => {
    const c = p(iris);
    const a = p(inner);
    const b = p(outer);
    const t = p(top);
    const d = p(bottom);
    const w = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const h = Math.hypot(d.x - t.x, d.y - t.y) || 1;
    const mx = (a.x + b.x) / 2;
    const my = (t.y + d.y) / 2;
    return { x: ((c.x - mx) / w) * 2, y: ((c.y - my) / h) * 2 };
  };
  const hasIris = points.length >= 478 * 2;
  const gl = hasIris ? gaze(LM.LEFT_IRIS_CENTER, l.inner, l.outer, l.top1, l.bottom1) : { x: 0, y: 0 };
  const gr = hasIris ? gaze(LM.RIGHT_IRIS_CENTER, r.inner, r.outer, r.top1, r.bottom1) : { x: 0, y: 0 };

  const faceWidth = Math.hypot(eyeL.x - eyeR.x, eyeL.y - eyeR.y) * 1.9;
  const faceHeight = Math.hypot(chin.x - forehead.x, chin.y - forehead.y);

  return {
    earLeft,
    earRight,
    mar,
    mouthWidthRatio: neutralMouthWidth ? mouthWidth / neutralMouthWidth : 1,
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
    gazeX: clamp((gl.x + gr.x) / 2, -1, 1),
    gazeY: clamp((gl.y + gr.y) / 2, -1, 1),
    faceWidth,
    faceHeight,
    center: { x: (forehead.x + chin.x) / 2, y: (forehead.y + chin.y) / 2 },
  };
}

/**
 * Applies a "smile warmth" displacement to mouth-corner landmarks: pulls the corners up and
 * outward (positive bias) or down (negative bias) with a smooth radial falloff. Mutates `points`.
 */
export function applySmileBias(points: Float32Array, bias: number, faceWidth: number) {
  if (!bias) return;
  const radius = faceWidth * 0.16;
  const strength = bias * faceWidth * 0.045;
  const corners: Array<{ idx: number; dirX: number }> = [
    { idx: LM.MOUTH.cornerRight, dirX: -1 },
    { idx: LM.MOUTH.cornerLeft, dirX: 1 },
  ];
  const n = points.length / 2;
  for (const { idx, dirX } of corners) {
    const cx = points[idx * 2];
    const cy = points[idx * 2 + 1];
    for (let i = 0; i < n; i++) {
      const dx = points[i * 2] - cx;
      const dy = points[i * 2 + 1] - cy;
      const d = Math.hypot(dx, dy);
      if (d >= radius) continue;
      const w = 1 - d / radius;
      const f = w * w * (3 - 2 * w); // smoothstep
      points[i * 2] += dirX * strength * 0.5 * f;
      points[i * 2 + 1] -= strength * f;
    }
  }
}

/** Axis-aligned bounds of a flat point array. */
export function pointBounds(points: Float32Array) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Maps the user-facing "Movement Smoothness" (20..100) to 1-Euro filter parameters.
 * Low smoothness = high cutoff (responsive); high smoothness = low cutoff (steady).
 */
export function smoothingToFilterParams(smoothness: number): { minCutoff: number; beta: number } {
  const t = clamp((smoothness - 20) / 80, 0, 1);
  return {
    minCutoff: 4.5 - t * 3.7, // 4.5 Hz → 0.8 Hz
    beta: 0.08 - t * 0.06, // responsive to fast motion when smoothing is low
  };
}

/**
 * Anatomical speech mechanics: preserves mustache and upper lip structure during speech.
 * In natural human articulation, the maxilla (upper jaw) is rigidly anchored to the skull;
 * the mandible (lower jaw) drops down. This prevents the upper lip/mustache from stretching
 * down like melting wax while allowing the oral cavity to open naturally.
 */
export function applySpeechAnatomy(points: Float32Array, mar: number, faceHeight: number) {
  if (mar <= 0.04) return;
  const noseBaseY = points[LM.NOSE_TIP * 2 + 1];
  const maxUpperDescent = faceHeight * 0.015;

  // Upper lip & mustache landmarks: 0, 37, 267, 39, 269, 164, 2, 98, 327, 13
  const upperLipIndices = [0, 37, 267, 39, 269, 164, 2, 98, 327, 13];
  for (const idx of upperLipIndices) {
    const curY = points[idx * 2 + 1];
    const diff = curY - noseBaseY;
    // Dampen downward pulling of upper lip during speech
    if (diff > maxUpperDescent * 2.2) {
      points[idx * 2 + 1] = noseBaseY + maxUpperDescent * 2.2 + (diff - maxUpperDescent * 2.2) * 0.25;
    }
  }
}

/**
 * Natural eyelid kinematics: folds the persona's authentic eyelid down when blinking.
 * When the user blinks, the persona's actual eyelid skin folds down over the eye,
 * preventing hollow eye sockets or misaligned double-eyelids.
 */
export function applyEyelidKinematics(
  points: Float32Array,
  earLeft: number,
  earRight: number,
  blinkLeft: number,
  blinkRight: number
) {
  // Left eye (subject's left eye)
  const tL = clamp(Math.max((0.26 - earLeft) / 0.18, blinkLeft), 0, 1);
  if (tL > 0.08) {
    const pairs: Array<[number, number]> = [
      [387, 373],
      [385, 380],
      [386, 374],
      [384, 381],
      [398, 382],
    ];
    for (const [top, bot] of pairs) {
      const topY = points[top * 2 + 1];
      const botY = points[bot * 2 + 1];
      points[top * 2 + 1] = topY + (botY - topY) * tL * 0.88;
    }
  }

  // Right eye (subject's right eye)
  const tR = clamp(Math.max((0.26 - earRight) / 0.18, blinkRight), 0, 1);
  if (tR > 0.08) {
    const pairs: Array<[number, number]> = [
      [160, 144],
      [158, 153],
      [159, 145],
      [157, 154],
      [173, 155],
    ];
    for (const [top, bot] of pairs) {
      const topY = points[top * 2 + 1];
      const botY = points[bot * 2 + 1];
      points[top * 2 + 1] = topY + (botY - topY) * tR * 0.88;
    }
  }
}

/**
 * Neural gaze tracking: translates iris points according to real-time gaze vector.
 */
export function applyGazeIrisTracking(
  points: Float32Array,
  gazeX: number,
  gazeY: number,
  faceWidth: number
) {
  if (points.length < 478 * 2) return;
  const maxShiftX = faceWidth * 0.018;
  const maxShiftY = faceWidth * 0.012;
  const shiftX = clamp(gazeX, -1, 1) * maxShiftX;
  const shiftY = clamp(gazeY, -1, 1) * maxShiftY;

  const rightIris = [468, 469, 470, 471, 472];
  const leftIris = [473, 474, 475, 476, 477];

  for (const idx of rightIris) {
    points[idx * 2] += shiftX;
    points[idx * 2 + 1] += shiftY;
  }
  for (const idx of leftIris) {
    points[idx * 2] += shiftX;
    points[idx * 2 + 1] += shiftY;
  }
}

/**
 * 3D perspective foreshortening & multi-angle head pose compensation:
 * When turning head in yaw or pitch, anatomically adjusts landmark spacing
 * across cylindrical/spherical cranial profile so retreating cheek foreshortens
 * naturally rather than flattening in 2D.
 */
export function applyPerspectiveForeshortening(
  points: Float32Array,
  yawDeg: number,
  pitchDeg: number,
  faceWidth: number,
  faceHeight: number,
  center: Point2D
) {
  if (Math.abs(yawDeg) < 1.0 && Math.abs(pitchDeg) < 1.0) return;
  const yawRad = (yawDeg * Math.PI) / 180;
  const pitchRad = (pitchDeg * Math.PI) / 180;

  const sinYaw = Math.sin(yawRad);
  const cosYaw = Math.cos(yawRad);
  const sinPitch = Math.sin(pitchRad);

  const radiusX = faceWidth * 0.52;
  const radiusY = faceHeight * 0.55;
  const n = Math.min(468, points.length / 2);

  for (let i = 0; i < n; i++) {
    const px = points[i * 2];
    const py = points[i * 2 + 1];

    const dx = (px - center.x) / radiusX;
    const dy = (py - center.y) / radiusY;
    const rSq = dx * dx + dy * dy;

    // Approximate anatomical facial depth Z on ellipsoid profile
    const zNorm = Math.sqrt(Math.max(0, 1.0 - Math.min(1.0, rSq * 0.75)));
    const zDepth = zNorm * radiusX * 0.45;

    // 3D rotation foreshortening projection
    if (Math.abs(yawDeg) >= 1.0) {
      // Perspective compression along line of sight
      const foreshortenX = (dx * radiusX) * (cosYaw - 1.0) * 0.35 + zDepth * sinYaw * 0.42;
      points[i * 2] += foreshortenX;
    }

    if (Math.abs(pitchDeg) >= 1.0) {
      // Pitch tilt foreshortening (jaw / forehead foreshortening)
      const foreshortenY = zDepth * sinPitch * 0.38;
      points[i * 2 + 1] -= foreshortenY;
    }
  }
}


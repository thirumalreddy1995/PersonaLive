/**
 * Forehead and hairline alignment (R4b, flag foreheadExtension).
 *
 * MediaPipe's face oval tops out at landmarks 10/109/338, well below most hairlines, so the upper
 * forehead used to stay the wearer's own skin behind a stack of fades. Here the mesh is extended
 * from the upper face oval to the hairline with two rings of new vertices (indices after the 478
 * tracked points). The wearer's hairline is calibrated once from the R4 hair mask while the face
 * is frontal and stored per column as a ratio of the brow-to-landmark-10 distance; every frame
 * the extension vertices are placed from those ratios and the current landmarks, so the forehead
 * moves rigidly with the head and the per-frame hair mask is used for occlusion only. The persona
 * photo gets the same column ratios at load, so its brow-to-hairline span maps onto the wearer's.
 *
 * Everything here is pure (no DOM, no MediaPipe), for the unit tests.
 */
import type { FaceTopology } from './faceMesh.ts';

/** Upper face-oval points the hairline rays start from (subject's right to left). */
export const HAIRLINE_COLUMNS: ReadonlyArray<number> = [54, 103, 67, 109, 10, 338, 297, 332, 284];
/** Oval neighbours of the outer columns: the extension tapers to zero here, so the temples do not change. */
export const TEMPLE_ANCHOR_RIGHT = 21;
export const TEMPLE_ANCHOR_LEFT = 251;
/** Glabella and the top of the tracked mesh: the forehead axis runs from one to the other. */
export const GLABELLA = 9;
export const FOREHEAD_TOP = 10;

/** Tracked points per face (468 mesh + 10 iris); the extension vertices follow them. */
export const TRACKED_POINT_COUNT = 478;
export const EXT_COLUMNS = HAIRLINE_COLUMNS.length;
export const EXT_MID_START = TRACKED_POINT_COUNT;
export const EXT_HAIR_START = TRACKED_POINT_COUNT + EXT_COLUMNS;
export const EXT_VERTEX_COUNT = TRACKED_POINT_COUNT + 2 * EXT_COLUMNS;

/**
 * Hairline ratio = (brow → hairline) / (brow → landmark 10) along the forehead axis, so 1 puts
 * the hairline on the face oval and the default 1.4 puts it 40% of the brow-to-10 span above it.
 */
export const DEFAULT_HAIRLINE_RATIO = 1.4;
export const MIN_HAIRLINE_RATIO = 1;
export const MAX_HAIRLINE_RATIO = 2.2;
/** Stretch guard: the wearer's forehead may be this much shorter or taller than the persona's before the mapping is clamped. */
export const STRETCH_MIN = 0.75;
export const STRETCH_MAX = 1.35;

/**
 * Calibration: frontal band, dwell before sampling, samples per calibration, recalibration trigger.
 * The pitch band is wider than the yaw band: a laptop camera sits below the face, so a wearer
 * looking straight at the screen reads −6° to −10° of pitch, and pitch moves the hairline and the
 * brow-to-10 span together (the ratio barely changes), while yaw hides one side of the hairline.
 */
export const HAIRLINE_FRONTAL_DEG = 10;
export const HAIRLINE_FRONTAL_PITCH_DEG = 18;
export const HAIRLINE_DWELL_MS = 400;
export const HAIRLINE_SAMPLES = 12;
/** Leaving the frontal band for at most this long (a tracker glitch, a blink of pose noise) does not restart a calibration. */
export const HAIRLINE_GLITCH_MS = 250;
/** A mask measurement counts as a sample only with at least this many measured columns (a hand or hair across the forehead does not). */
export const HAIRLINE_MIN_COLUMNS = 5;
/** Contour continuity: an interior column may sit at most this far (in ratio units) below the mean of its neighbours, an end column below its neighbour. */
export const HAIRLINE_MAX_DIP = 0.05;
export const HAIRLINE_MAX_END_DROP = 0.4;
export const HAIRLINE_DISAGREE_SHARE = 0.05;
export const HAIRLINE_DISAGREE_MS = 3000;

export interface ForeheadFrame {
  /** Unit vector from the glabella to landmark 10 (follows head roll). */
  ax: number;
  ay: number;
  /** Brow-to-landmark-10 distance in the points' units. */
  span: number;
}

/** The local forehead axis and span of a flat [x, y, ...] landmark array; null when degenerate. */
export function foreheadFrame(points: ArrayLike<number>): ForeheadFrame | null {
  const dx = points[FOREHEAD_TOP * 2] - points[GLABELLA * 2];
  const dy = points[FOREHEAD_TOP * 2 + 1] - points[GLABELLA * 2 + 1];
  const span = Math.hypot(dx, dy);
  if (!Number.isFinite(span) || span < 1e-6) return null;
  return { ax: dx / span, ay: dy / span, span };
}

/**
 * Writes the mid-forehead ring (50% of the way to the hairline) and the hairline ring into
 * `points` at EXT_MID_START / EXT_HAIR_START. `ratios` are per column; `strength` (0..1) scales
 * the extension so it can grow in smoothly once the calibration lands. `aspect` is the y/x unit
 * ratio of the points' space (1 for pixels; texture height / width for normalised UVs), so the
 * axis and span are measured in square units. Returns false when the frame is degenerate (the
 * extension then collapses onto the oval).
 */
export function extendForehead(points: Float32Array, ratios: ArrayLike<number>, strength = 1, aspect = 1): boolean {
  if (points.length < EXT_VERTEX_COUNT * 2) throw new Error(`extendForehead needs ${EXT_VERTEX_COUNT * 2} values, got ${points.length}`);
  const dx = points[FOREHEAD_TOP * 2] - points[GLABELLA * 2];
  const dy = (points[FOREHEAD_TOP * 2 + 1] - points[GLABELLA * 2 + 1]) * aspect;
  const span = Math.hypot(dx, dy);
  const ok = Number.isFinite(span) && span >= 1e-6;
  const ax = ok ? dx / span : 0;
  const ay = ok ? dy / span : 0;
  const s = Math.min(1, Math.max(0, strength));
  const fold = ok ? foldWeights(points, ax, ay, span, aspect) : null;
  for (let c = 0; c < EXT_COLUMNS; c++) {
    const o = HAIRLINE_COLUMNS[c];
    const bx = points[o * 2];
    const by = points[o * 2 + 1];
    const r = Math.min(MAX_HAIRLINE_RATIO, Math.max(MIN_HAIRLINE_RATIO, Number.isFinite(ratios[c]) ? ratios[c] : MIN_HAIRLINE_RATIO));
    const ext = fold ? (r - 1) * span * s * fold[c] : 0;
    points[(EXT_MID_START + c) * 2] = bx + ax * ext * 0.5;
    points[(EXT_MID_START + c) * 2 + 1] = by + (ay * ext * 0.5) / aspect;
    points[(EXT_HAIR_START + c) * 2] = bx + ax * ext;
    points[(EXT_HAIR_START + c) * 2 + 1] = by + (ay * ext) / aspect;
  }
  return ok;
}

/**
 * An upper-oval edge counts as folded when its outer end is less than this share of the
 * brow-to-10 span further out than its inner end (frontal edges advance by ~0.5 spans).
 */
export const FOLD_FADE_SPAN = 0.12;

/**
 * Per-column weight in [0, 1] that takes the extension away where the upper oval folds over at
 * the far silhouette of a turned head (from ~30° of yaw the far temple and then the far columns
 * pass behind their inner neighbours). The extension rays are parallel, so its triangles keep
 * their orientation exactly as long as the oval points keep their order across the forehead axis;
 * a column next to a folded oval edge gets no extension, which leaves the triangles on that edge
 * with zero area instead of flipped.
 */
export function foldWeights(points: ArrayLike<number>, ax: number, ay: number, span: number, aspect = 1): number[] {
  const chain = [TEMPLE_ANCHOR_RIGHT, ...HAIRLINE_COLUMNS, TEMPLE_ANCHOR_LEFT];
  const centre = (chain.length - 1) / 2;
  // Position across the axis, in spans, relative to landmark 10.
  const across = chain.map((v) => ((points[v * 2] - points[FOREHEAD_TOP * 2]) * -ay + (points[v * 2 + 1] - points[FOREHEAD_TOP * 2 + 1]) * aspect * ax) / span);
  // Which way the subject's right side lies (depends on mirroring): from the columns next to the centre, which never fold.
  const side = Math.sign(across[centre - 1] - across[centre + 1]) || 1;
  const edge: number[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    // Outward advance of the edge's outer end over its inner end.
    const advance = i < centre ? (across[i] - across[i + 1]) * side : (across[i + 1] - across[i]) * -side;
    const t = Math.min(1, Math.max(0, advance / FOLD_FADE_SPAN));
    edge.push(t * t * (3 - 2 * t));
  }
  const out: number[] = [];
  for (let c = 0; c < EXT_COLUMNS; c++) out.push(Math.min(edge[c], edge[c + 1]));
  return out;
}

/** What a hairline ray sees at a point: hair and skin confidence (0..1), or null outside the mask. */
export type HairlineSampler = (x: number, y: number) => { hair: number; skin: number } | null;

export interface MeasureOptions {
  /**
   * A ray that starts inside hair: 'zero' reports the hairline on the oval (the wearer's fringe:
   * the persona must end there); 'ambiguous' reports null (a persona photo: the fringe is inpainted
   * and the column takes its neighbours' ratio).
   */
  startsInHair?: 'zero' | 'ambiguous';
  /** Steps along each ray (the ray spans MAX_HAIRLINE_RATIO − 1 of the brow-to-10 span). */
  steps?: number;
  /** y/x unit ratio of the points' space (see extendForehead). */
  aspect?: number;
}

/**
 * Casts a ray from each upper-oval column along the forehead axis and reports where skin turns
 * into hair as a hairline ratio. A column is null (ambiguous) when the ray leaves the mask, runs
 * into neither-skin-nor-hair (background, a hat) or never meets hair (bald, cropped photo).
 */
export function measureHairlineRatios(points: ArrayLike<number>, sample: HairlineSampler, opts: MeasureOptions = {}): Array<number | null> {
  const aspect = opts.aspect ?? 1;
  const steps = Math.max(8, opts.steps ?? 48);
  const out: Array<number | null> = new Array(EXT_COLUMNS).fill(null);
  const dx = points[FOREHEAD_TOP * 2] - points[GLABELLA * 2];
  const dy = (points[FOREHEAD_TOP * 2 + 1] - points[GLABELLA * 2 + 1]) * aspect;
  const span = Math.hypot(dx, dy);
  if (!Number.isFinite(span) || span < 1e-6) return out;
  const ax = dx / span;
  const ay = dy / span / aspect;
  const reach = (MAX_HAIRLINE_RATIO - 1) * span;
  for (let c = 0; c < EXT_COLUMNS; c++) {
    const o = HAIRLINE_COLUMNS[c];
    const bx = points[o * 2];
    const by = points[o * 2 + 1];
    let prevHair = 0;
    let gap = 0;
    let found: number | null = null;
    let ambiguous = false;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * reach;
      const s = sample(bx + ax * t, by + ay * t);
      if (!s) {
        ambiguous = true;
        break;
      }
      if (s.hair >= 0.5) {
        // Confirm with the next step so one noisy mask texel is not a hairline.
        const tn = (Math.min(steps, i + 1) / steps) * reach;
        const next = i < steps ? sample(bx + ax * tn, by + ay * tn) : s;
        if (next && next.hair >= 0.5) {
          if (i <= 1) {
            found = 0;
          } else {
            // Sub-step position of the 0.5 crossing between the previous sample and this one.
            const f = s.hair - prevHair > 1e-6 ? (0.5 - prevHair) / (s.hair - prevHair) : 1;
            found = ((i - 1 + Math.min(1, Math.max(0, f))) / steps) * reach;
          }
          break;
        }
      } else if (s.skin < 0.3) {
        if (++gap >= 3) {
          ambiguous = true;
          break;
        }
      } else {
        gap = 0;
      }
      prevHair = s.hair;
    }
    if (ambiguous || found === null) continue;
    if (found === 0 && (opts.startsInHair ?? 'zero') === 'ambiguous') continue;
    out[c] = Math.min(MAX_HAIRLINE_RATIO, 1 + found / span);
  }
  return out;
}

/**
 * Fills ambiguous columns by linear interpolation between the nearest measured neighbours (the
 * nearest one at the ends); with nothing measured every column takes the default ratio.
 */
export function fillAmbiguousRatios(ratios: ArrayLike<number | null>, fallback = DEFAULT_HAIRLINE_RATIO): number[] {
  const n = ratios.length;
  const out = new Array<number>(n).fill(fallback);
  const known: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = ratios[i];
    if (r !== null && Number.isFinite(r)) known.push(i);
  }
  if (!known.length) return out;
  for (let i = 0; i < n; i++) {
    const r = ratios[i];
    if (r !== null && Number.isFinite(r)) {
      out[i] = r;
      continue;
    }
    let lo = -1;
    let hi = -1;
    for (const k of known) {
      if (k < i) lo = k;
      else if (k > i && hi < 0) hi = k;
    }
    if (lo >= 0 && hi >= 0) out[i] = (ratios[lo] as number) + (((ratios[hi] as number) - (ratios[lo] as number)) * (i - lo)) / (hi - lo);
    else out[i] = ratios[lo >= 0 ? lo : hi] as number;
  }
  return out;
}

/**
 * Keeps the hairline contour continuous across the columns (R4b fix): a 3-tap median removes a
 * single-column outlier, then no interior column may dip more than HAIRLINE_MAX_DIP below the mean
 * of its neighbours and no end column more than HAIRLINE_MAX_END_DROP below its neighbour. Dips
 * are raised, never the reverse: a ring that runs a little into the hair is removed there by the
 * hair mask, while a ring below the hairline leaves a notch of the wearer's own skin.
 */
export function smoothHairlineRatios(ratios: ArrayLike<number>): number[] {
  const n = ratios.length;
  const r = Array.from({ length: n }, (_, i) => ratios[i]);
  if (n < 3) return r;
  const m = r.map((v, i) => (i === 0 || i === n - 1 ? v : median([r[i - 1], v, r[i + 1]])));
  const out = [...m];
  // Two passes so a raised column can support its neighbour.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n - 1; i++) out[i] = Math.max(out[i], (out[i - 1] + out[i + 1]) / 2 - HAIRLINE_MAX_DIP);
  }
  out[0] = Math.max(out[0], out[1] - HAIRLINE_MAX_END_DROP);
  out[n - 1] = Math.max(out[n - 1], out[n - 2] - HAIRLINE_MAX_END_DROP);
  return out.map((v) => Math.min(MAX_HAIRLINE_RATIO, Math.max(MIN_HAIRLINE_RATIO, v)));
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Per-column median over the samples; a column measured in fewer than half of them is ambiguous. */
export function medianRatios(samples: ReadonlyArray<ArrayLike<number | null>>): Array<number | null> {
  const out: Array<number | null> = new Array(EXT_COLUMNS).fill(null);
  for (let c = 0; c < EXT_COLUMNS; c++) {
    const vals: number[] = [];
    for (const s of samples) {
      const r = s[c];
      if (r !== null && Number.isFinite(r)) vals.push(r);
    }
    if (vals.length && vals.length * 2 >= samples.length) out[c] = median(vals);
  }
  return out;
}

/**
 * Stretch guard (R4b §3), per column: where the wearer's forehead is taller than `max` × the
 * persona's, the wearer-side extension stops at that limit (the colour-matched real skin shows in
 * the sliver below the hairline); where it is shorter than `min` × the persona's, the persona-side
 * span is cut to wearer / min (the top of the persona's forehead is not used) instead of squashing
 * the texture. Heights are the hairline ratios, i.e. relative to each face's own brow-to-10 span.
 */
export function stretchClamp(wearer: ArrayLike<number>, persona: ArrayLike<number>, min = STRETCH_MIN, max = STRETCH_MAX): { wearer: number[]; persona: number[]; clamped: number } {
  const w: number[] = [];
  const p: number[] = [];
  let clamped = 0;
  for (let c = 0; c < EXT_COLUMNS; c++) {
    const rw = Math.max(MIN_HAIRLINE_RATIO, wearer[c]);
    const rp = Math.max(MIN_HAIRLINE_RATIO, persona[c]);
    const we = Math.min(rw, max * rp);
    const pe = Math.min(rp, rw / min);
    if (we < rw - 1e-9 || pe < rp - 1e-9) clamped++;
    w.push(we);
    p.push(pe);
  }
  return { wearer: w, persona: p, clamped };
}

/** The frontal band of the calibration: |yaw| under HAIRLINE_FRONTAL_DEG and |pitch| under HAIRLINE_FRONTAL_PITCH_DEG. */
export function isHairlineFrontal(yaw: number, pitch: number): boolean {
  return Math.abs(yaw) < HAIRLINE_FRONTAL_DEG && Math.abs(pitch) < HAIRLINE_FRONTAL_PITCH_DEG;
}

export interface HairlineSampleInfo {
  /** Inside the frontal band (isHairlineFrontal). */
  frontal: boolean;
  /** Milliseconds, monotonic. */
  t: number;
  /** Brow-to-10 span over face height, to express a ratio disagreement as a share of face height. */
  spanOverFaceHeight: number;
}

/**
 * Wearer hairline calibration (R4b §1): once the face has been frontal for HAIRLINE_DWELL_MS, the
 * per-column median of HAIRLINE_SAMPLES mask measurements, made continuous across the columns,
 * becomes the stored ratios (about 1.5 s at ten masks a second). They are not touched per frame.
 * Leaving the frontal band for up to HAIRLINE_GLITCH_MS, or a measurement with too few columns
 * (a hand across the forehead), pauses the collection instead of restarting it. While frontal, a
 * disagreement with the hair mask of more than 5% of face height for over 3 s starts a new
 * calibration (the stored ratios stay in use until it completes).
 */
export class HairlineCalibrator {
  private stored: number[] | null = null;
  private samples: Array<Array<number | null>> = [];
  private frontalSince: number | null = null;
  private offSince: number | null = null;
  private disagreeSince: number | null = null;
  private collecting = true;
  /** Bumps whenever the stored ratios change. */
  public version = 0;
  /** Completed calibrations since the last reset. */
  public calibrations = 0;
  /** Last measured disagreement with the mask, as a share of face height (diagnostic). */
  public lastDisagreement: number | null = null;

  /** The calibrated per-column ratios, or null before the first calibration. */
  get ratios(): number[] | null {
    return this.stored;
  }

  get isCollecting(): boolean {
    return this.collecting;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Forgets everything (new source, face lost). */
  reset() {
    this.stored = null;
    this.samples = [];
    this.frontalSince = null;
    this.offSince = null;
    this.disagreeSince = null;
    this.collecting = true;
    this.calibrations = 0;
    this.lastDisagreement = null;
    this.version++;
  }

  /** Starts a new calibration; the current ratios stay in use until it completes ("Recalibrate forehead"). */
  recalibrate() {
    this.samples = [];
    this.collecting = true;
    this.disagreeSince = null;
  }

  /**
   * Feeds one frame. `sample` is a fresh mask measurement (measureHairlineRatios) or null when the
   * masks did not change this frame. Returns true when the stored ratios changed.
   */
  push(sample: ArrayLike<number | null> | null, info: HairlineSampleInfo): boolean {
    if (!info.frontal) {
      if (this.offSince === null) this.offSince = info.t;
      // A brief excursion (tracker glitch, pose noise at the edge of the band) only pauses the hold.
      if (info.t - this.offSince <= HAIRLINE_GLITCH_MS) return false;
      this.frontalSince = null;
      this.disagreeSince = null;
      // A calibration is one frontal hold: really leaving the frontal band restarts it.
      if (this.collecting) this.samples = [];
      return false;
    }
    this.offSince = null;
    if (this.frontalSince === null) this.frontalSince = info.t;
    if (info.t - this.frontalSince < HAIRLINE_DWELL_MS || !sample) return false;

    if (this.collecting) {
      // An occluded forehead (hand, hair pushed across) is not a sample, and not a reason to start over.
      let measured = 0;
      for (let c = 0; c < EXT_COLUMNS; c++) if (sample[c] !== null && Number.isFinite(sample[c])) measured++;
      if (measured < HAIRLINE_MIN_COLUMNS) return false;
      this.samples.push(Array.from(sample));
      if (this.samples.length < HAIRLINE_SAMPLES) return false;
      this.stored = smoothHairlineRatios(fillAmbiguousRatios(medianRatios(this.samples)));
      this.samples = [];
      this.collecting = false;
      this.disagreeSince = null;
      this.calibrations++;
      this.version++;
      return true;
    }

    // Calibrated: watch for a lasting disagreement with the mask (hair pushed back, a new haircut, a hat).
    const stored = this.stored!;
    const diffs: number[] = [];
    for (let c = 0; c < EXT_COLUMNS; c++) {
      const r = sample[c];
      if (r !== null && Number.isFinite(r)) diffs.push(Math.abs(r - stored[c]) * info.spanOverFaceHeight);
    }
    if (!diffs.length) return false;
    const d = median(diffs);
    this.lastDisagreement = d;
    if (d > HAIRLINE_DISAGREE_SHARE) {
      if (this.disagreeSince === null) this.disagreeSince = info.t;
      else if (info.t - this.disagreeSince > HAIRLINE_DISAGREE_MS) this.recalibrate();
    } else {
      this.disagreeSince = null;
    }
    return false;
  }
}

/**
 * Foreshortening weights for the extended topology (R4b fix). The extension's triangles must not
 * take part: collapsed (not calibrated yet) or folded away at the far silhouette they have zero
 * screen area against a non-zero persona UV area, which read as "fully foreshortened" and faded
 * the upper oval vertices, and with them the persona's forehead. The weights therefore come from
 * the base triangles only (`weights` is the base computation over the extended vertex count) and
 * each ring vertex takes its column's weight.
 */
export function copyColumnWeights(weights: Float32Array): Float32Array {
  if (weights.length < EXT_VERTEX_COUNT) return weights;
  for (let c = 0; c < EXT_COLUMNS; c++) {
    const w = weights[HAIRLINE_COLUMNS[c]];
    weights[EXT_MID_START + c] = w;
    weights[EXT_HAIR_START + c] = w;
  }
  return weights;
}

/** Triangles of the extension (oval → mid ring → hairline ring, plus a wedge to each temple anchor). */
export function foreheadExtensionTriangles(): number[] {
  const tris: number[] = [];
  const o = (c: number) => HAIRLINE_COLUMNS[c];
  const m = (c: number) => EXT_MID_START + c;
  const h = (c: number) => EXT_HAIR_START + c;
  for (let c = 0; c + 1 < EXT_COLUMNS; c++) {
    tris.push(o(c), o(c + 1), m(c + 1), o(c), m(c + 1), m(c));
    tris.push(m(c), m(c + 1), h(c + 1), m(c), h(c + 1), h(c));
  }
  const last = EXT_COLUMNS - 1;
  tris.push(TEMPLE_ANCHOR_RIGHT, o(0), m(0), TEMPLE_ANCHOR_RIGHT, m(0), h(0));
  tris.push(o(last), TEMPLE_ANCHOR_LEFT, m(last), m(last), TEMPLE_ANCHOR_LEFT, h(last));
  return tris;
}

/** Feather of a forehead vertex by its ring distance from the nearest non-forehead oval vertex. */
function foreheadFeather(d: number): number {
  return d <= 0 ? 0 : d === 1 ? 0.6 : 1;
}

/**
 * The face topology with the forehead extension: EXT_VERTEX_COUNT vertices, the extension
 * triangles appended, and `forehead` (two floats per vertex): [0] the feather weight to use while
 * the extension is active (the forehead is opaque from the brows to the hairline ring; only the
 * outer columns keep a taper toward the temples), [1] the hairline coordinate (0 on the tracked
 * mesh, 0.5 on the mid ring, 1 on the hairline ring) the shader feathers at. The base feather
 * weights are kept as they are, so with the extension inactive the output is the base topology's.
 */
export function extendTopology(base: FaceTopology): FaceTopology {
  const n = EXT_VERTEX_COUNT;
  const baseN = base.vertexCount;
  const pad = (src: Float32Array, fill: number) => {
    const out = new Float32Array(n).fill(fill);
    out.set(src.subarray(0, Math.min(src.length, n)));
    return out;
  };
  const padI = (src: Int16Array, fill: number) => {
    const out = new Int16Array(n).fill(fill);
    out.set(src.subarray(0, Math.min(src.length, n)));
    return out;
  };

  // Ring distance from the oval vertices that are not hairline columns.
  const adjacency: Array<number[]> = Array.from({ length: baseN }, () => []);
  for (let i = 0; i < base.triangles.length; i += 3) {
    const t = [base.triangles[i], base.triangles[i + 1], base.triangles[i + 2]];
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[0], t[2]]]) {
      adjacency[a].push(b);
      adjacency[b].push(a);
    }
  }
  const isColumn = new Uint8Array(baseN);
  for (const c of HAIRLINE_COLUMNS) isColumn[c] = 1;
  const d2 = new Int16Array(baseN).fill(-1);
  const queue: number[] = [];
  for (let v = 0; v < baseN; v++) {
    if (base.ovalRingDistance[v] === 0 && !isColumn[v]) {
      d2[v] = 0;
      queue.push(v);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    for (const nb of adjacency[v]) {
      if (d2[nb] === -1) {
        d2[nb] = d2[v] + 1;
        queue.push(nb);
      }
    }
  }

  const forehead = new Float32Array(n * 2);
  for (let v = 0; v < baseN; v++) {
    const d = base.ovalRingDistance[v];
    const f = base.featherWeights[v];
    // Forehead vertices are those whose nearest oval vertex is a hairline column.
    forehead[v * 2] = d >= 0 && d2[v] > d ? Math.max(f, foreheadFeather(d2[v])) : f;
  }
  for (let c = 0; c < EXT_COLUMNS; c++) {
    const f = forehead[HAIRLINE_COLUMNS[c] * 2];
    forehead[(EXT_MID_START + c) * 2] = f;
    forehead[(EXT_MID_START + c) * 2 + 1] = 0.5;
    forehead[(EXT_HAIR_START + c) * 2] = f;
    forehead[(EXT_HAIR_START + c) * 2 + 1] = 1;
  }

  const triangles = new Uint16Array(base.triangles.length + foreheadExtensionTriangles().length);
  triangles.set(base.triangles);
  triangles.set(foreheadExtensionTriangles(), base.triangles.length);

  const featherWeights = pad(base.featherWeights, 0);
  const lipWeights = pad(base.lipWeights, 0);
  const lipZones = pad(base.lipZones, 3);
  const eyeRingDistance = padI(base.eyeRingDistance, -1);
  // The extension is face boundary: full tone match toward the wearer and gated by the face-skin mask.
  const ovalRingDistance = padI(base.ovalRingDistance, -1);
  for (let v = EXT_MID_START; v < n; v++) ovalRingDistance[v] = 0;

  return { triangles, eyeTriangles: base.eyeTriangles, featherWeights, lipWeights, lipZones, eyeRingDistance, ovalRingDistance, vertexCount: n, forehead };
}

/** A flat landmark array (≥ 468 points) copied into an EXT_VERTEX_COUNT-sized one (extension slots zero). */
export function padPoints(points: ArrayLike<number>): Float32Array {
  const out = new Float32Array(EXT_VERTEX_COUNT * 2);
  const n = Math.min(points.length, TRACKED_POINT_COUNT * 2);
  for (let i = 0; i < n; i++) out[i] = points[i];
  return out;
}

/** The forehead polygon (upper oval columns, then the hairline ring back) of an extended point array. */
export function foreheadPolygon(points: ArrayLike<number>): Array<{ x: number; y: number }> {
  const poly: Array<{ x: number; y: number }> = [];
  for (let c = 0; c < EXT_COLUMNS; c++) poly.push({ x: points[HAIRLINE_COLUMNS[c] * 2], y: points[HAIRLINE_COLUMNS[c] * 2 + 1] });
  for (let c = EXT_COLUMNS - 1; c >= 0; c--) poly.push({ x: points[(EXT_HAIR_START + c) * 2], y: points[(EXT_HAIR_START + c) * 2 + 1] });
  return poly;
}

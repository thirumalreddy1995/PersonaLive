import test from 'node:test';
import assert from 'node:assert/strict';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { buildFaceTopology } from './faceMesh.ts';
import { CANONICAL_FACE_MODEL } from './canonicalFaceModel.ts';
import { foreshortenWeights } from './foreshorten.ts';
import {
  DEFAULT_HAIRLINE_RATIO,
  EXT_COLUMNS,
  EXT_HAIR_START,
  EXT_MID_START,
  EXT_VERTEX_COUNT,
  FOREHEAD_TOP,
  GLABELLA,
  HAIRLINE_COLUMNS,
  HAIRLINE_SAMPLES,
  HairlineCalibrator,
  MAX_HAIRLINE_RATIO,
  TEMPLE_ANCHOR_LEFT,
  TEMPLE_ANCHOR_RIGHT,
  extendForehead,
  extendTopology,
  foldWeights,
  fillAmbiguousRatios,
  foreheadExtensionTriangles,
  foreheadFrame,
  foreheadPolygon,
  measureHairlineRatios,
  medianRatios,
  padPoints,
  stretchClamp,
  type HairlineSampler,
} from './foreheadExtension.ts';

const TESSELLATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
const OVAL = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** The canonical face model rotated (degrees) and projected orthographically to pixels (y down), padded for the extension. */
function face(yaw = 0, pitch = 0, roll = 0, scale = 20, cx = 320, cy = 260): Float32Array {
  const [sy, cyw] = [Math.sin(rad(yaw)), Math.cos(rad(yaw))];
  const [sp, cp] = [Math.sin(rad(pitch)), Math.cos(rad(pitch))];
  const [sr, cr] = [Math.sin(rad(roll)), Math.cos(rad(roll))];
  const pts = new Float32Array(EXT_VERTEX_COUNT * 2);
  for (let i = 0; i < 468; i++) {
    const x = CANONICAL_FACE_MODEL[i * 3], y = CANONICAL_FACE_MODEL[i * 3 + 1], z = CANONICAL_FACE_MODEL[i * 3 + 2];
    // Pitch about x, then yaw about y, then roll about z.
    const y1 = y * cp - z * sp, z1 = y * sp + z * cp;
    const x2 = x * cyw + z1 * sy;
    const x3 = x2 * cr - y1 * sr, y3 = x2 * sr + y1 * cr;
    pts[i * 2] = cx + x3 * scale;
    pts[i * 2 + 1] = cy - y3 * scale;
  }
  return pts;
}

const RATIOS = [1.25, 1.35, 1.45, 1.5, 1.5, 1.5, 1.45, 1.35, 1.25];

function signedArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  return ((p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[c * 2] - p[a * 2]) * (p[b * 2 + 1] - p[a * 2 + 1])) / 2;
}

test('extendForehead places the mid and hairline rings along the glabella-to-10 axis from the stored ratios', () => {
  const pts = face();
  const frame = foreheadFrame(pts)!;
  // Frontal: the axis points straight up the image.
  assert.ok(Math.abs(frame.ax) < 1e-6 && frame.ay < -0.999);
  assert.equal(extendForehead(pts, RATIOS), true);
  for (let c = 0; c < EXT_COLUMNS; c++) {
    const o = HAIRLINE_COLUMNS[c];
    const ext = (RATIOS[c] - 1) * frame.span;
    assert.ok(Math.abs(pts[(EXT_HAIR_START + c) * 2] - pts[o * 2]) < 1e-3, `column ${c} x`);
    assert.ok(Math.abs(pts[(EXT_HAIR_START + c) * 2 + 1] - (pts[o * 2 + 1] - ext)) < 1e-3, `column ${c} hairline`);
    assert.ok(Math.abs(pts[(EXT_MID_START + c) * 2 + 1] - (pts[o * 2 + 1] - ext / 2)) < 1e-3, `column ${c} mid ring`);
  }
  // Strength scales the extension; 0 collapses it onto the oval.
  const half = face();
  extendForehead(half, RATIOS, 0.5);
  assert.ok(Math.abs(half[(EXT_HAIR_START + 4) * 2 + 1] - (half[10 * 2 + 1] - (RATIOS[4] - 1) * frame.span * 0.5)) < 1e-3);
  const none = face();
  extendForehead(none, RATIOS, 0);
  for (let c = 0; c < EXT_COLUMNS; c++) assert.equal(none[(EXT_HAIR_START + c) * 2 + 1], none[HAIRLINE_COLUMNS[c] * 2 + 1]);
  assert.throws(() => extendForehead(new Float32Array(478 * 2), RATIOS));
});

test('the extension follows head roll, pitch and yaw rigidly: the ratio along the axis is the stored one', () => {
  for (const [yaw, pitch, roll] of [[0, 0, 15], [0, 0, -20], [0, 20, 0], [0, -20, 0], [30, 0, 0], [-40, 10, 10]]) {
    const pts = face(yaw, pitch, roll);
    const frame = foreheadFrame(pts)!;
    extendForehead(pts, RATIOS);
    const fold = foldWeights(pts, frame.ax, frame.ay, frame.span);
    // Up to 20° of yaw nothing folds; beyond it only far-side columns lose their extension.
    if (Math.abs(yaw) <= 20) assert.deepEqual(fold, new Array(EXT_COLUMNS).fill(1));
    for (let c = 0; c < EXT_COLUMNS; c++) {
      const o = HAIRLINE_COLUMNS[c];
      const dx = pts[(EXT_HAIR_START + c) * 2] - pts[o * 2];
      const dy = pts[(EXT_HAIR_START + c) * 2 + 1] - pts[o * 2 + 1];
      // Along the axis by (ratio − 1) spans (times the fold weight), nothing across it.
      assert.ok(Math.abs((dx * frame.ax + dy * frame.ay) / frame.span - (RATIOS[c] - 1) * fold[c]) < 1e-4, `pose ${yaw}/${pitch}/${roll} column ${c}`);
      assert.ok(Math.abs(dx * frame.ay - dy * frame.ax) < 1e-3);
    }
  }
  // Roll: the extension of a rolled face is the frontal extension rotated with it.
  const frontal = face();
  extendForehead(frontal, RATIOS);
  const rolled = face(0, 0, 20);
  extendForehead(rolled, RATIOS);
  const [s, c] = [Math.sin(rad(20)), Math.cos(rad(20))];
  for (let i = EXT_MID_START; i < EXT_VERTEX_COUNT; i++) {
    const x = frontal[i * 2] - 320, y = -(frontal[i * 2 + 1] - 260);
    assert.ok(Math.abs(rolled[i * 2] - (320 + x * c - y * s)) < 1e-2);
    assert.ok(Math.abs(rolled[i * 2 + 1] - (260 - (x * s + y * c))) < 1e-2);
  }
});

test('a degenerate forehead frame collapses the extension instead of producing NaN', () => {
  const pts = face();
  pts[FOREHEAD_TOP * 2] = pts[GLABELLA * 2];
  pts[FOREHEAD_TOP * 2 + 1] = pts[GLABELLA * 2 + 1];
  assert.equal(foreheadFrame(pts), null);
  assert.equal(extendForehead(pts, RATIOS), false);
  for (let i = EXT_MID_START * 2; i < EXT_VERTEX_COUNT * 2; i++) assert.ok(Number.isFinite(pts[i]));
  assert.equal(pts[(EXT_HAIR_START + 4) * 2 + 1], pts[10 * 2 + 1]);
});

test('no extension triangle flips across yaw ±40°, pitch ±25°, roll ±20°', () => {
  const tris = foreheadExtensionTriangles();
  const rest = face();
  extendForehead(rest, RATIOS);
  const restSign = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = signedArea(rest, tris[i], tris[i + 1], tris[i + 2]);
    assert.ok(Math.abs(a) > 1e-3, `rest triangle ${i / 3} is degenerate`);
    restSign.push(Math.sign(a));
  }
  for (const yaw of [-40, -20, 0, 20, 40]) {
    for (const pitch of [-25, -12, 0, 12, 25]) {
      for (const roll of [-20, 0, 20]) {
        const pts = face(yaw, pitch, roll);
        extendForehead(pts, RATIOS);
        for (let i = 0; i < tris.length; i += 3) {
          const a = signedArea(pts, tris[i], tris[i + 1], tris[i + 2]);
          // Never the opposite orientation; zero area (a column collapsed at the far silhouette) draws nothing.
          assert.ok(a * restSign[i / 3] >= -1e-3, `triangle ${i / 3} flipped at yaw ${yaw} pitch ${pitch} roll ${roll} (area ${a})`);
          if (Math.abs(yaw) <= 20) assert.ok(a * restSign[i / 3] > 1e-3, `triangle ${i / 3} degenerate at yaw ${yaw} pitch ${pitch} roll ${roll}`);
        }
      }
    }
  }
});

test('foldWeights removes the extension only at the far silhouette of a turned head, on either side and mirrored', () => {
  const at = (yaw: number, mirror = false) => {
    const pts = face(yaw);
    if (mirror) for (let i = 0; i < 468; i++) pts[i * 2] = 640 - pts[i * 2];
    const f = foreheadFrame(pts)!;
    return foldWeights(pts, f.ax, f.ay, f.span);
  };
  assert.deepEqual(at(0), new Array(EXT_COLUMNS).fill(1));
  assert.deepEqual(at(0, true), new Array(EXT_COLUMNS).fill(1));
  for (const mirror of [false, true]) {
    const neg = at(-40, mirror);
    const pos = at(40, mirror);
    // One side of the forehead keeps its full extension, the other loses its outer columns.
    assert.deepEqual(neg.slice(4), [1, 1, 1, 1, 1]);
    assert.equal(neg[0], 0);
    assert.equal(neg[1], 0);
    assert.deepEqual(pos.slice(0, 5), [1, 1, 1, 1, 1]);
    assert.equal(pos[8], 0);
    assert.equal(pos[7], 0);
    // The centre columns are never affected.
    assert.equal(neg[3], 1);
    assert.equal(pos[5], 1);
  }
  // The weight falls smoothly with the turn.
  let prev = 1;
  for (const yaw of [0, 10, 20, 25, 30, 35, 40]) {
    const w = at(yaw)[8];
    assert.ok(w <= prev + 1e-9, `yaw ${yaw}: ${w} after ${prev}`);
    prev = w;
  }
  assert.equal(prev, 0);
});

/** A synthetic mask: skin below a hairline `rise(x)` pixels above each column's oval point, hair above it for `hairDepth` pixels, then background. */
function maskSampler(pts: Float32Array, rise: (x: number) => number, hairDepth = 1e6): HairlineSampler {
  // The oval top as a function of x, through the hairline columns (frontal faces only).
  const xs = HAIRLINE_COLUMNS.map((c) => pts[c * 2]);
  const ys = HAIRLINE_COLUMNS.map((c) => pts[c * 2 + 1]);
  const ovalY = (x: number) => {
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1]);
    return ys[ys.length - 1];
  };
  return (x, y) => {
    const above = ovalY(x) - y; // pixels above the oval
    const r = rise(x);
    if (above >= r + hairDepth) return { hair: 0, skin: 0 };
    return above >= r ? { hair: 1, skin: 0 } : { hair: 0, skin: 1 };
  };
}

test('measureHairlineRatios finds where skin turns into hair, per column, as a ratio of the brow-to-10 span', () => {
  const pts = face();
  const span = foreheadFrame(pts)!.span;
  const flat = measureHairlineRatios(pts, maskSampler(pts, () => 0.4 * span));
  for (let c = 0; c < EXT_COLUMNS; c++) assert.ok(Math.abs(flat[c]! - 1.4) < 0.03, `column ${c}: ${flat[c]}`);
  // A hairline that is lower at the temples than in the middle.
  const cx = pts[10 * 2];
  const half = pts[284 * 2] - cx;
  const curved = measureHairlineRatios(pts, maskSampler(pts, (x) => (0.5 - 0.3 * Math.abs((x - cx) / half)) * span));
  assert.ok(Math.abs(curved[4]! - 1.5) < 0.03);
  assert.ok(Math.abs(curved[0]! - 1.2) < 0.04 && Math.abs(curved[8]! - 1.2) < 0.04);
  assert.ok(curved[2]! > curved[0]! && curved[2]! < curved[4]!);
  // The measurement is independent of head size.
  const big = face(0, 0, 0, 34);
  const bigSpan = foreheadFrame(big)!.span;
  const scaled = measureHairlineRatios(big, maskSampler(big, () => 0.4 * bigSpan));
  assert.ok(Math.abs(scaled[4]! - 1.4) < 0.03);
});

test('measureHairlineRatios reports ambiguous columns: outside the mask, background, no hair, a fringe', () => {
  const pts = face();
  const span = foreheadFrame(pts)!.span;
  // Bald or cropped: skin all the way up.
  assert.deepEqual(measureHairlineRatios(pts, () => ({ hair: 0, skin: 1 })), new Array(EXT_COLUMNS).fill(null));
  // A hat or the background right above the skin (neither skin nor hair).
  assert.deepEqual(measureHairlineRatios(pts, maskSampler(pts, () => 0.3 * span, 0)), new Array(EXT_COLUMNS).fill(null));
  // The mask crop ends before the hairline.
  const inner = maskSampler(pts, () => 0.8 * span);
  const cropTop = pts[10 * 2 + 1] - 0.5 * span;
  const cropped = measureHairlineRatios(pts, (x, y) => (y < cropTop ? null : inner(x, y)));
  assert.equal(cropped[4], null);
  // Half the columns measured: the left side of the frame has no mask at all.
  const cx = pts[10 * 2];
  const sided = measureHairlineRatios(pts, (x, y) => (x > cx + 1 ? null : maskSampler(pts, () => 0.4 * span)(x, y)));
  assert.ok(sided[0] !== null && sided[4] !== null);
  assert.equal(sided[8], null);
  // Hair right on the oval (a fringe): the wearer's hairline is on the oval; a persona photo's is unknown.
  const fringe = maskSampler(pts, () => -5);
  assert.deepEqual(measureHairlineRatios(pts, fringe), new Array(EXT_COLUMNS).fill(1));
  assert.deepEqual(measureHairlineRatios(pts, fringe, { startsInHair: 'ambiguous' }), new Array(EXT_COLUMNS).fill(null));
  // One noisy hair texel on the forehead is not a hairline.
  const noisyY = pts[10 * 2 + 1] - 0.15 * span;
  const clean = maskSampler(pts, () => 0.4 * span);
  const noisy = measureHairlineRatios(pts, (x, y) => (Math.abs(y - noisyY) < 0.012 * span ? { hair: 1, skin: 0 } : clean(x, y)));
  assert.ok(Math.abs(noisy[4]! - 1.4) < 0.03, `noisy ${noisy[4]}`);
  // Ratios never exceed the cap.
  for (const r of measureHairlineRatios(pts, maskSampler(pts, () => 1.19 * span))) assert.ok(r === null || r <= MAX_HAIRLINE_RATIO);
});

test('measureHairlineRatios and extendForehead agree in normalised (non-square) coordinates', () => {
  const px = face();
  const [w, h] = [640, 960];
  const uv = new Float32Array(px.length);
  for (let i = 0; i < 468; i++) {
    uv[i * 2] = px[i * 2] / w;
    uv[i * 2 + 1] = px[i * 2 + 1] / h;
  }
  const span = foreheadFrame(px)!.span;
  const sampler = maskSampler(px, () => 0.4 * span);
  const ratios = measureHairlineRatios(uv, (u, v) => sampler(u * w, v * h), { aspect: h / w });
  assert.ok(Math.abs(ratios[4]! - 1.4) < 0.03);
  extendForehead(px, RATIOS);
  extendForehead(uv, RATIOS, 1, h / w);
  for (let i = EXT_MID_START; i < EXT_VERTEX_COUNT; i++) {
    assert.ok(Math.abs(uv[i * 2] * w - px[i * 2]) < 1e-2);
    assert.ok(Math.abs(uv[i * 2 + 1] * h - px[i * 2 + 1]) < 1e-2);
  }
});

test('fillAmbiguousRatios interpolates from neighbouring columns and falls back to the default', () => {
  assert.deepEqual(fillAmbiguousRatios([1.2, null, null, 1.5, null, 1.3, null, null, null]), [1.2, 1.3, 1.4, 1.5, 1.4, 1.3, 1.3, 1.3, 1.3].map((v) => v));
  const filled = fillAmbiguousRatios([null, null, 1.3, null, 1.5, null, null, null, null]);
  assert.deepEqual(filled.map((v) => Math.round(v * 100) / 100), [1.3, 1.3, 1.3, 1.4, 1.5, 1.5, 1.5, 1.5, 1.5]);
  assert.deepEqual(fillAmbiguousRatios(new Array(EXT_COLUMNS).fill(null)), new Array(EXT_COLUMNS).fill(DEFAULT_HAIRLINE_RATIO));
  assert.equal(DEFAULT_HAIRLINE_RATIO, 1.4);
});

test('medianRatios takes the per-column median and drops columns measured in under half the samples', () => {
  const samples = [
    [1.3, 1.4, null, 1.5, 1.5, 1.5, 1.4, 1.4, 1.3],
    [1.5, 1.4, null, 1.5, 1.5, 1.5, 1.4, 1.4, 1.3],
    [1.4, 9.0, 1.4, 1.5, 1.5, 1.5, 1.4, 1.4, 1.3],
  ];
  const m = medianRatios(samples);
  assert.equal(m[0], 1.4);
  assert.equal(m[1], 1.4); // the outlier does not move the median
  assert.equal(m[2], null); // one of three
});

test('stretchClamp limits the mapping where the wearer forehead is outside 0.75–1.35× the persona', () => {
  const same = stretchClamp(RATIOS, RATIOS);
  assert.deepEqual(same.wearer, RATIOS);
  assert.deepEqual(same.persona, RATIOS);
  assert.equal(same.clamped, 0);
  // Wearer much taller than the persona: the wearer side stops at 1.35× and the persona span is kept.
  const tall = stretchClamp(new Array(EXT_COLUMNS).fill(2.0), new Array(EXT_COLUMNS).fill(1.2));
  for (let c = 0; c < EXT_COLUMNS; c++) {
    assert.ok(Math.abs(tall.wearer[c] - 1.35 * 1.2) < 1e-9);
    assert.equal(tall.persona[c], 1.2);
  }
  assert.equal(tall.clamped, EXT_COLUMNS);
  // Wearer much shorter: the persona span is cut to wearer / 0.75 and the wearer side is kept.
  const short = stretchClamp(new Array(EXT_COLUMNS).fill(1.05), new Array(EXT_COLUMNS).fill(1.8));
  for (let c = 0; c < EXT_COLUMNS; c++) {
    assert.equal(short.wearer[c], 1.05);
    assert.ok(Math.abs(short.persona[c] - 1.05 / 0.75) < 1e-9);
  }
  // Inside the band nothing moves; per column, so one extreme column does not clamp the others.
  const mixed = stretchClamp([1.4, 1.4, 1.4, 1.4, 2.2, 1.4, 1.4, 1.4, 1.4], new Array(EXT_COLUMNS).fill(1.3));
  assert.equal(mixed.clamped, 1);
  assert.equal(mixed.wearer[0], 1.4);
  assert.ok(Math.abs(mixed.wearer[4] - 1.35 * 1.3) < 1e-9);
  // The effective stretch always ends inside the band.
  for (const [w, p] of [[2.2, 1.0], [1.0, 2.2], [1.6, 1.3], [1.1, 1.5]]) {
    const r = stretchClamp(new Array(EXT_COLUMNS).fill(w), new Array(EXT_COLUMNS).fill(p));
    const s = r.wearer[0] / r.persona[0];
    assert.ok(s >= 0.75 - 1e-9 && s <= 1.35 + 1e-9, `stretch ${s} for ${w}/${p}`);
    assert.ok(r.wearer[0] >= 1 && r.persona[0] >= 1);
  }
});

test('HairlineCalibrator calibrates once from a frontal hold and leaves the ratios alone afterwards', () => {
  const cal = new HairlineCalibrator();
  const sample = [1.3, 1.4, 1.45, 1.5, 1.5, 1.5, 1.45, 1.4, 1.3];
  const info = (t: number, frontal = true) => ({ frontal, t, spanOverFaceHeight: 0.3 });
  assert.equal(cal.ratios, null);
  // The first second of a frontal hold is dwell: nothing is sampled.
  let t = 0;
  for (; t < 1000; t += 33) assert.equal(cal.push(sample, info(t)), false);
  assert.equal(cal.sampleCount, 0);
  // Frames without a new mask do not count.
  cal.push(null, info(t));
  assert.equal(cal.sampleCount, 0);
  // Turning away before the calibration completes restarts it.
  for (let i = 0; i < 5; i++, t += 133) cal.push(sample, info(t));
  assert.equal(cal.sampleCount, 5);
  cal.push(sample, info(t, false));
  assert.equal(cal.sampleCount, 0);
  t += 33;
  for (const start = t; t < start + 1000; t += 33) cal.push(sample, info(t));
  // 20 mask samples, some with ambiguous or noisy columns.
  let changed = false;
  for (let i = 0; i < HAIRLINE_SAMPLES; i++, t += 133) {
    const s: Array<number | null> = [...sample];
    if (i % 3 === 0) s[0] = null;
    if (i === 7) s[4] = 2.1;
    s[8] = null; // never measured: interpolated from column 7
    changed = cal.push(s, info(t));
  }
  assert.equal(changed, true);
  assert.equal(cal.calibrations, 1);
  const r = cal.ratios!;
  assert.equal(r[0], 1.3);
  assert.equal(r[4], 1.5);
  assert.equal(r[8], 1.4);
  const v = cal.version;
  // Per-frame mask jitter after calibration never moves the geometry.
  for (let i = 0; i < 100; i++, t += 133) assert.equal(cal.push(sample.map((x) => x + (i % 2 ? 0.03 : -0.03)), info(t)), false);
  assert.equal(cal.version, v);
  assert.deepEqual(cal.ratios, r);
});

test('HairlineCalibrator recalibrates after 3 s of frontal disagreement above 5% of face height', () => {
  const cal = new HairlineCalibrator();
  const a = new Array(EXT_COLUMNS).fill(1.3);
  const b = new Array(EXT_COLUMNS).fill(1.6); // 0.3 × 0.3 = 9% of face height higher
  const info = (t: number, frontal = true) => ({ frontal, t, spanOverFaceHeight: 0.3 });
  let t = 0;
  for (; cal.ratios === null; t += 100) cal.push(a, info(t));
  assert.deepEqual(cal.ratios, a);
  // A small disagreement (0.1 × 0.3 = 3%) never triggers.
  for (let i = 0; i < 60; i++, t += 100) cal.push(new Array(EXT_COLUMNS).fill(1.4), info(t));
  assert.equal(cal.isCollecting, false);
  // Two seconds of disagreement, then agreement: no recalibration.
  for (let i = 0; i < 20; i++, t += 100) cal.push(b, info(t));
  assert.ok(cal.lastDisagreement! > 0.05);
  cal.push(a, info(t));
  for (let i = 0; i < 20; i++, t += 100) cal.push(b, info(t));
  assert.equal(cal.isCollecting, false);
  // Over three seconds: a new calibration starts; the old ratios stay in use until it completes.
  for (let i = 0; i < 15 && !cal.isCollecting; i++, t += 100) cal.push(b, info(t));
  assert.equal(cal.isCollecting, true);
  assert.deepEqual(cal.ratios, a);
  for (let i = 0; i < HAIRLINE_SAMPLES; i++, t += 100) cal.push(b, info(t));
  assert.deepEqual(cal.ratios, b);
  assert.equal(cal.calibrations, 2);
  // The manual button does the same; reset forgets everything.
  cal.recalibrate();
  assert.equal(cal.isCollecting, true);
  assert.deepEqual(cal.ratios, b);
  cal.reset();
  assert.equal(cal.ratios, null);
  assert.equal(cal.calibrations, 0);
});

test('extendTopology adds two rings above the upper oval and makes the forehead opaque up to the hairline ring', () => {
  const base = buildFaceTopology(TESSELLATION, OVAL, 468);
  const topo = extendTopology(base);
  assert.equal(topo.vertexCount, EXT_VERTEX_COUNT);
  assert.equal(EXT_VERTEX_COUNT, 496);
  assert.equal(topo.triangles.length, base.triangles.length + 36 * 3);
  // The base triangles are untouched and come first.
  assert.deepEqual(Array.from(topo.triangles.subarray(0, base.triangles.length)), Array.from(base.triangles));
  for (const arr of [topo.featherWeights, topo.lipWeights, topo.lipZones]) assert.equal(arr.length, EXT_VERTEX_COUNT);
  assert.equal(topo.forehead!.length, EXT_VERTEX_COUNT * 2);
  // Still a manifold: every edge is used by at most two triangles, and no index is out of range.
  const edgeUse = new Map<string, number>();
  for (let i = 0; i < topo.triangles.length; i += 3) {
    const t = [topo.triangles[i], topo.triangles[i + 1], topo.triangles[i + 2]];
    for (const v of t) assert.ok(v < EXT_VERTEX_COUNT && !(v >= 468 && v < 478), `index ${v}`);
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[0], t[2]]]) {
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  for (const [edge, count] of edgeUse) assert.ok(count <= 2, `edge ${edge} used ${count} times`);

  // With the extension inactive the base feather applies: the base weights are kept and the new vertices are transparent.
  for (let v = 0; v < 468; v++) assert.equal(topo.featherWeights[v], base.featherWeights[v]);
  for (let v = EXT_MID_START; v < EXT_VERTEX_COUNT; v++) assert.equal(topo.featherWeights[v], 0);

  // Active: the middle columns and everything between them and the brows are opaque...
  const f = (v: number) => topo.forehead![v * 2];
  const hairCoord = (v: number) => topo.forehead![v * 2 + 1];
  for (const v of [103, 67, 109, 10, 338, 297, 332]) assert.equal(f(v), 1, `column ${v}`);
  for (const v of [151, 9, 8, 108, 337, 69, 299]) assert.equal(f(v), 1, `forehead vertex ${v}`);
  // ... the outer columns taper toward the temples, and the temples, cheeks and jaw are unchanged.
  assert.ok(Math.abs(f(54) - 0.6) < 1e-6 && Math.abs(f(284) - 0.6) < 1e-6);
  for (const v of [TEMPLE_ANCHOR_RIGHT, TEMPLE_ANCHOR_LEFT, 162, 389, 127, 356, 234, 454, 152, 172, 397]) assert.equal(f(v), 0, `oval vertex ${v}`);
  for (const v of [50, 280, 205, 425, 1, 4, 200, 61, 291, 147, 376]) assert.equal(f(v), base.featherWeights[v], `face vertex ${v}`);
  for (let v = 0; v < 468; v++) assert.ok(f(v) >= base.featherWeights[v]);
  // The new rings take their column's weight and carry the hairline coordinate.
  for (let c = 0; c < EXT_COLUMNS; c++) {
    assert.equal(f(EXT_MID_START + c), f(HAIRLINE_COLUMNS[c]));
    assert.equal(f(EXT_HAIR_START + c), f(HAIRLINE_COLUMNS[c]));
    assert.equal(hairCoord(EXT_MID_START + c), 0.5);
    assert.equal(hairCoord(EXT_HAIR_START + c), 1);
    assert.equal(hairCoord(HAIRLINE_COLUMNS[c]), 0);
    // Boundary vertices: full tone match, no lip or eye weights.
    assert.equal(topo.ovalRingDistance[EXT_HAIR_START + c], 0);
    assert.equal(topo.eyeRingDistance[EXT_HAIR_START + c], -1);
    assert.equal(topo.lipWeights[EXT_HAIR_START + c], 0);
    assert.equal(topo.lipZones[EXT_HAIR_START + c], 3);
  }
});

test('a collapsed extension never fades the face interior through the foreshortening weights', () => {
  const topo = extendTopology(buildFaceTopology(TESSELLATION, OVAL, 468));
  const screen = face(0, 0, 0, 20);
  const uv = face(0, 0, 0, 0.03, 0.5, 0.5);
  extendForehead(uv, RATIOS);
  // Not calibrated yet: the extension sits on the oval.
  extendForehead(screen, RATIOS, 0);
  const collapsed = foreshortenWeights(screen, uv, topo.triangles, topo.vertexCount);
  for (let v = 0; v < 468; v++) {
    const touchesExtension = HAIRLINE_COLUMNS.includes(v) || v === TEMPLE_ANCHOR_LEFT || v === TEMPLE_ANCHOR_RIGHT;
    if (!touchesExtension) assert.equal(collapsed[v], 1, `vertex ${v}`);
  }
  // Calibrated: everything is at rest size.
  extendForehead(screen, RATIOS, 1);
  const full = foreshortenWeights(screen, uv, topo.triangles, topo.vertexCount);
  for (let v = 0; v < EXT_VERTEX_COUNT; v++) if (!(v >= 468 && v < 478)) assert.equal(full[v], 1, `vertex ${v}`);
});

test('padPoints and foreheadPolygon', () => {
  const src = new Float32Array(478 * 2).map((_, i) => i);
  const padded = padPoints(src);
  assert.equal(padded.length, EXT_VERTEX_COUNT * 2);
  assert.equal(padded[955], 955);
  assert.equal(padded[956], 0);
  const pts = face();
  extendForehead(pts, RATIOS);
  const poly = foreheadPolygon(pts);
  assert.equal(poly.length, EXT_COLUMNS * 2);
  assert.equal(poly[0].x, pts[54 * 2]);
  assert.equal(poly[poly.length - 1].y, pts[EXT_HAIR_START * 2 + 1]);
  // The polygon encloses the middle of the extended forehead and not the brows.
  const inside = (x: number, y: number) => {
    let inn = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inn = !inn;
    }
    return inn;
  };
  assert.equal(inside(pts[(EXT_MID_START + 4) * 2], pts[(EXT_MID_START + 4) * 2 + 1]), true);
  assert.equal(inside(pts[GLABELLA * 2], pts[GLABELLA * 2 + 1]), false);
});

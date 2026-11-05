import test from 'node:test';
import assert from 'node:assert/strict';
import { FACE_OVAL_RING, INNER_LIP_RING, LANDMARK_COUNT, LMK, OUTER_LIP_RING } from './landmarks.ts';
import {
  RgbaImage,
  blockMatchFlow,
  ciede2000,
  faceRegions,
  flicker,
  foreheadToneStep,
  hairlineAlignment,
  jitter,
  laplacianVariance,
  luminance,
  maskCount,
  mouthFidelity,
  personaTopEdge,
  rasterizePolygon,
  rgbToLab,
  seamScore,
  sharpnessMatch,
  skinToneMatch,
  textureSlide,
  excludeDarkPixels,
  foreheadStep,
  medianOf,
  percentileOf,
  relativeTargets,
  sharpnessCheck,
  skinToneCheck,
  slideCheck,
  seamCheck,
  driverTextureSlide,
  trimAtHairline,
  worstOf,
} from './metrics.ts';

// --- Fixtures -------------------------------------------------------------------------------------

const W = 320;
const H = 320;
const CX = 160;
const CY = 170;
const RX = 70;
const RY = 95;

/** Synthetic 478-point face: an ellipse for the oval plus the named landmarks the metrics use. */
function syntheticFace(shiftX = 0, shiftY = 0): Float32Array {
  const pts = new Float32Array(LANDMARK_COUNT * 2);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    pts[i * 2] = CX + shiftX;
    pts[i * 2 + 1] = CY + shiftY;
  }
  const set = (i: number, x: number, y: number) => {
    pts[i * 2] = x + shiftX;
    pts[i * 2 + 1] = y + shiftY;
  };
  FACE_OVAL_RING.forEach((idx, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / FACE_OVAL_RING.length;
    set(idx, CX + RX * Math.cos(a), CY + RY * Math.sin(a));
  });
  set(LMK.TOP, CX, CY - RY);
  set(LMK.CHIN, CX, CY + RY);
  set(LMK.LEFT_TEMPLE, CX + RX, CY);
  set(LMK.RIGHT_TEMPLE, CX - RX, CY);
  set(LMK.GLABELLA, CX, CY - 50);
  set(LMK.RIGHT_CHEEK, CX - 40, CY + 20);
  set(LMK.LEFT_CHEEK, CX + 40, CY + 20);
  set(LMK.RIGHT_TEMPLE_UPPER, CX - 45, CY - 75);
  set(LMK.LEFT_TEMPLE_UPPER, CX + 45, CY - 75);
  OUTER_LIP_RING.forEach((idx, k) => {
    const a = (2 * Math.PI * k) / OUTER_LIP_RING.length;
    set(idx, CX + 24 * Math.cos(a), CY + 55 + 10 * Math.sin(a));
  });
  INNER_LIP_RING.forEach((idx, k) => {
    const a = (2 * Math.PI * k) / INNER_LIP_RING.length;
    set(idx, CX + 16 * Math.cos(a), CY + 55 + 4 * Math.sin(a));
  });
  return pts;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function image(fill: (x: number, y: number) => [number, number, number], width = W, height = H): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Deterministic texture: smooth gradient plus per-pixel noise so block matching has something to lock on to. */
function texture(seed: number, amp = 40) {
  const rnd = lcg(seed);
  const noise = new Float32Array(W * H);
  for (let i = 0; i < noise.length; i++) noise[i] = (rnd() - 0.5) * amp;
  return (x: number, y: number) => 120 + ((x * 7 + y * 3) % 40) + noise[((y + H) % H) * W + ((x + W) % W)];
}

const grey = (v: number): [number, number, number] => [v, v, v];

// --- Colour ---------------------------------------------------------------------------------------

test('ciede2000 reproduces the Sharma 2005 reference pairs', () => {
  const cases: Array<[[number, number, number], [number, number, number], number]> = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
    [[50, -1, 2], [50, 0, 0], 2.3669],
  ];
  for (const [a, b, expected] of cases) {
    assert.ok(Math.abs(ciede2000(a, b) - expected) < 1e-3, `${a} vs ${b}: ${ciede2000(a, b)} != ${expected}`);
  }
});

test('rgbToLab maps white and mid grey to neutral Lab values', () => {
  const white = rgbToLab([255, 255, 255]);
  assert.ok(Math.abs(white[0] - 100) < 0.05 && Math.abs(white[1]) < 0.05 && Math.abs(white[2]) < 0.05, String(white));
  const grey50 = rgbToLab([119, 119, 119]);
  assert.ok(Math.abs(grey50[0] - 50) < 0.6 && Math.abs(grey50[1]) < 0.05, String(grey50));
  const red = rgbToLab([255, 0, 0]);
  assert.ok(red[1] > 70, 'red has strong positive a*');
});

// --- Masks & statistics ---------------------------------------------------------------------------

test('rasterizePolygon fills a square with its exact pixel area and leaves the outside empty', () => {
  const mask = rasterizePolygon(
    [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 25 },
      { x: 10, y: 25 },
    ],
    50,
    50
  );
  assert.equal(maskCount(mask), 20 * 15);
  assert.equal(mask[5 * 50 + 5], 0);
  assert.equal(mask[12 * 50 + 12], 1);
});

test('laplacianVariance is 0 on a flat image and positive on noise', () => {
  const flat = image(() => grey(100));
  const mask = new Uint8Array(W * H).fill(1);
  assert.equal(laplacianVariance(luminance(flat), W, H, mask), 0);
  const tex = texture(1);
  const noisy = image((x, y) => grey(tex(x, y)));
  assert.ok(laplacianVariance(luminance(noisy), W, H, mask) > 100);
});

test('faceRegions places every patch inside the image and the ring outside the face', () => {
  const r = faceRegions(syntheticFace(), W, H);
  for (const [name, m] of Object.entries({
    inside: r.inside,
    outsideRing: r.outsideRing,
    boundary: r.boundary,
    insideBand: r.insideBand,
    cheekLeft: r.cheekLeft,
    neck: r.neck,
    earLeft: r.earLeft,
    foreheadUpper: r.foreheadUpper,
    foreheadLower: r.foreheadLower,
  })) {
    assert.ok(maskCount(m) > 0, `${name} is empty`);
  }
  // The outside ring and the interior do not overlap.
  for (let i = 0; i < r.inside.length; i++) assert.ok(!(r.inside[i] && r.outsideRing[i]));
  assert.ok(r.foreheadRect.w > 0 && r.foreheadRect.h > 0);
  assert.ok(r.foreheadRect.y >= CY - RY - 1 && r.foreheadRect.y + r.foreheadRect.h <= CY - 50 + 1, 'forehead rect spans top to glabella');
});

// --- Frame metrics --------------------------------------------------------------------------------

test('sharpnessMatch is ~1 for uniform texture and >1 when only the face is sharp', () => {
  const pts = syntheticFace();
  const tex = texture(2);
  const uniform = image((x, y) => grey(tex(x, y)));
  const u = sharpnessMatch(uniform, pts);
  assert.ok(u.ratio > 0.8 && u.ratio < 1.25, `uniform ratio ${u.ratio}`);

  const inside = faceRegions(pts, W, H).inside;
  const soft = texture(4, 4);
  const faceOnly = image((x, y) => (inside[y * W + x] ? grey(tex(x, y)) : grey(soft(x, y))));
  const f = sharpnessMatch(faceOnly, pts);
  assert.ok(f.ratio > 2, `face-only ratio ${f.ratio}`);
});

test('seamScore rises when a brightness step sits on the face oval', () => {
  const pts = syntheticFace();
  const tex = texture(3, 12);
  const plain = image((x, y) => grey(tex(x, y)));
  const oval = rasterizePolygon(faceRegions(pts, W, H).oval, W, H);
  const stepped = image((x, y) => grey(tex(x, y) + (oval[y * W + x] ? 40 : 0)));
  const a = seamScore(plain, pts);
  const b = seamScore(stepped, pts);
  assert.ok(a.ratio > 0.7 && a.ratio < 1.4, `plain ratio ${a.ratio}`);
  assert.ok(b.ratio > a.ratio * 1.5, `stepped ratio ${b.ratio} vs ${a.ratio}`);
});

test('mouthFidelity measures the lip landmark offset as a share of face width', () => {
  const driver = syntheticFace();
  const output = syntheticFace(3, 4);
  const m = mouthFidelity(output, driver);
  assert.ok(m);
  assert.ok(Math.abs(m.lipErrorPx - 5) < 1e-6);
  assert.ok(Math.abs(m.lipErrorPct - (5 / (2 * RX)) * 100) < 1e-6);
  assert.equal(mouthFidelity(null, driver), null);
});

test('skinToneMatch reports a larger cheek/neck ΔE when the persona cheeks are tinted', () => {
  const pts = syntheticFace();
  const skin: [number, number, number] = [190, 150, 125];
  const driver = image(() => skin);
  const r = faceRegions(pts, W, H);
  const tinted = image((x, y) => (r.cheekLeft[y * W + x] || r.cheekRight[y * W + x] ? [230, 140, 90] : skin));
  const same = skinToneMatch(driver, driver, pts);
  const diff = skinToneMatch(tinted, driver, pts);
  assert.ok(same && diff);
  assert.ok(same.cheekVsNeck < 0.01 && same.driverCheekVsNeck < 0.01);
  assert.ok(diff.cheekVsNeck > 10, `tinted ΔE ${diff.cheekVsNeck}`);
  assert.ok(diff.cheekVsEars > 10);
});

test('foreheadToneStep is ~0 for a uniform forehead and positive for a two-tone one', () => {
  const pts = syntheticFace();
  const driver = image(() => [190, 150, 125]);
  const r = faceRegions(pts, W, H);
  const banded = image((x, y) => (r.foreheadUpper[y * W + x] ? [215, 170, 150] : [190, 150, 125]));
  const flat = foreheadToneStep(driver, driver, pts);
  const step = foreheadToneStep(banded, driver, pts);
  assert.ok(flat && step);
  assert.ok(Math.abs(flat.delta) < 0.01);
  assert.ok(step.delta > 5, `delta ${step.delta}`);
});

// --- Burst metrics --------------------------------------------------------------------------------

test('flicker reports extra frame-to-frame change inside the face on the output only', () => {
  const pts = syntheticFace();
  const driverFrame = image(() => grey(140));
  const frames = [0, 1, 2, 3].map((i) => {
    const tex = texture(10 + i, 20);
    return { output: image((x, y) => grey(tex(x, y))), driver: driverFrame, landmarks: pts };
  });
  const f = flicker(frames);
  assert.ok(f);
  assert.equal(f.pairs, 3);
  assert.ok(f.driver < 1e-6);
  assert.ok(f.delta > 3, `delta ${f.delta}`);
});

test('blockMatchFlow recovers a pure translation', () => {
  const tex = texture(5);
  const prev = luminance(image((x, y) => grey(tex(x, y))));
  const next = luminance(image((x, y) => grey(tex(x - 3, y + 2))));
  const flow = blockMatchFlow(prev, next, W, H, { x: 60, y: 60, w: 200, h: 200 }, { search: 6 });
  assert.ok(flow.blocks > 100);
  assert.ok(Math.abs(flow.dx - 3) < 0.2 && Math.abs(flow.dy + 2) < 0.2, `flow ${flow.dx},${flow.dy}`);
});

test('textureSlide is ~0 when the persona forehead moves with the head and >0 when it slides', () => {
  const pts0 = syntheticFace();
  const tex = texture(6);
  const drv = (dx: number, dy: number) => image((x, y) => grey(tex(x - dx, y - dy)));
  const rigid = [
    { output: drv(0, 0), driver: drv(0, 0), landmarks: pts0 },
    { output: drv(2, 1), driver: drv(2, 1), landmarks: syntheticFace(2, 1) },
    { output: drv(4, 2), driver: drv(4, 2), landmarks: syntheticFace(4, 2) },
  ];
  const r = textureSlide(rigid);
  assert.ok(r);
  assert.ok(r.residualPx < 0.3, `rigid residual ${r.residualPx}`);

  // Forehead texture drifts 3 px/frame sideways relative to the head.
  const fr = faceRegions(pts0, W, H).foreheadRect;
  const slid = (dx: number, dy: number, slide: number) =>
    image((x, y) => {
      const inFore = x >= fr.x && x < fr.x + fr.w && y >= fr.y && y < fr.y + fr.h;
      return grey(tex(x - dx - (inFore ? slide : 0), y - dy));
    });
  const sliding = [
    { output: slid(0, 0, 0), driver: drv(0, 0), landmarks: pts0 },
    { output: slid(2, 1, 3), driver: drv(2, 1), landmarks: syntheticFace(2, 1) },
    { output: slid(4, 2, 6), driver: drv(4, 2), landmarks: syntheticFace(4, 2) },
  ];
  const s = textureSlide(sliding);
  assert.ok(s);
  assert.ok(s.residualPx > 2, `sliding residual ${s.residualPx}`);
});

// --- Hairline helpers -----------------------------------------------------------------------------

test('personaTopEdge, hairlineAlignment and jitter', () => {
  const overlay: RgbaImage = { width: 4, height: 6, data: new Uint8ClampedArray(4 * 6 * 4) };
  const setAlpha = (x: number, y: number, a: number) => (overlay.data[(y * 4 + x) * 4 + 3] = a);
  setAlpha(0, 2, 255);
  setAlpha(1, 4, 255);
  setAlpha(2, 1, 60); // below threshold
  const edge = personaTopEdge(overlay, 0, 4);
  assert.deepEqual(edge, [2, 4, null, null]);
  const align = hairlineAlignment(edge, [1, 1, 1, 1]);
  assert.deepEqual(align, { meanPx: 2, columns: 2 });
  assert.equal(hairlineAlignment([null], [1]), null);
  assert.equal(jitter([10, 11, 9, 9]), 1);
  assert.equal(jitter([5]), 0);
});

// --- Relative targets -----------------------------------------------------------------------------

test('skinToneCheck passes within ±3 ΔE of the driver and fails outside', () => {
  assert.equal(skinToneCheck(14, 12).pass, true);
  assert.equal(skinToneCheck(14, 12).gap, 2);
  assert.equal(skinToneCheck(16, 12).pass, false);
  assert.equal(skinToneCheck(9, 12).pass, true);
  assert.equal(skinToneCheck(8.9, 12).pass, false);
  assert.equal(skinToneCheck(null, 12).pass, null);
});

test('sharpnessCheck passes within ±15% of the driver ratio', () => {
  const ok = sharpnessCheck(0.8, 0.7);
  assert.equal(ok.pass, true);
  assert.ok(Math.abs(ok.gap! - 0.1428) < 0.001);
  assert.equal(sharpnessCheck(1.0, 0.7).pass, false);
  assert.equal(sharpnessCheck(0.6, 0.7).pass, true);
  assert.equal(sharpnessCheck(0.5, 0.7).pass, false);
  assert.equal(sharpnessCheck(1, 0).gap, null);
  const t = relativeTargets({ skinToneCheekVsNeck: 24.9, driverCheekVsNeck: 14.8, skinToneCheekVsEars: 25.5, driverCheekVsEars: 23, sharpnessRatio: 25.5, driverSharpnessRatio: 0.73 });
  assert.equal(t.skinToneNeck.pass, false);
  assert.equal(t.skinToneEars.pass, true);
  assert.equal(t.sharpness.pass, false);
});

// --- Forehead patches -----------------------------------------------------------------------------

test('excludeDarkPixels drops pixels far darker than the reference patch', () => {
  const pts = syntheticFace();
  const r = faceRegions(pts, W, H);
  const img = image((x, y) => (r.foreheadUpper[y * W + x] && x < CX ? [30, 20, 15] : [190, 150, 125]));
  const out = excludeDarkPixels(img, r.foreheadUpper, r.foreheadLower);
  assert.ok(out.excluded > 0);
  assert.equal(maskCount(out.mask) + out.excluded, maskCount(r.foreheadUpper));
  for (let i = 0; i < out.mask.length; i++) if (out.mask[i]) assert.ok(img.data[i * 4] > 100);
});

test('trimAtHairline cuts the band at the first mostly-dark row', () => {
  const pts = syntheticFace();
  const r = faceRegions(pts, W, H);
  const topY = CY - RY;
  const skin = new Uint8Array(r.foreheadUpper.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (r.foreheadUpper[y * W + x] && y >= topY - 13) skin[y * W + x] = 1;
  const out = trimAtHairline(r.foreheadUpper, skin, { x: CX, y: topY }, { x: 0, y: -1 }, W, H);
  assert.equal(out.hairlineAt, 13);
  for (let i = 0; i < out.mask.length; i++) if (out.mask[i]) assert.ok(Math.floor(i / W) >= topY - 13);
  const none = trimAtHairline(r.foreheadUpper, r.foreheadUpper, { x: CX, y: topY }, { x: 0, y: -1 }, W, H);
  assert.equal(none.hairlineAt, null);
});

test('foreheadStep measures the strip between the mesh top and the hairline, not the hair', () => {
  const pts = syntheticFace();
  const topY = CY - RY;
  const skin: [number, number, number] = [190, 150, 125];
  const uniform = image(() => skin);
  const flat = foreheadStep(uniform, pts)!;
  assert.ok(flat.deltaE < 0.01);
  assert.equal(flat.hairlineAt, null);
  // Hair above a lighter real-skin strip 13 px tall; the persona (lower band) keeps the skin tone.
  const banded = image((_x, y) => (y < topY - 13 ? [30, 20, 15] : y < topY ? [215, 170, 150] : skin));
  const step = foreheadStep(banded, pts)!;
  assert.equal(step.hairlineAt, 13);
  assert.ok(step.deltaE > 5, `deltaE ${step.deltaE}`);
  assert.ok(step.excluded.upper > 0);
  assert.ok(step.pixels.upper > 0);
  // The reported upper outline stops at the hairline.
  for (const p of step.patches.upper) assert.ok(p.y >= topY - 13.5, `outline y ${p.y}`);
  const both = foreheadToneStep(banded, uniform, pts)!;
  assert.ok(both.delta > 5);
});

// --- Aggregates -----------------------------------------------------------------------------------

test('medianOf, percentileOf and worstOf', () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([NaN]), null);
  assert.equal(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentileOf([5], 0.9), 5);
  const worst = worstOf([{ key: 'a', value: 1 }, { key: 'b', value: 5 }, { key: 'c', value: 3 }, { key: 'd', value: NaN }], 2);
  assert.deepEqual(worst.map((w) => w.key), ['b', 'c']);
  assert.deepEqual(worstOf([{ key: 'a', value: 1 }, { key: 'b', value: 5 }], 1, false).map((w) => w.key), ['a']);
});

test('slideCheck and seamCheck report driver, output and gap', () => {
  const s = slideCheck(2.4, 2.0);
  assert.ok(Math.abs(s.gap! - 0.4) < 1e-9);
  assert.equal(s.pass, true);
  assert.equal(slideCheck(2.6, 2.0).pass, false);
  assert.equal(slideCheck(null, 2).pass, null);
  const m = seamCheck(2.3, 1.8);
  assert.ok(Math.abs(m.gap! - 0.5) < 1e-9);
  assert.equal(m.pass, null);
  const t = relativeTargets({ textureSlidePx: 1, driverTextureSlidePx: 0.8, seamRatio: 2, driverSeamRatio: 1.5 });
  assert.equal(t.slide.pass, true);
  assert.ok(Math.abs(t.seam.gap! - 0.5) < 1e-9);
});

test('driverTextureSlide runs the slide metric on the driver frames alone', () => {
  const tex = texture(11);
  const frames = [0, 2, 4].map((shift) => {
    const img = image((x, y) => grey(tex(x - shift, y)));
    return { output: image(() => grey(128)), driver: img, landmarks: syntheticFace(shift, 0) };
  });
  const d = driverTextureSlide(frames, { search: 6 });
  assert.ok(d, 'driver slide computed');
  assert.ok(d!.residualPx < 0.6, `driver slide ${d!.residualPx}`);
});

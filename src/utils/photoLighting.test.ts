import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_FACE_MODEL } from './canonicalFaceModel.ts';
import { ciede2000 } from './color.ts';
import {
  LIGHT_ASYM_FULL,
  LIGHT_ASYM_START,
  castStrength,
  fitShading,
  lightingStrength,
  linearToLab,
  mirrorMap,
  normalizePhotoLighting,
  toneClampFor,
  toneBudgetFloor,
} from './photoLighting.ts';

/** Landmarks from the canonical model (frontal, +y up flipped to image y down), face ~ 2·scale·8 px wide. */
function canonicalFace(cx: number, cy: number, scale: number, yawShrink = 1): Float32Array {
  const pts = new Float32Array(468 * 2);
  for (let i = 0; i < 468; i++) {
    const x = CANONICAL_FACE_MODEL[i * 3];
    // A crude turn: one side of the face is compressed (as a 3/4 view would show it).
    pts[i * 2] = cx + x * scale * (x > 0 ? yawShrink : 1);
    pts[i * 2 + 1] = cy - CANONICAL_FACE_MODEL[i * 3 + 1] * scale;
  }
  return pts;
}

/** An RGBA image of a skin colour (linear) times a lighting function of the pixel position. */
function litImage(w: number, h: number, skin: [number, number, number], light: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = light(x, y);
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[p + c] = Math.round(Math.pow(Math.min(1, skin[c] * l[c]), 1 / 2.2) * 255);
      data[p + 3] = 255;
    }
  }
  return data;
}

const W = 240;
const H = 280;
const SKIN: [number, number, number] = [0.42, 0.25, 0.17];

/** Mean linear colour of a disc. */
function discMean(data: ArrayLike<number>, cx: number, cy: number, r: number): [number, number, number] {
  const s = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const p = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) s[c] += Math.pow(data[p + c] / 255, 2.2);
      n++;
    }
  }
  return [s[0] / n, s[1] / n, s[2] / n];
}

test('linearToLab and castStrength: natural skin is no cast, green or oversaturated light is', () => {
  const white = linearToLab([1, 1, 1]);
  assert.ok(Math.abs(white[0] - 100) < 0.1 && Math.abs(white[1]) < 0.1 && Math.abs(white[2]) < 0.1);
  assert.equal(castStrength([60, 15, 20]), 0, 'skin hue ~53°, chroma 25');
  assert.equal(castStrength([60, -5, 20]), 1, 'green-yellow hue ~104°');
  assert.equal(castStrength([55, 30, 35]), 1, 'orange chroma 46');
  assert.equal(castStrength([50, 1, 1]), 0, 'near grey: no hue to judge');
  assert.equal(lightingStrength(LIGHT_ASYM_START), 0);
  assert.equal(lightingStrength(LIGHT_ASYM_FULL), 1);
  assert.ok(lightingStrength((LIGHT_ASYM_START + LIGHT_ASYM_FULL) / 2) > 0.4);
});

test('mirrorMap sends each side of a frontal and a turned face to the other', () => {
  for (const shrink of [1, 0.7]) {
    const pts = canonicalFace(120, 140, 7, shrink);
    const fit = fitShading(litImage(W, H, SKIN, () => [1, 1, 1]), W, H, pts);
    assert.ok(fit);
    const map = mirrorMap(pts, fit);
    assert.ok(map);
    // Outer eye corners 33 (right) and 263 (left) map onto each other.
    const at = (i: number) => [(pts[i * 2] - fit.cx) / fit.ax, (pts[i * 2 + 1] - fit.cy) / fit.ay];
    const [u, v] = at(33);
    const [tu, tv] = at(263);
    const q = (c: number[]) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;
    assert.ok(Math.abs(q(map[0]) - tu) < 0.05 && Math.abs(q(map[1]) - tv) < 0.05, `shrink ${shrink}`);
  }
});

test('normalizePhotoLighting leaves an evenly lit photo untouched', () => {
  const pts = canonicalFace(120, 140, 7);
  // Symmetric falloff toward the edges (form, not side light) and a uniform warm tint.
  const data = litImage(W, H, SKIN, (x, y) => {
    const f = 1 - 0.25 * (((x - 120) / 70) ** 2 + ((y - 140) / 90) ** 2);
    return [f * 1.05, f, f * 0.95];
  });
  const before = data.slice();
  const a = normalizePhotoLighting(data, W, H, pts);
  assert.ok(a);
  assert.ok(a.asymmetry < LIGHT_ASYM_START, `asymmetry ${a.asymmetry}`);
  assert.equal(a.strength, 0);
  assert.deepEqual(data, before);
});

test('normalizePhotoLighting evens out a coloured side light and keeps the mean skin colour', () => {
  const pts = canonicalFace(120, 140, 7);
  // Warm key from the image left, cool dim fill on the right (a harsh, coloured side light).
  const light = (x: number): [number, number, number] => {
    const t = Math.min(1, Math.max(0, (x - 50) / 140));
    return [1.4 - 1.0 * t, 1.2 - 0.8 * t, 0.9 - 0.45 * t];
  };
  const data = litImage(W, H, SKIN, (x) => light(x));
  const left = discMean(data, 85, 150, 8);
  const right = discMean(data, 155, 150, 8);
  const gapBefore = ciede2000(linearToLab(left), linearToLab(right));
  const a = normalizePhotoLighting(data, W, H, pts);
  assert.ok(a);
  assert.ok(a.asymmetry > LIGHT_ASYM_FULL && a.strength === 1, `asymmetry ${a.asymmetry}`);
  const leftAfter = discMean(data, 85, 150, 8);
  const rightAfter = discMean(data, 155, 150, 8);
  const gapAfter = ciede2000(linearToLab(leftAfter), linearToLab(rightAfter));
  assert.ok(gapAfter < gapBefore * 0.35, `cheek gap ${gapBefore.toFixed(1)} → ${gapAfter.toFixed(1)}`);
  // The mean of the two cheeks stays close to before (geometric mean of the two sides).
  const meanBefore = linearToLab(left.map((v, i) => Math.sqrt(v * right[i])));
  const meanAfter = linearToLab(leftAfter.map((v, i) => (v + rightAfter[i]) / 2));
  assert.ok(ciede2000(meanBefore, meanAfter) < 4);
  // Far outside the oval nothing changed.
  const corner = discMean(data, 8, 8, 4);
  const cornerRef = discMean(litImage(W, H, SKIN, (x) => light(x)), 8, 8, 4);
  assert.ok(Math.abs(corner[0] - cornerRef[0]) < 1e-6);
});

test('toneClampFor keeps a pure brightness difference at the clamp within the budget at skin lightness', () => {
  assert.equal(toneClampFor(0), 0);
  for (const budget of [1.5, 2.5, 3]) {
    const t = toneClampFor(budget);
    for (const skin of [[0.1, 0.06, 0.04], [0.25, 0.16, 0.11], [0.45, 0.3, 0.22]]) {
      const lighter = skin.map((v) => v * Math.exp(t));
      const darker = skin.map((v) => v * Math.exp(-t));
      for (const other of [lighter, darker]) {
        const d = ciede2000(linearToLab(skin), linearToLab(other));
        assert.ok(d <= budget && d > budget * 0.4, `budget ${budget}, skin ${skin}: ΔE00 ${d.toFixed(2)}`);
      }
    }
  }
});

test('toneBudgetFloor: 0 within the budget, otherwise the smallest floor that meets it', () => {
  const p = [0.2, 0.12, 0.08];
  assert.equal(toneBudgetFloor(p, p, 2.5, 0.65, 0.35), 0);
  assert.equal(toneBudgetFloor(p, [0.5, 0.35, 0.25], 0, 0.65, 0.35), 0, 'budget off');
  // A dark persona on a light wearer (brightness ratio ~3.5, inside the shader's 0.25..4 clamp).
  const dark = [0.14, 0.08, 0.05];
  const light = [0.45, 0.3, 0.22];
  const f = toneBudgetFloor(dark, light, 2.5, 0.65, 0.35);
  assert.ok(f > 0.65 && f < 1, `floor ${f}`);
  // Recompute the face mean at that floor: within the budget; a little below it is not.
  const at = (e: number) => {
    const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const lr = luma(light) / luma(dark);
    assert.ok(lr < 4);
    return dark.map((v, i) => v * Math.pow(lr, Math.max(0.65, e)) * Math.pow(light[i] / luma(light) / (dark[i] / luma(dark)), Math.max(0.35, e)));
  };
  assert.ok(ciede2000(linearToLab(at(f)), linearToLab(light)) <= 2.5 + 1e-6);
  assert.ok(ciede2000(linearToLab(at(f - 0.02)), linearToLab(light)) > 2.5);
});

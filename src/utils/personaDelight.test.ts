import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIGHT_FADE_OUT,
  FACE_OVAL_RING,
  LEFT_BROW_RING,
  LEFT_EYE_RING,
  OUTER_LIP_RING,
  RIGHT_BROW_RING,
  RIGHT_EYE_RING,
  delightPersona,
  insidePolygon,
  skinMaskForDelight,
  solveLinear,
} from './personaDelight.ts';

/** Synthetic landmarks: an oval face with eye, brow and lip rings at plausible places. */
function syntheticFace(cx: number, cy: number, ax: number, ay: number): Float32Array {
  const pts = new Float32Array(468 * 2);
  for (let i = 0; i < 468; i++) { pts[i * 2] = cx; pts[i * 2 + 1] = cy; }
  const ringAt = (ring: number[], x: number, y: number, rx: number, ry: number) => {
    ring.forEach((idx, k) => {
      const a = (k / ring.length) * Math.PI * 2;
      pts[idx * 2] = x + Math.cos(a) * rx;
      pts[idx * 2 + 1] = y + Math.sin(a) * ry;
    });
  };
  ringAt(FACE_OVAL_RING, cx, cy, ax, ay);
  ringAt(LEFT_EYE_RING, cx + ax * 0.35, cy - ay * 0.2, ax * 0.12, ay * 0.06);
  ringAt(RIGHT_EYE_RING, cx - ax * 0.35, cy - ay * 0.2, ax * 0.12, ay * 0.06);
  ringAt(LEFT_BROW_RING, cx + ax * 0.35, cy - ay * 0.35, ax * 0.15, ay * 0.03);
  ringAt(RIGHT_BROW_RING, cx - ax * 0.35, cy - ay * 0.35, ax * 0.15, ay * 0.03);
  ringAt(OUTER_LIP_RING, cx, cy + ay * 0.45, ax * 0.3, ay * 0.1);
  return pts;
}

test('solveLinear and insidePolygon', () => {
  const x = solveLinear([[2, 1], [1, 3]], [3, 5]);
  assert.ok(x && Math.abs(x[0] - 0.8) < 1e-9 && Math.abs(x[1] - 1.4) < 1e-9);
  assert.equal(solveLinear([[1, 2], [2, 4]], [1, 2]), null, 'singular');
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.ok(insidePolygon(square, 5, 5));
  assert.ok(!insidePolygon(square, 15, 5));
});

test('skinMaskForDelight covers the oval interior minus eyes, brows and lips', () => {
  const w = 200, h = 240;
  const pts = syntheticFace(100, 120, 70, 95);
  const { mask, cx, cy } = skinMaskForDelight(pts, w, h);
  assert.ok(Math.abs(cx - 100) < 1 && Math.abs(cy - 120) < 1);
  assert.equal(mask[Math.round(cy) * w + Math.round(cx)], 1, 'nose bridge is skin');
  assert.equal(mask[Math.round(120 - 95 * 0.2) * w + Math.round(100 + 70 * 0.35)], 0, 'eye is a hole');
  assert.equal(mask[Math.round(120 + 95 * 0.45) * w + 100], 0, 'lips are a hole');
  assert.equal(mask[5 * w + 5], 0, 'outside the oval');
});

test('delightPersona flattens a horizontal lighting gradient on the face and leaves the outside alone', () => {
  const w = 200, h = 240;
  const pts = syntheticFace(100, 120, 70, 95);
  const data = new Uint8ClampedArray(w * h * 4);
  // Skin (200,150,120) lit from the left: linear-light gain 1.6 at the left edge down to 0.5 at the right.
  const srgb = (v: number) => Math.round(Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2) * 255);
  const lin = (v: number) => Math.pow(v / 255, 2.2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = 1.6 - (1.1 * x) / (w - 1);
      const p = (y * w + x) * 4;
      data[p] = srgb(lin(200) * g);
      data[p + 1] = srgb(lin(150) * g);
      data[p + 2] = srgb(lin(120) * g);
      data[p + 3] = 255;
    }
  }
  const before = data.slice();
  const lumaAt = (buf: Uint8ClampedArray, x: number, y: number) => {
    const p = (y * w + x) * 4;
    return 0.2126 * buf[p] + 0.7152 * buf[p + 1] + 0.0722 * buf[p + 2];
  };
  const res = delightPersona(data, w, h, pts);
  assert.ok(res && res.pixels > 300, 'fit ran');
  assert.ok(res!.range > 2 && res!.range < 4, `the fitted field saw the ~3× swing (${res!.range})`);
  // Left and right cheek lightness now agree within a few levels (before: ~100 levels apart).
  const left = lumaAt(data, 50, 130), right = lumaAt(data, 150, 130);
  const leftBefore = lumaAt(before, 50, 130), rightBefore = lumaAt(before, 150, 130);
  assert.ok(leftBefore - rightBefore > 30, `gradient was there (${leftBefore - rightBefore})`);
  assert.ok(Math.abs(left - right) < 6, `gradient removed (${left} vs ${right})`);
  // The mean skin colour and its red/blue ratio are preserved.
  const p = (130 * w + 100) * 4;
  assert.ok(Math.abs(data[p] / data[p + 2] - 200 / 120) < 0.15, 'chroma kept');
  // Far outside the fade radius nothing changed.
  const far = ((h - 2) * w + 2) * 4;
  assert.equal(data[far], before[far]);
  assert.ok(DELIGHT_FADE_OUT > 1);
  // Too few skin pixels: untouched.
  const tiny = new Uint8ClampedArray(16 * 16 * 4).fill(128);
  assert.equal(delightPersona(tiny, 16, 16, syntheticFace(8, 8, 3, 4)), null);
});

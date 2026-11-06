import test from 'node:test';
import assert from 'node:assert/strict';
import { DELIGHT_SCALES, boxMean, integralLuma, lumaAtScale, mirrorPairs, symmetricDelightGains, vertexBandLuma } from './faceSymmetry.ts';
import { CANONICAL_FACE_MODEL } from './canonicalFaceModel.ts';

test('mirrorPairs maps eye corners to each other and midline vertices to themselves', () => {
  const p = mirrorPairs();
  assert.equal(p[33], 263, 'outer eye corners');
  assert.equal(p[263], 33);
  assert.equal(p[61], 291, 'mouth corners');
  for (const mid of [1, 152, 10, 0, 17]) assert.equal(p[mid], mid, `midline vertex ${mid}`);
  for (let i = 0; i < 468; i++) {
    assert.equal(p[p[i]], i, `pair of ${i} is an involution`);
    assert.ok(Math.abs(CANONICAL_FACE_MODEL[i * 3] + CANONICAL_FACE_MODEL[p[i] * 3]) < 0.05, `x mirrors for ${i}`);
  }
});

test('integral luma box means and the band interpolation', () => {
  const w = 8, h = 4;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = i % w < 4 ? 255 : 0;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const I = integralLuma(data, w, h);
  assert.ok(Math.abs(boxMean(I, w, h, 2, 2, 2) - 1) < 1e-9, 'all white');
  assert.ok(Math.abs(boxMean(I, w, h, 6, 2, 2)) < 1e-9, 'all black');
  assert.ok(Math.abs(boxMean(I, w, h, 4, 2, 2) - 0.5) < 1e-9, 'half and half');
  const bands = [new Float32Array([1, 1]), new Float32Array([2, 2]), new Float32Array([3, 3]), new Float32Array([4, 4])];
  assert.ok(Math.abs(lumaAtScale(bands, 0.05)[0] - 2.5) < 1e-6);
  assert.ok(Math.abs(lumaAtScale(bands, 0.02)[0] - 1) < 1e-6);
  assert.ok(Math.abs(lumaAtScale(bands, 0.5)[0] - 4) < 1e-6, 'clamped to the last scale');
  assert.equal(DELIGHT_SCALES.length, 4);
});

test('symmetricDelightGains removes a left/right luminance tilt and keeps symmetric structure', () => {
  const pairs = mirrorPairs();
  const n = 468;
  const fine = new Float32Array(n), coarse = new Float32Array(n);
  // Symmetric structure: darker eye sockets on both sides (fine < coarse near the eye corners).
  // Asymmetric key light: the left half brighter in the fine band than the coarse band.
  for (let v = 0; v < n; v++) {
    const x = CANONICAL_FACE_MODEL[v * 3];
    coarse[v] = 0.5;
    let f = 0.5;
    if (v === 33 || v === 263) f *= 0.7;
    f *= Math.exp(0.3 * Math.sign(x));
    fine[v] = f;
  }
  const g = symmetricDelightGains(fine, coarse, pairs);
  // The eye-socket darkening is symmetric: gain 1 there apart from the tilt.
  assert.ok(Math.abs(Math.log(g[33]) + Math.log(g[263])) < 1e-5, 'tilt gains are opposite on the two corners');
  // A lit-side vertex gets < 1, its mirror > 1, and the product is 1 (only the asymmetric part moves).
  const lit = CANONICAL_FACE_MODEL[50 * 3] > 0 ? 50 : 280;
  assert.ok(g[lit] < 1 && g[pairs[lit]] > 1);
  assert.ok(Math.abs(g[lit] * g[pairs[lit]] - 1) < 1e-5);
  assert.ok(Math.abs(Math.log(g[lit]) + 0.3) < 1e-5, 'half the tilt (0.3) each side');
  // Midline vertices never change.
  assert.equal(g[1], 1);
  // vertexBandLuma runs end to end on a small texture.
  const w = 64, h = 64;
  const data = new Uint8Array(w * h * 4).fill(128);
  const uv = new Float32Array(n * 2).fill(0.5);
  const bands = vertexBandLuma(data, w, h, uv, 40);
  assert.equal(bands.length, 4);
  assert.ok(Math.abs(bands[0][0] - Math.pow(128 / 255, 2.2)) < 1e-6);
});

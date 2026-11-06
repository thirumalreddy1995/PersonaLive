import test from 'node:test';
import assert from 'node:assert/strict';
import { SEG_CATEGORY, emptyMasks, maskedShareInPolygon, packCategory, packMasks, sampleMask } from './segmentation.ts';
import { dilateMask, inpaintMasked } from './inpaint.ts';
import { FORESHORTEN_FADE_END, foreshortenWeights } from './foreshorten.ts';

test('packMasks copies the first update, then EMA-blends later ones; sampleMask is bilinear', () => {
  const m = emptyMasks(4, 4);
  const ones = new Float32Array(16).fill(1), zeros = new Float32Array(16);
  packMasks(m, ones, zeros, zeros, zeros);
  assert.equal(m.updates, 1);
  assert.equal(m.data[0], 255, 'hair copied on the first update');
  assert.equal(m.data[1], 0);
  packMasks(m, zeros, ones, zeros, zeros, 0.5);
  assert.equal(m.data[0], 128, 'hair halfway down');
  assert.equal(m.data[1], 128, 'body-skin halfway up');
  // Left half hair, right half none: the centre sample sits between the two.
  const half = emptyMasks(4, 1);
  packMasks(half, [1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.ok(Math.abs(sampleMask(half, 0, 0.5, 0.5) - 0.5) < 1e-6);
  assert.ok(sampleMask(half, 0, 0.1, 0.5) > 0.99 && sampleMask(half, 0, 0.9, 0.5) < 0.01);
});

test('packCategory turns a category mask into the four binary channels', () => {
  const m = emptyMasks(2, 2);
  packCategory(m, [SEG_CATEGORY.hair, SEG_CATEGORY.bodySkin, SEG_CATEGORY.faceSkin, SEG_CATEGORY.accessories]);
  assert.deepEqual(Array.from(m.data), [255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255]);
  packCategory(m, [SEG_CATEGORY.background, SEG_CATEGORY.background, SEG_CATEGORY.background, SEG_CATEGORY.background], 0.5);
  assert.equal(m.data[0], 128);
});

test('maskedShareInPolygon measures hair over the face oval of a photo', () => {
  const m = emptyMasks(8, 8);
  const hair = new Float32Array(64);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) hair[y * 8 + x] = 1; // top quarter is hair
  packMasks(m, hair, new Float32Array(64), new Float32Array(64), new Float32Array(64));
  const oval = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }]; // whole photo (80 × 80)
  assert.ok(Math.abs(maskedShareInPolygon(m, [0], oval, 80, 80) - 0.25) < 1e-6);
  const lower = [{ x: 0, y: 40 }, { x: 80, y: 40 }, { x: 80, y: 80 }, { x: 0, y: 80 }];
  assert.equal(maskedShareInPolygon(m, [0], lower, 80, 80), 0);
});

test('inpaintMasked fills a masked patch from the surrounding skin and dilateMask grows thin masks', () => {
  const w = 32, h = 32;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 200; data[i * 4 + 1] = 150; data[i * 4 + 2] = 120; data[i * 4 + 3] = 255;
  }
  // A dark "glasses frame" line across the middle.
  const mask = new Uint8Array(w * h);
  for (let x = 4; x < 28; x++) {
    const i = 15 * w + x;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 10;
    mask[i] = 1;
  }
  const grown = dilateMask(mask, w, h, 1);
  assert.ok(grown.reduce((a, b) => a + b, 0) > mask.reduce((a, b) => a + b, 0), 'dilation grew the mask');
  const res = inpaintMasked(data, w, h, grown);
  assert.ok(res.filled > 0 && res.levels >= 2);
  const i = 15 * w + 16;
  assert.ok(Math.abs(data[i * 4] - 200) < 6 && Math.abs(data[i * 4 + 1] - 150) < 6 && Math.abs(data[i * 4 + 2] - 120) < 6, `filled with skin: ${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]}`);
  assert.equal(data[i * 4 + 3], 255, 'alpha untouched');
  assert.equal(data[(2 * w + 2) * 4], 200, 'unmasked pixels untouched');
  assert.deepEqual(inpaintMasked(data, w, h, new Uint8Array(w * h)), { filled: 0, levels: 0 });
});

test('foreshortenWeights fades compressed and back-facing triangles only', () => {
  // Two triangles sharing an edge: vertices 0,1,2 and 1,3,2 in UV space (unit squares halves).
  const uv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  const tris = new Uint16Array([0, 1, 2, 1, 3, 2]);
  // Screen = UV × 100: both flat, all weights 1.
  const flat = new Float32Array(uv.map((v) => v * 100));
  assert.deepEqual(Array.from(foreshortenWeights(flat, uv, tris, 4)), [1, 1, 1, 1]);
  // Second triangle squashed: vertex 3 pulled almost onto the shared edge → its triangle is a sliver.
  const squashed = new Float32Array([0, 0, 100, 0, 0, 100, 50.8, 50.8]);
  const w = foreshortenWeights(squashed, uv, tris, 4);
  assert.ok(w[3] < 0.5 && w[0] === 1, `sliver vertex faded (${Array.from(w)})`);
  // Vertex 3 flipped across the edge: back-facing triangle → weight 0 on its vertices (shared ones take the min).
  const flipped = new Float32Array([0, 0, 100, 0, 0, 100, 20, 20]);
  const wf = foreshortenWeights(flipped, uv, tris, 4);
  assert.equal(wf[3], 0);
  assert.equal(wf[1], 0);
  assert.equal(wf[0], 1);
  assert.ok(FORESHORTEN_FADE_END > 0);
});

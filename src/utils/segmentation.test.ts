import test from 'node:test';
import assert from 'node:assert/strict';
import { SEG_CATEGORY, emptyMasks, faceCropRect, maskedShareInPolygon, packCategory, packMasks, sampleMask, setMaskRect, stableCrop } from './segmentation.ts';
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
  // Four triangles: a unit square (0,1,2 / 1,3,2) plus a second square to its left (4,0,5 / 0,2,5), so a
  // single bad triangle is a minority of the mesh area (the front-facing orientation is the majority).
  const uv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1, -1, 0, -1, 1]);
  const tris = new Uint16Array([0, 1, 2, 1, 3, 2, 4, 0, 5, 0, 2, 5]);
  // Screen = UV × 100 (+100 in x so it stays positive): all flat, all weights 1.
  const flat = new Float32Array(uv.map((v, i) => (i % 2 === 0 ? v * 100 + 100 : v * 100)));
  assert.deepEqual(Array.from(foreshortenWeights(flat, uv, tris, 6)), [1, 1, 1, 1, 1, 1]);
  // Triangle 1,3,2 squashed: vertex 3 pulled almost onto the shared edge 1–2 → its triangle is a sliver.
  const squashed = Float32Array.from(flat);
  squashed[3 * 2] = 151;
  squashed[3 * 2 + 1] = 51;
  const w = foreshortenWeights(squashed, uv, tris, 6);
  assert.ok(w[3] < 0.5 && w[4] === 1, `sliver vertex faded (${Array.from(w)})`);
  // Vertex 3 flipped across the edge: back-facing triangle → weight 0 on its vertices (shared ones take the min).
  const flipped = Float32Array.from(flat);
  flipped[3 * 2] = 120;
  flipped[3 * 2 + 1] = 20;
  const wf = foreshortenWeights(flipped, uv, tris, 6);
  assert.equal(wf[3], 0);
  assert.equal(wf[1], 0);
  assert.equal(wf[4], 1);
  assert.ok(FORESHORTEN_FADE_END > 0);
});

test('foreshortenWeights is independent of triangle winding and of a mirrored display', () => {
  // A 6 × 6 vertex grid in UV space, two triangles per cell, with alternating (arbitrary) windings.
  const n = 6;
  const uv = new Float32Array(n * n * 2);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { uv[(y * n + x) * 2] = x / (n - 1); uv[(y * n + x) * 2 + 1] = y / (n - 1); }
  const tris: number[] = [];
  let k = 0;
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const a = y * n + x, b = a + 1, c = a + n, d = c + 1;
    tris.push(...(k++ % 2 ? [a, b, c] : [a, c, b]), ...(k++ % 3 ? [b, d, c] : [b, c, d]));
  }
  const T = new Uint16Array(tris);
  const V = n * n;
  // Mirrored display (x flipped) at 300 px: every triangle front-facing, all weights 1.
  const mirrored = new Float32Array(V * 2);
  for (let v = 0; v < V; v++) { mirrored[v * 2] = 300 - uv[v * 2] * 300; mirrored[v * 2 + 1] = uv[v * 2 + 1] * 300; }
  assert.ok(Array.from(foreshortenWeights(mirrored, uv, T, V)).every((x) => x === 1), 'mirrored flat mesh untouched');
  // Turn: columns compress toward the right edge (far side); the rightmost column becomes a sliver.
  const turned = new Float32Array(V * 2);
  const xs = [0, 90, 170, 235, 280, 284];
  for (let v = 0; v < V; v++) { turned[v * 2] = xs[v % n]; turned[v * 2 + 1] = uv[v * 2 + 1] * 300; }
  const w = foreshortenWeights(turned, uv, T, V);
  assert.equal(w[0], 1, 'near side untouched');
  assert.ok(w[n - 1] < 0.2, `far sliver faded (${w[n - 1]})`);
  assert.ok(w[2] === 1, 'mid face untouched');
  // The same turn on a mirrored display gives the same weights.
  const turnedMirror = new Float32Array(V * 2);
  for (let v = 0; v < V; v++) { turnedMirror[v * 2] = 300 - turned[v * 2]; turnedMirror[v * 2 + 1] = turned[v * 2 + 1]; }
  const wm = foreshortenWeights(turnedMirror, uv, T, V);
  for (let v = 0; v < V; v++) assert.ok(Math.abs(wm[v] - w[v]) < 1e-6, `mirror invariant at ${v}`);
});

test('face crops: square in pixels, clamped, stable under small moves; masks sampled through the crop and reset on a new one', () => {
  // A 16:9 frame with a face box in the middle (normalised).
  const crop = faceCropRect([0.45, 0.35, 0.1, 0.3], 16 / 9);
  const wPx = crop[2] * 16, hPx = crop[3] * 9;
  assert.ok(Math.abs(wPx - hPx) < 1e-9, `square in pixels (${wPx} vs ${hPx})`);
  assert.ok(crop[0] >= 0 && crop[1] >= 0 && crop[0] + crop[2] <= 1 + 1e-9 && crop[1] + crop[3] <= 1 + 1e-9, 'inside the frame');
  assert.ok(crop[0] < 0.45 && crop[0] + crop[2] > 0.55, 'covers the face');
  // A face near the top-left edge is clamped, not shifted out of frame.
  const edge = faceCropRect([0.0, 0.0, 0.1, 0.3], 16 / 9);
  assert.equal(edge[0], 0);
  assert.equal(edge[1], 0);
  // Hysteresis: a 1% nudge keeps the crop, a big move replaces it.
  const nudged = faceCropRect([0.455, 0.352, 0.1, 0.3], 16 / 9);
  assert.equal(stableCrop(crop, nudged), crop);
  const moved = faceCropRect([0.6, 0.35, 0.1, 0.3], 16 / 9);
  assert.equal(stableCrop(crop, moved), moved);
  // Sampling through the crop: the mask covers the right half of the frame only.
  const m = emptyMasks(2, 1);
  setMaskRect(m, [0.5, 0, 0.5, 1]);
  packCategory(m, [SEG_CATEGORY.hair, SEG_CATEGORY.hair]);
  assert.ok(sampleMask(m, 0, 0.75, 0.5) > 0.99, 'inside the crop');
  assert.equal(sampleMask(m, 0, 0.25, 0.5), 0, 'outside the crop nothing is known');
  // A new crop restarts the EMA: the next pack copies instead of blending.
  setMaskRect(m, [0.4, 0, 0.5, 1]);
  assert.equal(m.updates, 0);
  packCategory(m, [SEG_CATEGORY.background, SEG_CATEGORY.background]);
  assert.equal(m.data[0], 0);
  setMaskRect(m, [0.4, 0, 0.5, 1]);
  assert.equal(m.updates, 1, 'the same crop keeps the EMA');
});

test('inpaintMasked fills a large hole in a gradient smoothly (no pyramid blocks)', () => {
  const w = 96, h = 96;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    data[p] = Math.round((x / (w - 1)) * 200) + 20; // horizontal gradient
    data[p + 1] = Math.round((y / (h - 1)) * 120) + 60; // vertical gradient
    data[p + 2] = 100;
    data[p + 3] = 255;
  }
  const mask = new Uint8Array(w * h);
  for (let y = 30; y < 66; y++) for (let x = 25; x < 71; x++) { mask[y * w + x] = 1; const p = (y * w + x) * 4; data[p] = data[p + 1] = data[p + 2] = 0; }
  inpaintMasked(data, w, h, mask);
  let maxStep = 0, maxErr = 0;
  for (let y = 30; y < 66; y++) for (let x = 25; x < 70; x++) {
    const p = (y * w + x) * 4, q = p + 4;
    maxStep = Math.max(maxStep, Math.abs(data[q] - data[p]), Math.abs(data[q + 1] - data[p + 1]));
    maxErr = Math.max(maxErr, Math.abs(data[p] - (Math.round((x / (w - 1)) * 200) + 20)));
  }
  assert.ok(maxStep <= 8, `no blocks: largest neighbour step ${maxStep}`);
  assert.ok(maxErr <= 40, `follows the gradient: largest error ${maxErr}`);
});

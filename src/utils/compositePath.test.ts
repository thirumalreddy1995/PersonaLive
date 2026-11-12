import test from 'node:test';
import assert from 'node:assert/strict';
import { baseFrameUv, compositeUnder, useSingleGlComposite } from './compositePath.ts';

const ok = { flag: true, viewMode: 'transformed-only', overlayReady: true, webgl: true, overlayPasses: false };

test('useSingleGlComposite: only the plain transformed view with a WebGL persona and no 2D overlay pass', () => {
  assert.equal(useSingleGlComposite(ok), true);
  assert.equal(useSingleGlComposite({ ...ok, flag: false }), false, 'flag off keeps the 2D path');
  for (const viewMode of ['split', 'side-by-side', 'pip']) assert.equal(useSingleGlComposite({ ...ok, viewMode }), false, viewMode);
  assert.equal(useSingleGlComposite({ ...ok, overlayReady: false }), false, 'no persona this frame');
  assert.equal(useSingleGlComposite({ ...ok, webgl: false }), false, 'Canvas 2D fallback');
  assert.equal(useSingleGlComposite({ ...ok, overlayPasses: true }), false, 'geometric hairline passes still run in 2D');
});

test('baseFrameUv matches the cover layout of the 2D drawImage, mirrored and not', () => {
  // A 1280×720 frame cover-fitted into a 960×720 canvas: 160 px cropped on each side.
  const layout = { offsetX: -160, offsetY: 0, drawWidth: 1280, drawHeight: 720, mirror: false };
  assert.deepEqual(baseFrameUv(0, 0, 960, layout), [160 / 1280, 0]);
  assert.deepEqual(baseFrameUv(960, 720, 960, layout), [1120 / 1280, 1]);
  assert.deepEqual(baseFrameUv(480, 360, 960, layout), [0.5, 0.5]);
  // Mirrored (webcam): the left edge of the output shows the right side of the source.
  const m = { ...layout, mirror: true };
  assert.deepEqual(baseFrameUv(0, 0, 960, m), [1120 / 1280, 0]);
  assert.deepEqual(baseFrameUv(960, 0, 960, m), [160 / 1280, 0]);
  assert.deepEqual(baseFrameUv(480, 360, 960, m), [0.5, 0.5]);
  // Letterboxed: outside the frame there is no source pixel (the background colour shows).
  const letter = { offsetX: 0, offsetY: 90, drawWidth: 960, drawHeight: 540, mirror: false };
  assert.equal(baseFrameUv(100, 50, 960, letter), null);
  assert.deepEqual(baseFrameUv(0, 90, 960, letter), [0, 0]);
  assert.equal(baseFrameUv(100, 700, 960, letter), null);
});

test('compositeUnder equals drawing the premultiplied persona over the base', () => {
  const base: [number, number, number] = [0.2, 0.4, 0.6];
  // Source-over of a premultiplied layer: out = layer + base · (1 − alpha).
  const over = (l: [number, number, number, number]) => [l[0] + base[0] * (1 - l[3]), l[1] + base[1] * (1 - l[3]), l[2] + base[2] * (1 - l[3]), 1];
  for (const layer of [
    [0, 0, 0, 0],
    [0.5, 0.25, 0.1, 0.5],
    [0.9, 0.8, 0.7, 1],
    [0.03, 0.02, 0.01, 0.05],
  ] as Array<[number, number, number, number]>) {
    assert.deepEqual(compositeUnder(layer, base), over(layer));
  }
  // No persona: the base. Opaque persona: the persona.
  assert.deepEqual(compositeUnder([0, 0, 0, 0], base), [0.2, 0.4, 0.6, 1]);
  assert.deepEqual(compositeUnder([0.9, 0.8, 0.7, 1], base), [0.9, 0.8, 0.7, 1]);
});

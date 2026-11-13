import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFaceRect, referenceRect } from './auditLayout.ts';

test('auditFaceRect pads the landmark box and clips it to the frame', () => {
  const pts = new Float32Array(478 * 2);
  for (let i = 0; i < 468; i++) {
    pts[i * 2] = 600 + (i % 2) * 100; // x 600..700
    pts[i * 2 + 1] = 300 + (i % 3 === 0 ? 0 : 120); // y 300..420
  }
  const r = auditFaceRect(pts, 1280, 720);
  assert.deepEqual(r, { x: 570, y: 258, w: 160, h: 192 });
  const edge = auditFaceRect(pts.map((v, i) => (i % 2 === 0 ? v - 600 : v)), 1280, 720);
  assert.equal(edge.x, 0, 'clipped at the left edge');
});

test('referenceRect keeps the face-crop aspect inside the photo', () => {
  const r = referenceRect(1280, 720, 0.8);
  assert.ok(Math.abs(r.w / r.h - 0.8) < 1e-9);
  assert.ok(Math.abs(r.h - 432) < 1e-9);
  assert.ok(r.x >= 0 && r.x + r.w <= 1280 && r.y >= 0 && r.y + r.h <= 720);
  const wide = referenceRect(400, 1000, 3);
  assert.equal(wide.w, 400, 'width-limited');
  assert.ok(Math.abs(wide.h - 400 / 3) < 1e-9);
  assert.deepEqual(referenceRect(100, 100, Number.NaN), referenceRect(100, 100, 1), 'bad aspect falls back to square');
});

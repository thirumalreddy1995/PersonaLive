import test from 'node:test';
import assert from 'node:assert/strict';
import { FACE_OVAL_RING, LANDMARK_COUNT } from '../../tools/realism/landmarks.ts';
import { cropUvs, faceOvalBounds, planCrop } from './personaCrop.ts';

function face(cx: number, cy: number, rx: number, ry: number): Float32Array {
  const pts = new Float32Array(LANDMARK_COUNT * 2);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    pts[i * 2] = cx;
    pts[i * 2 + 1] = cy;
  }
  FACE_OVAL_RING.forEach((idx, k) => {
    const a = (2 * Math.PI * k) / FACE_OVAL_RING.length;
    pts[idx * 2] = cx + rx * Math.cos(a);
    pts[idx * 2 + 1] = cy + ry * Math.sin(a);
  });
  return pts;
}

test('planCrop takes 1.6× the face oval, clamps to the photo and caps the long edge', () => {
  const pts = face(0.5, 0.45, 0.15, 0.2); // in a 2000×2400 photo: oval 600×960
  const plan = planCrop(pts, 2000, 2400, 1024);
  assert.equal(plan.sw, 960);
  assert.equal(plan.sh, 1536);
  assert.equal(plan.sx, 520);
  assert.equal(plan.sy, 312);
  assert.equal(plan.height, 1024);
  assert.equal(plan.width, 640);
  assert.ok(Math.abs(plan.scale - 1024 / 1536) < 1e-9);
  // Small photo: never upscaled, crop clamped to the edges.
  const small = planCrop(face(0.5, 0.5, 0.45, 0.45), 400, 400, 1024);
  assert.equal(small.sx, 0);
  assert.equal(small.sw, 400);
  assert.equal(small.width, 400);
  assert.equal(small.scale, 1);
});

test('cropUvs maps the oval into the crop so the face sits inside 0..1', () => {
  const pts = face(0.5, 0.45, 0.15, 0.2);
  const plan = planCrop(pts, 2000, 2400, 1024);
  const uv = cropUvs(pts, 2000, 2400, plan);
  const b = faceOvalBounds(uv, 1, 1);
  assert.ok(b.minX > 0.15 && b.maxX < 0.85 && b.minY > 0.15 && b.maxY < 0.85, JSON.stringify(b));
  // The oval centre lands at the crop centre.
  assert.ok(Math.abs((b.minX + b.maxX) / 2 - 0.5) < 1e-6);
  assert.ok(Math.abs((b.minY + b.maxY) / 2 - 0.5) < 1e-6);
});

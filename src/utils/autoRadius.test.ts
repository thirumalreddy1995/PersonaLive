import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_RADIUS_MAX,
  AUTO_RADIUS_MIN,
  AUTO_RADIUS_STEP_UP,
  initialAutoRadius,
  measureShading,
  patchMeanLab,
  shadingPatches,
  stepAutoRadius,
  toReadback,
} from './autoRadius.ts';
import { ciede2000, rgbToLab } from './color.ts';

test('stepAutoRadius raises slowly while the excesses are small, holds in the band, backs off faster above it', () => {
  let s = initialAutoRadius();
  const calm = { sideOut: 1, sideDrv: 0.5, neckOut: 20, neckDrv: 19 };
  for (let i = 0; i < 10; i++) s = stepAutoRadius(s, calm);
  assert.ok(Math.abs(s.radius - (AUTO_RADIUS_MIN + 10 * AUTO_RADIUS_STEP_UP)) < 1e-9, `rose by ten steps (${s.radius})`);
  assert.ok(s.sideExcess !== null && s.sideExcess < 0.6 && s.neckExcess !== null && s.neckExcess < 1.1);
  // Inside the hysteresis band (2.5..3.5) nothing moves once the EMA is there, while it keeps tracking.
  for (let i = 0; i < 40; i++) s = stepAutoRadius(s, { sideOut: 3, sideDrv: 0, neckOut: 20, neckDrv: 19 }, { hold: true });
  assert.ok(Math.abs(s.sideExcess! - 3) < 0.05);
  const r0 = s.radius;
  for (let i = 0; i < 40; i++) s = stepAutoRadius(s, { sideOut: 3, sideDrv: 0, neckOut: 20, neckDrv: 19 });
  assert.equal(s.radius, r0);
  // Clearly leaking: the radius comes down and never below the minimum.
  for (let i = 0; i < 40; i++) s = stepAutoRadius(s, { sideOut: 8, sideDrv: 0, neckOut: 20, neckDrv: 19 });
  assert.equal(s.radius, AUTO_RADIUS_MIN);
  // Held updates record but do not move.
  const held = stepAutoRadius(s, calm, { hold: true });
  assert.equal(held.radius, s.radius);
  assert.ok(held.sideExcess! < s.sideExcess!);
  // Calm for long enough reaches the maximum and stays there.
  for (let i = 0; i < 200; i++) s = stepAutoRadius(s, calm);
  assert.equal(s.radius, AUTO_RADIUS_MAX);
});

test('toReadback maps display pixels into flipped and mirrored readback windows', () => {
  const m = { x0: 100, y0: 50, w: 200, h: 200, size: 160, flipY: false, mirrorX: false };
  assert.deepEqual(toReadback(m, 100, 50), { px: 0, py: 0 });
  assert.deepEqual(toReadback({ ...m, flipY: true }, 100, 50), { px: 0, py: 160 });
  assert.deepEqual(toReadback({ ...m, mirrorX: true }, 100, 250), { px: 160, py: 160 });
});

test('patchMeanLab and measureShading read cheek and neck patches and skip transparent pixels', () => {
  const size = 40;
  const data = new Uint8Array(size * size * 4);
  // Left half bright skin, right half darker skin; bottom-right corner transparent.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      const bright = x < size / 2;
      data[p] = bright ? 220 : 150;
      data[p + 1] = bright ? 170 : 110;
      data[p + 2] = bright ? 140 : 90;
      data[p + 3] = x > 30 && y > 30 ? 0 : 255;
    }
  }
  const left = patchMeanLab(data, size, 10, 20, 4)!;
  const right = patchMeanLab(data, size, 30, 20, 4)!;
  assert.ok(left[0] > right[0] + 15, 'left patch is lighter');
  assert.equal(patchMeanLab(data, size, 36, 36, 2), null, 'transparent corner is unreadable');
  // Map a 400 px display square onto the window; landmarks put the cheeks at display x 100 / 300.
  const mapping = { x0: 0, y0: 0, w: 400, h: 400, size, flipY: false, mirrorX: false };
  const pts = new Float32Array(468 * 2);
  pts[280 * 2] = 100; pts[280 * 2 + 1] = 200; // left cheek
  pts[50 * 2] = 300; pts[50 * 2 + 1] = 200; // right cheek
  pts[152 * 2] = 300; pts[152 * 2 + 1] = 200; // chin on the darker half: neck patch 0.22 × faceHeight below it
  const patches = shadingPatches(pts, 200, 400);
  const m = measureShading(data, mapping, patches)!;
  assert.ok(Math.abs(m.side - (left[0] - right[0])) < 1e-9);
  const neckLab = rgbToLab([150, 110, 90]);
  assert.ok(m.neck !== null && m.neck > 5 && Math.abs(m.neck - ciede2000(m.cheek, neckLab)) < 0.5, `neck ΔE ${m.neck}`);
  // Mirrored driver window: the same landmarks now read the opposite halves, so the sign flips.
  const mirrored = measureShading(data, { ...mapping, mirrorX: true }, patches)!;
  assert.ok(Math.abs(mirrored.side + m.side) < 1e-9);
});

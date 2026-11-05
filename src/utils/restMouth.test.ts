import test from 'node:test';
import assert from 'node:assert/strict';
import { LIP_FADE_END, LIP_FADE_START, LIP_FADE_WIDTH, REST_MOUTH_WINDOW_MS, RestMouthCalibrator, lipFadeWindow } from './restMouth.ts';
import { lipFadeForMar } from './faceMesh.ts';

test('lipFadeWindow keeps the R1 thresholds until the rest aperture is known, then sits above it', () => {
  assert.deepEqual(lipFadeWindow(null), { start: LIP_FADE_START, end: LIP_FADE_END });
  const w = lipFadeWindow(0.09);
  assert.ok(w.start > 0.09 && w.start < 0.12, `start ${w.start}`);
  assert.ok(Math.abs(w.end - w.start - LIP_FADE_WIDTH) < 1e-9);
  // A closed mouth at the learned rest aperture shows the persona lips; a clearly open one fades them.
  assert.equal(lipFadeForMar(0.09, 0, w.start, w.end), 0);
  assert.ok(lipFadeForMar(0.09, 0) > 0.9, 'the fixed thresholds would hide them');
  assert.equal(lipFadeForMar(w.end + 0.1, 0, w.start, w.end), 1);
  const mid = lipFadeForMar((w.start + w.end) / 2, 0, w.start, w.end);
  assert.ok(mid > 0.4 && mid < 0.6);
});

test('RestMouthCalibrator learns a low percentile of the frontal samples over a window and recalibrates', () => {
  const c = new RestMouthCalibrator();
  let t = 0;
  // 2 s of talking at 50 fps, mouth mostly open but closing to 0.08 one frame in five.
  for (let i = 0; i < 100; i++, t += 20) c.push(i % 5 === 0 ? 0.08 : 0.3, t, 0, 0);
  assert.equal(c.rest, null, 'window not complete yet');
  c.push(0.3, t, 0, 0);
  assert.ok(c.rest !== null && Math.abs(c.rest - 0.08) < 1e-9, `rest ${c.rest}`);
  assert.equal(c.windows, 1);
  // A lower estimate replaces the rest at once.
  t += 20;
  for (let i = 0; i <= 100; i++, t += 20) c.push(0.05, t, 0, 0);
  assert.ok(Math.abs(c.rest! - 0.05) < 1e-9, `rest ${c.rest}`);
  // A higher one only nudges it (the wearer may just not have closed the mouth this window).
  t += 20;
  for (let i = 0; i <= 100; i++, t += 20) c.push(0.2, t, 0, 0);
  assert.ok(c.rest! > 0.05 && c.rest! < 0.08, `rest ${c.rest}`);
});

test('RestMouthCalibrator ignores turned heads and restarts after a gap', () => {
  const c = new RestMouthCalibrator();
  let t = 0;
  for (let i = 0; i <= 100; i++, t += 20) c.push(0.01, t, 30, 0);
  assert.equal(c.rest, null, 'turned-away samples never count');
  for (let i = 0; i < 50; i++, t += 20) c.push(0.1, t, 0, 0);
  t += REST_MOUTH_WINDOW_MS + 1000;
  for (let i = 0; i < 50; i++, t += 20) c.push(0.1, t, 0, 0);
  assert.equal(c.rest, null, 'the gap restarted the window');
  for (let i = 0; i <= 60; i++, t += 20) c.push(0.1, t, 0, 0);
  assert.ok(c.rest !== null);
  c.reset();
  assert.equal(c.rest, null);
});

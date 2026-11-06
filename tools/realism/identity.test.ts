import test from 'node:test';
import assert from 'node:assert/strict';
import { flipHorizontal, summarizeIdentity } from './identity.ts';

test('summarizeIdentity averages detected frames and keeps the lowest margin', () => {
  const s = summarizeIdentity([
    { toPersona: 0.6, toDriver: 0.2, margin: 0.4, driverToPersona: 0.1, outputFace: true, driverFace: true },
    { toPersona: 0.4, toDriver: 0.3, margin: 0.1, driverToPersona: 0.12, outputFace: true, driverFace: true },
    { toPersona: null, toDriver: null, margin: null, driverToPersona: 0.08, outputFace: false, driverFace: true },
  ]);
  assert.equal(s.frames, 3);
  assert.equal(s.detected, 2);
  assert.ok(Math.abs(s.toPersona! - 0.5) < 1e-9 && Math.abs(s.toDriver! - 0.25) < 1e-9);
  assert.ok(Math.abs(s.margin! - 0.25) < 1e-9);
  assert.ok(Math.abs(s.minMargin! - 0.1) < 1e-9);
  assert.ok(Math.abs(s.driverToPersona! - 0.1) < 1e-9);
  const none = summarizeIdentity([]);
  assert.equal(none.margin, null);
  assert.equal(none.minMargin, null);
});

test('flipHorizontal mirrors columns', () => {
  const img = { width: 3, height: 1, data: new Uint8Array([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255]) };
  const f = flipHorizontal(img);
  assert.deepEqual(Array.from(f.data.filter((_, i) => i % 4 === 0)), [3, 2, 1]);
});

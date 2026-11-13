import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_BLEND_FULL, resolveLook } from './look.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('camera blend 0 is the Balanced look and 1 the Camera-matched preset', () => {
  assert.deepEqual(resolveLook({ lipFadeFloor: 0, cameraBlend: 0 }), { boundaryFeather: 1, lipFadeFloor: 0 });
  assert.deepEqual(resolveLook({ lipFadeFloor: 0, cameraBlend: 1 }), { boundaryFeather: CAMERA_BLEND_FULL.boundaryFeather, lipFadeFloor: CAMERA_BLEND_FULL.lipFadeFloor });
  const half = resolveLook({ lipFadeFloor: 0, cameraBlend: 0.5 });
  close(half.boundaryFeather, 1.25);
  close(half.lipFadeFloor, 0.15);
  // A settings object without the field (older callers) is the Balanced look.
  assert.deepEqual(resolveLook({ lipFadeFloor: 0 }), { boundaryFeather: 1, lipFadeFloor: 0 });
});

test('an explicit boundary feather wins over the blend', () => {
  assert.equal(resolveLook({ lipFadeFloor: 0, cameraBlend: 1, boundaryFeather: 0.6 }).boundaryFeather, 0.6);
  assert.equal(resolveLook({ lipFadeFloor: 0, cameraBlend: 0, boundaryFeather: 1.5 }).boundaryFeather, 1.5);
});

test('the blend only raises the lip floor, never lowers the user\'s own choice', () => {
  assert.equal(resolveLook({ lipFadeFloor: 0.6, cameraBlend: 1 }).lipFadeFloor, 0.6);
  close(resolveLook({ lipFadeFloor: 0.1, cameraBlend: 1 }).lipFadeFloor, 0.3);
});

test('out-of-range and non-finite values are clamped to the Balanced end', () => {
  assert.deepEqual(resolveLook({ lipFadeFloor: 0, cameraBlend: 5 }), resolveLook({ lipFadeFloor: 0, cameraBlend: 1 }));
  assert.deepEqual(resolveLook({ lipFadeFloor: 0, cameraBlend: -1 }), { boundaryFeather: 1, lipFadeFloor: 0 });
  assert.deepEqual(resolveLook({ lipFadeFloor: Number.NaN, cameraBlend: Number.NaN }), { boundaryFeather: 1, lipFadeFloor: 0 });
  assert.equal(resolveLook({ lipFadeFloor: 0, boundaryFeather: Number.NaN }).boundaryFeather, 1);
  assert.equal(resolveLook({ lipFadeFloor: 2 }).lipFadeFloor, 1);
});

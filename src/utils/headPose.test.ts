import test from 'node:test';
import assert from 'node:assert/strict';
import { driverPoseFromMatrix, eulerToMatrix, matrixToEuler } from './headPose.ts';
import { decomposeTransform, poseAngles, rotate } from './rigidPose.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test('matrixToEuler inverts eulerToMatrix across the working range', () => {
  for (const yaw of [-60, -40, -25, 0, 12.5, 25, 40, 60]) {
    for (const pitch of [-45, -25, -15, 0, 7, 15, 25, 45]) {
      for (const roll of [-30, -20, 0, 5, 20, 30]) {
        const e = matrixToEuler(eulerToMatrix(yaw, pitch, roll));
        assert.ok(e, `${yaw}/${pitch}/${roll}`);
        assert.ok(near(e.yaw, yaw, 1e-9) && near(e.pitch, pitch, 1e-9) && near(e.roll, roll, 1e-9), `${yaw}/${pitch}/${roll} → ${JSON.stringify(e)}`);
      }
    }
  }
  assert.deepEqual(matrixToEuler(eulerToMatrix(0, 0, 0)), { yaw: 0, pitch: 0, roll: 0 });
});

test('matrixToEuler ignores scale and translation and reads both storage orders', () => {
  const ref = matrixToEuler(eulerToMatrix(20, -10, 5))!;
  // MediaPipe's matrix carries the model scale and a translation in cm.
  const scaled = matrixToEuler(eulerToMatrix(20, -10, 5, 7.3, [3, -2, -42]))!;
  assert.ok(near(scaled.yaw, ref.yaw) && near(scaled.pitch, ref.pitch) && near(scaled.roll, ref.roll));
  // The same matrix stored row-major (translation in elements 3, 7, 11).
  const cm = eulerToMatrix(20, -10, 5, 7.3, [3, -2, -42]);
  const rm = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) rm[r * 4 + c] = cm[c * 4 + r];
  const fromRows = matrixToEuler(rm)!;
  assert.ok(near(fromRows.yaw, 20) && near(fromRows.pitch, -10) && near(fromRows.roll, 5));
  // Non-uniform scale per axis is removed too.
  const stretched = [...cm];
  for (let r = 0; r < 3; r++) stretched[r] *= 1.4; // first column
  const s = matrixToEuler(stretched)!;
  assert.ok(near(s.yaw, 20) && near(s.pitch, -10) && near(s.roll, 5));
});

test('matrixToEuler: axis meaning matches the documented convention', () => {
  // The face looks along +z of the model. Rotate that direction with the matrix and see where the nose goes.
  const nose = (yaw: number, pitch: number, roll: number) => {
    const m = eulerToMatrix(yaw, pitch, roll);
    return [m[8], m[9], m[10]]; // third column = image of (0, 0, 1)
  };
  assert.ok(nose(30, 0, 0)[0] > 0.49, 'positive yaw turns the nose toward +x');
  assert.ok(nose(-30, 0, 0)[0] < -0.49);
  assert.ok(nose(0, 20, 0)[1] < -0.3, 'positive pitch tips the nose down (y is up)');
  assert.ok(nose(0, -20, 0)[1] > 0.3);
  // Roll alone leaves the nose direction alone and turns the up vector counter-clockwise.
  const up = eulerToMatrix(0, 0, 20);
  assert.ok(near(nose(0, 0, 20)[2], 1));
  assert.ok(up[4] < -0.3 && up[5] > 0.9, 'model up (0,1,0) leans toward −x');
});

test('matrixToEuler agrees with the quaternion path of the rigid-pose stabiliser', () => {
  for (const [yaw, pitch, roll] of [[35, -12, 8], [-28, 17, -15], [5, 40, 0], [-50, -30, 25]]) {
    const m = eulerToMatrix(yaw, pitch, roll, 6.5, [1, 2, -38]);
    const direct = matrixToEuler(m)!;
    const viaQuat = poseAngles(decomposeTransform(m)!.q);
    assert.ok(near(direct.yaw, viaQuat.yaw, 1e-4) && near(direct.pitch, viaQuat.pitch, 1e-4) && near(direct.roll, viaQuat.roll, 1e-4), `${yaw}/${pitch}/${roll}`);
    // And with rotating the nose direction by that quaternion.
    const n = rotate(decomposeTransform(m)!.q, [0, 0, 1]);
    assert.ok(near(Math.atan2(n[0], n[2]) * (180 / Math.PI), yaw, 1e-4));
  }
});

test('matrixToEuler handles gimbal lock and rejects malformed input', () => {
  const up = matrixToEuler(eulerToMatrix(25, 90, 0))!;
  assert.ok(near(up.pitch, 90, 1e-3));
  assert.equal(up.roll, 0);
  assert.ok(Number.isFinite(up.yaw));
  const down = matrixToEuler(eulerToMatrix(-10, -90, 0))!;
  assert.ok(near(down.pitch, -90, 1e-3) && down.roll === 0);
  assert.equal(matrixToEuler([1, 2, 3]), null);
  assert.equal(matrixToEuler(new Array(16).fill(0)), null, 'zero rotation columns');
  const nan = eulerToMatrix(1, 2, 3);
  nan[5] = NaN;
  assert.equal(matrixToEuler(nan), null);
});

test('driverPoseFromMatrix: display convention, mirrored and not', () => {
  const m = eulerToMatrix(30, 12, 10);
  // Un-mirrored display: nose toward image right is positive yaw, as for the landmark estimate.
  assert.deepEqual(driverPoseFromMatrix(m, false), { yaw: matrixToEuler(m)!.yaw, pitch: matrixToEuler(m)!.pitch, roll: -matrixToEuler(m)!.roll });
  // Mirrored display (webcam, clips): yaw and roll flip, pitch does not.
  const mirrored = driverPoseFromMatrix(m, true)!;
  assert.ok(near(mirrored.yaw, -30) && near(mirrored.pitch, 12) && near(mirrored.roll, 10));
  // An upright frontal head is 0/0/0 either way (the landmark estimate reports roll near ±180 when mirrored).
  for (const mirror of [true, false]) {
    const p = driverPoseFromMatrix(eulerToMatrix(0, 0, 0), mirror)!;
    assert.ok(near(p.yaw, 0) && near(p.pitch, 0) && near(p.roll, 0));
  }
  assert.equal(driverPoseFromMatrix(null, true), null);
  assert.equal(driverPoseFromMatrix([1, 2], true), null);
});

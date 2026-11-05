import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_FACE_MODEL, CANONICAL_FACE_VERTEX_COUNT } from './canonicalFaceModel.ts';
import {
  BROW_VERTICES,
  FOREHEAD_VERTICES,
  RIGID_FIT_VERTICES,
  RigidPoseStabilizer,
  decomposeTransform,
  fitSimilarity,
  poseAngles,
  projectCanonical,
  rotate,
} from './rigidPose.ts';

/** Row-major 4×4 for a rotation about y (yaw) and x (pitch), with a translation. */
function matrix(yawDeg: number, pitchDeg: number, t: [number, number, number]): number[] {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
  // R = Ry * Rx
  const r = [
    [cy, sy * sp, sy * cp],
    [0, cp, -sp],
    [-sy, cy * sp, cy * cp],
  ];
  return [r[0][0], r[0][1], r[0][2], t[0], r[1][0], r[1][1], r[1][2], t[1], r[2][0], r[2][1], r[2][2], t[2], 0, 0, 0, 1];
}

function transpose(m: number[]): number[] {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = m[r * 4 + c];
  return out;
}

test('vertex sets: forehead sits above the brows and never overlaps them or the fit set', () => {
  assert.ok(FOREHEAD_VERTICES.length >= 40 && FOREHEAD_VERTICES.length <= 80, `${FOREHEAD_VERTICES.length} forehead vertices`);
  assert.ok(FOREHEAD_VERTICES.includes(10) && FOREHEAD_VERTICES.includes(151) && FOREHEAD_VERTICES.includes(338) && FOREHEAD_VERTICES.includes(109));
  // Glabella rows are rigid too; eyelids and everything below stay tracked.
  assert.ok(FOREHEAD_VERTICES.includes(9) && FOREHEAD_VERTICES.includes(8));
  for (const v of [159, 386, 145, 374, 1, 13, 152]) assert.ok(!FOREHEAD_VERTICES.includes(v), `vertex ${v} must stay tracked`);
  for (const v of BROW_VERTICES) assert.ok(!FOREHEAD_VERTICES.includes(v), `brow ${v} in forehead set`);
  for (const v of RIGID_FIT_VERTICES) assert.ok(!FOREHEAD_VERTICES.includes(v) && !BROW_VERTICES.includes(v));
  const eyeY = CANONICAL_FACE_MODEL[159 * 3 + 1];
  for (const v of FOREHEAD_VERTICES) assert.ok(CANONICAL_FACE_MODEL[v * 3 + 1] > eyeY);
});

test('decomposeTransform recovers yaw/pitch and translation from row- and column-major data', () => {
  const m = matrix(20, -10, [1, 2, -50]);
  for (const data of [m, transpose(m)]) {
    const pose = decomposeTransform(data)!;
    assert.ok(pose);
    assert.deepEqual(pose.t.map((v) => Math.round(v * 1000) / 1000), [1, 2, -50]);
    const a = poseAngles(pose.q);
    assert.ok(Math.abs(a.yaw - 20) < 0.01, `yaw ${a.yaw}`);
    assert.ok(Math.abs(a.pitch + 10) < 0.01, `pitch ${a.pitch}`);
    assert.ok(Math.abs(a.roll) < 0.01, `roll ${a.roll}`);
  }
  assert.equal(decomposeTransform([1, 2, 3]), null);
  // Rotating by the quaternion matches the matrix.
  const pose = decomposeTransform(m)!;
  const p = rotate(pose.q, [1, 2, 3]);
  const expect = [m[0] * 1 + m[1] * 2 + m[2] * 3, m[4] * 1 + m[5] * 2 + m[6] * 3, m[8] * 1 + m[9] * 2 + m[10] * 3];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(p[i] - expect[i]) < 1e-6);
});

test('projectCanonical + fitSimilarity reproduce landmarks that came from a scaled projection', () => {
  const pose = decomposeTransform(matrix(8, 5, [0.5, -1, -45]))!;
  const proj = new Float32Array(CANONICAL_FACE_VERTEX_COUNT * 2);
  projectCanonical(pose, proj);
  const s = 900, tx = 640, ty = 360;
  const tracked = new Float32Array(proj.length);
  for (let i = 0; i < proj.length; i += 2) {
    tracked[i] = s * proj[i] + tx;
    tracked[i + 1] = s * proj[i + 1] + ty;
  }
  const fit = fitSimilarity(proj, tracked, RIGID_FIT_VERTICES);
  assert.ok(Math.abs(fit.s - s) < 1e-3 && Math.abs(fit.tx - tx) < 1e-3 && Math.abs(fit.ty - ty) < 1e-3, JSON.stringify(fit));
});

test('the stabiliser removes forehead jitter while the brows keep their expression offset', () => {
  const stab = new RigidPoseStabilizer();
  const s = 900, tx = 640, ty = 360;
  let seed = 7;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const proj = new Float32Array(CANONICAL_FACE_VERTEX_COUNT * 2);
  let jitterTracked = 0;
  let jitterRigid = 0;
  let prevTracked: Float32Array | null = null;
  let prevRigid: Float32Array | null = null;
  let prevClean: Float32Array | null = null;
  const browLift = 6; // px: a raised brow, constant through the sequence
  for (let frame = 0; frame < 90; frame++) {
    const t = frame / 30;
    const pitch = 8 * Math.sin(t * 2); // slow nod
    const pose = decomposeTransform(matrix(0, pitch, [0, 0, -45]))!;
    projectCanonical(pose, proj);
    const tracked = new Float32Array(proj.length);
    for (let v = 0; v < CANONICAL_FACE_VERTEX_COUNT; v++) {
      const noisy = FOREHEAD_VERTICES.includes(v) ? 2.5 : 0.3; // forehead points jitter much more
      tracked[v * 2] = s * proj[v * 2] + tx + rnd() * noisy;
      tracked[v * 2 + 1] = s * proj[v * 2 + 1] + ty + rnd() * noisy - (BROW_VERTICES.includes(v) ? browLift : 0);
    }
    assert.ok(stab.update(matrix(0, pitch, [0, 0, -45]), tracked, frame * (1000 / 30)));
    const smoothed = new Float32Array(tracked);
    stab.apply(smoothed, frame * (1000 / 30));
    const clean = new Float32Array(proj.length);
    for (let i = 0; i < proj.length; i += 2) {
      clean[i] = s * proj[i] + tx;
      clean[i + 1] = s * proj[i + 1] + ty;
    }
    if (frame >= 30 && prevTracked && prevRigid && prevClean) {
      for (const v of FOREHEAD_VERTICES) {
        // Jitter = frame-to-frame motion that is not the clean rigid motion (what texture slide measures).
        const cleanStep = clean[v * 2 + 1] - prevClean[v * 2 + 1];
        jitterTracked += Math.abs(tracked[v * 2 + 1] - prevTracked[v * 2 + 1] - cleanStep);
        jitterRigid += Math.abs(smoothed[v * 2 + 1] - prevRigid[v * 2 + 1] - cleanStep);
      }
      // Brows keep their lift relative to the rigid prediction.
      const v = BROW_VERTICES[2];
      assert.ok(Math.abs(smoothed[v * 2 + 1] - (clean[v * 2 + 1] - browLift)) < 2.5, `brow offset lost: ${smoothed[v * 2 + 1] - clean[v * 2 + 1]}`);
    }
    prevTracked = tracked;
    prevRigid = smoothed;
    prevClean = clean;
  }
  assert.ok(jitterRigid < jitterTracked * 0.35, `rigid ${jitterRigid.toFixed(1)} vs tracked ${jitterTracked.toFixed(1)}`);
  const a = poseAngles(stab.lastPose!.q);
  assert.ok(Math.abs(a.pitch) < 9);
});

test('the rigid forehead fades out across the yaw band so a turned head keeps its tracked points', () => {
  // No shape learning, so the fixed disagreement is not absorbed into the offset on the first frame.
  const stab = new RigidPoseStabilizer({ yawFadeStartDeg: 15, yawFadeEndDeg: 30, learnShape: false });
  const proj = new Float32Array(CANONICAL_FACE_VERTEX_COUNT * 2);
  const run = (yaw: number) => {
    stab.reset();
    const pose = decomposeTransform(matrix(yaw, 0, [0, 0, -45]))!;
    projectCanonical(pose, proj);
    const tracked = new Float32Array(proj.length);
    for (let i = 0; i < proj.length; i += 2) {
      tracked[i] = 900 * proj[i] + 640 + (i % 4 === 0 ? 3 : -3); // a fixed 3 px disagreement
      tracked[i + 1] = 900 * proj[i + 1] + 360;
    }
    assert.ok(stab.update(matrix(yaw, 0, [0, 0, -45]), tracked, 0));
    const smoothed = new Float32Array(tracked);
    stab.apply(smoothed, 0);
    const v = FOREHEAD_VERTICES[0];
    return { weight: stab.lastWeight, moved: Math.abs(smoothed[v * 2] - tracked[v * 2]) };
  };
  const frontal = run(0);
  assert.equal(frontal.weight, 1);
  assert.ok(frontal.moved > 0.5, 'frontal: forehead follows the rigid model');
  const turned = run(45);
  assert.equal(turned.weight, 0);
  assert.equal(turned.moved, 0, 'turned: tracked points untouched');
  const mid = run(22.5);
  assert.ok(mid.weight > 0.3 && mid.weight < 0.7, `mid weight ${mid.weight}`);
});


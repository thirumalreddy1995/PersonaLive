import test from 'node:test';
import assert from 'node:assert/strict';
import { EnrollmentShotSnapshot, StepTally, buildEnrollmentExport, shotBytes, shotFileName } from './enrollExport.ts';

const STEPS = ['frontal', 'yaw-right', 'yaw-left', 'pitch-up', 'pitch-down', 'open-mouth', 'smile'];
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

function shot(stepId: string): EnrollmentShotSnapshot {
  return {
    stepId,
    label: stepId,
    dataUrl: JPEG,
    sha256: 'a'.repeat(64),
    pose: { yaw: 0, pitch: 0, roll: 0 },
    matrixPose: null,
    expression: { mar: 0, smile: 0, browElevation: 0 },
    quality: { sharpness: 10, meanLuma: 120, clippedShare: 0 },
  };
}

const base = { steps: STEPS, refusals: [], name: 'test', category: 'men' as const, camera: 'fake-device' as const, cameraFile: 'cam.mjpeg', createdAt: '2026-11-12T00:00:00.000Z' };

test('export: plan order, frontal first, files instead of data URLs, no consent record', () => {
  const e = buildEnrollmentExport({ ...base, saved: true, shots: [...STEPS].reverse().map(shot) });
  assert.deepEqual(e.shots.map((s) => s.stepId), STEPS);
  assert.equal(e.shots[0].file, 'frontal.jpg');
  assert.equal(e.complete, true);
  assert.equal(e.reviewOnly, true);
  const text = JSON.stringify(e);
  assert.ok(!text.includes('data:image'));
  assert.ok(!/consent|signature|signerName/i.test(text));
});

test('export: a missing step or an unsaved dialog is incomplete', () => {
  const six = STEPS.filter((s) => s !== 'open-mouth').map(shot);
  const refusal = new StepTally().refusal('open-mouth', 60000);
  const e = buildEnrollmentExport({ ...base, saved: false, shots: six, refusals: [refusal] });
  assert.equal(e.complete, false);
  assert.equal(e.shots.length, 6);
  assert.deepEqual(e.refusals.map((r) => r.stepId), ['open-mouth']);
  assert.equal(buildEnrollmentExport({ ...base, saved: false, shots: STEPS.map(shot) }).complete, false);
});

test('export: a refusal of a step that was taken later is dropped', () => {
  const e = buildEnrollmentExport({ ...base, saved: true, shots: STEPS.map(shot), refusals: [new StepTally().refusal('smile', 1000)] });
  assert.equal(e.refusals.length, 0);
});

test('export: no frontal shot is an error', () => {
  assert.throws(() => buildEnrollmentExport({ ...base, saved: false, shots: [shot('smile')] }), /frontal/);
});

test('shot files: name from the step and type, bytes from the data URL', () => {
  assert.equal(shotFileName('yaw-left', JPEG), 'yaw-left.jpg');
  assert.throws(() => shotFileName('../x', JPEG));
  assert.throws(() => shotFileName('smile', 'data:text/plain;base64,AA=='));
  assert.deepEqual([...shotBytes(JPEG)], [0xff, 0xd8, 0xff, 0xd9]);
});

test('tally: pass shares, hints by frequency, expression maxima', () => {
  const t = new StepTally();
  const checks = (expression: boolean) => ({ face: true, pose: true, expression, sharpness: true, exposure: true });
  t.push(checks(false), 'Open your mouth wider.', { mar: 0.2, smile: 0.1 });
  t.push(checks(false), 'Open your mouth wider.', { mar: 0.27, smile: 0 });
  t.push(checks(false), 'Turn a little.', { mar: 0.1, smile: 0.3 });
  t.push(checks(true), null, { mar: 0.1, smile: 0 });
  t.push(null, null, null);
  const r = t.refusal('open-mouth', 5000);
  assert.equal(r.passShare.expression, 0.25);
  assert.equal(r.passShare.face, 1);
  assert.equal(r.hints[0].hint, 'Open your mouth wider.');
  assert.equal(r.hints[0].share, 0.5);
  assert.equal(r.maxMar, 0.27);
  assert.equal(r.maxSmile, 0.3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENROLLMENT_STEPS,
  ENROLL_HOLD_MS,
  ENROLL_MIN_SHARPNESS,
  EnrollmentSample,
  EnrollmentShot,
  ShotHold,
  buildEnrollmentConsent,
  enrollmentComplete,
  enrollmentPersona,
  evaluateShot,
  exposureStats,
  laplacianVariance,
  toLuma,
} from './enrollment.ts';
import { consentPending } from '../types/index.ts';
import { strongerLikenessFor } from '../realism/likeness.ts';

const step = (id: string) => ENROLLMENT_STEPS.find((s) => s.id === id)!;
const good: EnrollmentSample = { faceVisible: true, yaw: 0, pitch: 0, mar: 0.05, smile: 0.1, sharpness: 20, meanLuma: 120, clippedShare: 0.01 };

test('the plan: frontal, ±25° yaw, ±15° pitch, open mouth, smile; frontal first', () => {
  assert.deepEqual(ENROLLMENT_STEPS.map((s) => s.id), ['frontal', 'yaw-right', 'yaw-left', 'pitch-up', 'pitch-down', 'open-mouth', 'smile']);
  assert.deepEqual([step('yaw-right').target.yaw, step('yaw-left').target.yaw], [25, -25]);
  assert.deepEqual([step('pitch-up').target.pitch, step('pitch-down').target.pitch], [-15, 15]);
  assert.equal(step('open-mouth').expression, 'open-mouth');
  assert.equal(step('smile').expression, 'smile');
});

test('evaluateShot: pose relative to the frontal baseline, with hints toward the target', () => {
  // The frontal shot itself: a camera below the face reads −9° of pitch at rest and still passes.
  assert.equal(evaluateShot(step('frontal'), { ...good, pitch: -9 }, null).ok, true);
  const turned = evaluateShot(step('frontal'), { ...good, yaw: 14 }, null);
  assert.equal(turned.ok, false);
  assert.equal(turned.checks.pose, false);
  assert.match(turned.hints[0], /left edge/);

  // Later shots are measured from the baseline (here yaw 2, pitch −9).
  const base = { yaw: 2, pitch: -9 };
  assert.equal(evaluateShot(step('yaw-right'), { ...good, yaw: 27, pitch: -9 }, base).ok, true);
  const notFar = evaluateShot(step('yaw-right'), { ...good, yaw: 12, pitch: -9 }, base);
  assert.equal(notFar.ok, false);
  assert.match(notFar.hints[0], /right edge/);
  const tooFar = evaluateShot(step('yaw-right'), { ...good, yaw: 40, pitch: -9 }, base);
  assert.match(tooFar.hints[0], /left edge/);
  assert.equal(evaluateShot(step('yaw-left'), { ...good, yaw: -23, pitch: -9 }, base).ok, true);
  assert.equal(evaluateShot(step('pitch-up'), { ...good, yaw: 2, pitch: -24 }, base).ok, true);
  const chin = evaluateShot(step('pitch-up'), { ...good, yaw: 2, pitch: -12 }, base);
  assert.equal(chin.ok, false);
  assert.match(chin.hints[0], /Raise your chin/);
  assert.equal(evaluateShot(step('pitch-down'), { ...good, yaw: 2, pitch: 6 }, base).ok, true);
  assert.match(evaluateShot(step('pitch-down'), { ...good, yaw: 2, pitch: -9 }, base).hints[0], /Lower your chin/);
});

test('evaluateShot: expression per step', () => {
  assert.match(evaluateShot(step('frontal'), { ...good, mar: 0.3 }, null).hints[0], /Close your mouth/);
  assert.match(evaluateShot(step('frontal'), { ...good, smile: 0.6 }, null).hints[0], /no smile/);
  assert.equal(evaluateShot(step('open-mouth'), { ...good, mar: 0.4 }, { yaw: 0, pitch: 0 }).ok, true);
  assert.match(evaluateShot(step('open-mouth'), { ...good, mar: 0.1 }, { yaw: 0, pitch: 0 }).hints[0], /wider/);
  // A smile opens the mouth a little: that must not fail the smile shot.
  assert.equal(evaluateShot(step('smile'), { ...good, smile: 0.7, mar: 0.2 }, { yaw: 0, pitch: 0 }).ok, true);
  assert.match(evaluateShot(step('smile'), { ...good, smile: 0.2 }, { yaw: 0, pitch: 0 }).hints[0], /Smile/);
});

test('evaluateShot: a chin-down or chin-up frame is not a frontal shot (R6)', () => {
  // The R5 band of 18 degrees took a 17 degree chin-down frame as the frontal baseline.
  const down = evaluateShot(step('frontal'), { ...good, pitch: 17 }, null);
  assert.equal(down.ok, false);
  assert.equal(down.checks.pose, false);
  assert.match(down.hints[0], /Raise your chin/);
  assert.equal(evaluateShot(step('frontal'), { ...good, pitch: -13 }, null).ok, false);
  assert.equal(evaluateShot(step('frontal'), { ...good, pitch: 9 }, null).ok, true);
  // No frame can be both frontal (absolute) and inside a chin step's band around a level baseline.
  for (let pitch = -30; pitch <= 30; pitch++) {
    const frontal = evaluateShot(step('frontal'), { ...good, pitch }, null).ok;
    const chin = evaluateShot(step('pitch-down'), { ...good, pitch }, { yaw: 0, pitch: 0 }).ok || evaluateShot(step('pitch-up'), { ...good, pitch }, { yaw: 0, pitch: 0 }).ok;
    assert.ok(!(frontal && chin), `pitch ${pitch} passes as frontal and as a chin shot`);
  }
});

test('evaluateShot: the open-mouth shot takes a held "aah" and refuses a half-open mouth (R6)', () => {
  const base = { yaw: 0, pitch: 0 };
  assert.equal(evaluateShot(step('open-mouth'), { ...good, mar: 0.27 }, base).ok, true);
  assert.equal(evaluateShot(step('open-mouth'), { ...good, mar: 0.24 }, base).ok, false);
  // The neutral shots still require a closed mouth well below it.
  assert.equal(evaluateShot(step('frontal'), { ...good, mar: 0.2 }, null).ok, false);
});

test('evaluateShot: blur, exposure and a missing face block the shot', () => {
  const blurred = evaluateShot(step('frontal'), { ...good, sharpness: ENROLL_MIN_SHARPNESS - 1 }, null);
  assert.equal(blurred.ok, false);
  assert.equal(blurred.checks.sharpness, false);
  assert.match(blurred.hints[0], /blurred/);
  assert.match(evaluateShot(step('frontal'), { ...good, meanLuma: 30 }, null).hints[0], /Too dark/);
  assert.match(evaluateShot(step('frontal'), { ...good, meanLuma: 230 }, null).hints[0], /Too bright/);
  assert.match(evaluateShot(step('frontal'), { ...good, clippedShare: 0.2 }, null).hints[0], /exposed/);
  // Not measured yet: not passed, and no misleading hint.
  const unmeasured = evaluateShot(step('frontal'), { ...good, sharpness: null, meanLuma: null, clippedShare: null }, null);
  assert.equal(unmeasured.ok, false);
  assert.deepEqual(unmeasured.hints, []);
  const none = evaluateShot(step('frontal'), { ...good, faceVisible: false }, null);
  assert.deepEqual(none.checks, { face: false, pose: false, expression: false, sharpness: false, exposure: false });
  assert.match(none.hints[0], /No face/);
});

test('ShotHold fires after a continuous, still pass and restarts on a failed frame or a moving head', () => {
  const hold = new ShotHold();
  let t = 0;
  let fired = 0;
  for (; t < ENROLL_HOLD_MS; t += 33) if (hold.push(true, { yaw: 0, pitch: 0 }, t)) fired++;
  assert.equal(fired, 0, 'not before the hold time');
  assert.ok(hold.progress(t) > 0.9);
  assert.equal(hold.push(true, { yaw: 0, pitch: 0 }, ENROLL_HOLD_MS + 5), true);
  // One failed frame restarts it.
  const h2 = new ShotHold();
  for (t = 0; t < 400; t += 33) h2.push(true, { yaw: 0, pitch: 0 }, t);
  h2.push(false, { yaw: 0, pitch: 0 }, t);
  assert.equal(h2.progress(t), 0);
  let done = false;
  for (t += 33; t < 400 + 33 + ENROLL_HOLD_MS - 40; t += 33) done = done || h2.push(true, { yaw: 0, pitch: 0 }, t);
  assert.equal(done, false);
  // A head still turning (30°/s) never fires even though every frame passes the pose check.
  const h3 = new ShotHold();
  let moving = false;
  for (t = 0; t < 2000; t += 33) moving = moving || h3.push(true, { yaw: (t / 1000) * 30, pitch: 0 }, t);
  assert.equal(moving, false);
  // Slow drift (3°/s) is still.
  const h4 = new ShotHold();
  let drift = false;
  for (t = 0; t < 1000; t += 33) drift = drift || h4.push(true, { yaw: (t / 1000) * 3, pitch: 0 }, t);
  assert.equal(drift, true);
});

test('laplacianVariance separates a sharp image from a blurred one; exposureStats measures brightness and clipping', () => {
  const w = 64, h = 64;
  const sharp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sharp[y * w + x] = (x >> 2) % 2 ^ (y >> 2) % 2 ? 200 : 60;
  // 5×5 box blur of the same image.
  const blurred = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += sharp[yy * w + xx];
          n++;
        }
      }
      blurred[y * w + x] = Math.round(s / n);
    }
  }
  const vs = laplacianVariance(sharp, w, h);
  const vb = laplacianVariance(blurred, w, h);
  assert.ok(vs > 20 * vb, `sharp ${vs} vs blurred ${vb}`);
  assert.equal(laplacianVariance(new Uint8Array(w * h).fill(128), w, h), 0);
  assert.equal(laplacianVariance(new Uint8Array(4), 2, 2), 0);

  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 100, 100, 100, 255, 200, 50, 50, 255]);
  const luma = toLuma(rgba, 2, 2);
  assert.deepEqual(Array.from(luma), [255, 0, 100, Math.round(0.299 * 200 + 0.587 * 50 + 0.114 * 50)]);
  const e = exposureStats(luma);
  assert.equal(e.clippedShare, 0.5);
  assert.ok(Math.abs(e.meanLuma - (255 + 0 + 100 + luma[3]) / 4) < 1e-9);
  assert.deepEqual(exposureStats(new Uint8Array(0)), { meanLuma: 0, clippedShare: 1 });
});

const hash = (c: string) => c.repeat(64);
const shots = (): EnrollmentShot[] =>
  ENROLLMENT_STEPS.map((s, i) => ({
    stepId: s.id,
    label: s.label,
    dataUrl: `data:image/jpeg;base64,${s.id}`,
    sha256: hash('0123456789abcdef'[i]),
    pose: { yaw: s.target.yaw, pitch: s.target.pitch - 8, roll: 0 },
    matrixPose: { yaw: s.target.yaw, pitch: s.target.pitch, roll: 0 },
    expression: { mar: s.expression === 'open-mouth' ? 0.4 : 0.05, smile: s.expression === 'smile' ? 0.7 : 0.1, browElevation: 0.1 },
    quality: { sharpness: 18, meanLuma: 125, clippedShare: 0.01 },
  }));
const signed = { signerName: '  Test Person ', attested: true, scope: { liveCalls: true, cloudProcessing: false, recordings: false }, signedAt: '2026-11-12T10:00:00.000Z' };

test('buildEnrollmentConsent: a signed record covering every shot, only with the attestation', () => {
  const rec = buildEnrollmentConsent(signed, shots());
  assert.equal(rec.status, 'signed');
  assert.equal(rec.verified, true);
  assert.equal(consentPending(rec), false);
  assert.equal(rec.signerName, 'Test Person');
  assert.deepEqual(rec.scope, { liveCalls: true, cloudProcessing: false, recordings: false });
  assert.equal(rec.imageHashes!.length, ENROLLMENT_STEPS.length);
  assert.equal(rec.authorizedUsage, 'live video calls where all participants know they see a persona');
  assert.equal(rec.signatureHash, `sha256:${'0'.repeat(16)}@2026-11-12`);
  assert.match(buildEnrollmentConsent({ ...signed, scope: { liveCalls: true, cloudProcessing: true, recordings: true } }, shots()).authorizedUsage, /cloud processing.*recordings/);

  // The gate stays closed without each of these.
  assert.throws(() => buildEnrollmentConsent({ ...signed, attested: false }, shots()), /Only the person at the camera/);
  assert.throws(() => buildEnrollmentConsent({ ...signed, signerName: '   ' }, shots()), /name/);
  assert.throws(() => buildEnrollmentConsent({ ...signed, scope: { liveCalls: false, cloudProcessing: false, recordings: false } }, shots()), /live video calls/);
  assert.throws(() => buildEnrollmentConsent(signed, []), /No reference shots/);
  const unhashed = shots();
  unhashed[2].sha256 = '';
  assert.throws(() => buildEnrollmentConsent(signed, unhashed), /hashed/);
});

test('enrollmentPersona: frontal photo, all references in plan order, and only with a signed record that covers them', () => {
  const all = shots();
  const consent = buildEnrollmentConsent(signed, all);
  // Shots may arrive in any order (retakes).
  const persona = enrollmentPersona({ id: 'persona-enroll-1', name: ' Test Person ', category: 'men', width: 1280, height: 720 }, [...all].reverse(), consent);
  assert.equal(persona.name, 'Test Person');
  assert.equal(persona.imageUrl, all[0].dataUrl);
  assert.deepEqual(persona.references!.map((r) => r.id), ENROLLMENT_STEPS.map((s) => `persona-enroll-1-${s.id}`));
  assert.deepEqual(persona.references![1].pose, { yaw: 25, pitch: -8, roll: 0 });
  assert.deepEqual(persona.references![1].matrixPose, { yaw: 25, pitch: 0, roll: 0 });
  assert.equal(persona.consent, consent);
  assert.equal(persona.metrics.resolution, '1280 × 720 px');
  assert.equal(consentPending(persona.consent), false);
  // A guided enrollment opens with Stronger likeness on (no user choice stored yet).
  assert.equal(persona.strongerLikeness, undefined);
  assert.equal(strongerLikenessFor(persona), true);

  assert.equal(enrollmentComplete(all), true);
  assert.equal(enrollmentComplete(all.slice(0, 6)), false);
  assert.throws(() => enrollmentPersona({ id: 'x', name: 'x', category: 'men', width: 1, height: 1 }, all.slice(0, 6), consent), /incomplete/);
  assert.throws(() => enrollmentPersona({ id: 'x', name: 'x', category: 'men', width: 1, height: 1 }, all, { ...consent, status: 'pending', verified: false }), /not signed/);
  // A retake after signing changes a hash: the old record no longer covers the set.
  const retaken = shots();
  retaken[3].sha256 = hash('f');
  assert.throws(() => enrollmentPersona({ id: 'x', name: 'x', category: 'men', width: 1, height: 1 }, retaken, consent), /does not cover/);
});

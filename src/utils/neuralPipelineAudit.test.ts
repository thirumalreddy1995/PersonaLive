import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiReferenceBank, DriverState } from './multiReferenceBank.ts';
import { CranialBoundaryBlender } from './cranialBoundaryBlender.ts';
import { extractOralApertureMetrics } from './oralCavityRenderer.ts';
import {
  applySpeechAnatomy,
  applyPerspectiveForeshortening,
  pointBounds,
  LM,
} from './faceMesh.ts';

// Helper to create synthetic 468 landmarks
function createSyntheticLandmarks(): Float32Array {
  const pts = new Float32Array(478 * 2);
  // Default canonical positions in 640x480 space
  for (let i = 0; i < 478; i++) {
    pts[i * 2] = 320 + Math.sin(i * 0.1) * 80;
    pts[i * 2 + 1] = 240 + Math.cos(i * 0.1) * 90;
  }
  // Setup well-known landmarks
  pts[LM.NOSE_TIP * 2] = 320;
  pts[LM.NOSE_TIP * 2 + 1] = 240;
  pts[LM.NOSE_BRIDGE * 2] = 320;
  pts[LM.NOSE_BRIDGE * 2 + 1] = 200;
  pts[LM.CHIN * 2] = 320;
  pts[LM.CHIN * 2 + 1] = 360;
  pts[LM.FOREHEAD * 2] = 320;
  pts[LM.FOREHEAD * 2 + 1] = 130;
  pts[8 * 2] = 320;
  pts[8 * 2 + 1] = 175; // brow center
  pts[9 * 2] = 320;
  pts[9 * 2 + 1] = 180; // glabella

  // Eyes
  pts[LM.LEFT_EYE.outer * 2] = 390;
  pts[LM.LEFT_EYE.outer * 2 + 1] = 200;
  pts[LM.LEFT_EYE.inner * 2] = 345;
  pts[LM.LEFT_EYE.inner * 2 + 1] = 200;
  pts[LM.RIGHT_EYE.outer * 2] = 250;
  pts[LM.RIGHT_EYE.outer * 2 + 1] = 200;
  pts[LM.RIGHT_EYE.inner * 2] = 295;
  pts[LM.RIGHT_EYE.inner * 2 + 1] = 200;

  // Mouth
  pts[LM.MOUTH.upperInner * 2] = 320;
  pts[LM.MOUTH.upperInner * 2 + 1] = 285;
  pts[LM.MOUTH.lowerInner * 2] = 320;
  pts[LM.MOUTH.lowerInner * 2 + 1] = 292;
  pts[LM.MOUTH.cornerLeft * 2] = 360;
  pts[LM.MOUTH.cornerLeft * 2 + 1] = 290;
  pts[LM.MOUTH.cornerRight * 2] = 280;
  pts[LM.MOUTH.cornerRight * 2 + 1] = 290;

  return pts;
}

test('MultiReferenceBank: initializes and queries 7-keyframe calibrated suite', () => {
  const masterLandmarks = new Float32Array(468 * 2);
  for (let i = 0; i < 468 * 2; i++) {
    masterLandmarks[i] = 0.5 + (Math.sin(i) * 0.2);
  }
  const dummyCanvas = { width: 1200, height: 1600 } as unknown as HTMLCanvasElement;
  const suite = MultiReferenceBank.synthesizeSuiteFromMaster(dummyCanvas, masterLandmarks, [140, 120, 110]);

  assert.equal(suite.length, 7, 'Suite should contain 7 canonical reference keyframes');

  const bank = new MultiReferenceBank(suite);
  assert.equal(bank.getKeyframes().length, 7);

  // Query 1: Frontal neutral driver
  const q1 = bank.query({ yaw: 0, pitch: 0, roll: 0, mar: 0.02, smile: 0.0, browElevation: 0.0 });
  assert.equal(q1.primary.id, 'ref-canonical-frontal');
  assert.ok(q1.primaryWeight >= 0.7);

  // Query 2: Yaw Left (+30 deg)
  const q2 = bank.query({ yaw: 32, pitch: 2, roll: 0, mar: 0.03, smile: 0.0, browElevation: 0.0 });
  assert.equal(q2.primary.id, 'ref-yaw-left');

  // Query 3: Yaw Right (-30 deg)
  const q3 = bank.query({ yaw: -30, pitch: 0, roll: 0, mar: 0.02, smile: 0.0, browElevation: 0.0 });
  assert.equal(q3.primary.id, 'ref-yaw-right');

  // Query 4: Pitch Up (+18 deg)
  const q4 = bank.query({ yaw: 1, pitch: 18, roll: 0, mar: 0.02, smile: 0.05, browElevation: 0.1 });
  assert.equal(q4.primary.id, 'ref-pitch-up');

  // Query 5: Speech / Open mouth (mar: 0.32)
  const q5 = bank.query({ yaw: 0, pitch: 0, roll: 0, mar: 0.32, smile: 0.1, browElevation: 0.0 });
  assert.equal(q5.primary.id, 'ref-speech-viseme');

  // Query 6: Warm Smile (smile: 0.75)
  const q6 = bank.query({ yaw: 0, pitch: 0, roll: 0, mar: 0.1, smile: 0.75, browElevation: 0.0 });
  assert.equal(q6.primary.id, 'ref-warm-smile');
});

test('MultiReferenceBank: temporal hysteresis prevents rapid frame-to-frame fluttering', () => {
  const masterLandmarks = new Float32Array(468 * 2).fill(0.5);
  const dummyCanvas = { width: 1000, height: 1000 } as unknown as HTMLCanvasElement;
  const suite = MultiReferenceBank.synthesizeSuiteFromMaster(dummyCanvas, masterLandmarks, [128, 128, 128]);
  const bank = new MultiReferenceBank(suite);

  // Driver turns right near threshold
  const r1 = bank.query({ yaw: 24, pitch: 0, roll: 0, mar: 0.02, smile: 0, browElevation: 0 });
  const activeId = r1.primary.id;

  // Tiny jitter (+- 0.5 degrees) should not oscillate back and forth
  const r2 = bank.query({ yaw: 23.5, pitch: 0, roll: 0, mar: 0.02, smile: 0, browElevation: 0 });
  assert.equal(r2.primary.id, activeId, 'Hysteresis must hold active keyframe steady under micro-jitter');
});

test('CranialBoundaryBlender: computeCranialApex projects upwards to natural hairline', () => {
  const pts = createSyntheticLandmarks();
  const { apex, normal, foreheadHeightPx } = CranialBoundaryBlender.computeCranialApex(pts);

  assert.ok(foreheadHeightPx > 30, 'Forehead height should be positive');
  assert.ok(Math.abs(Math.hypot(normal.x, normal.y) - 1.0) < 1e-3, 'Normal must be unit length');
  // In screen space (y downwards), upward projection means smaller Y value
  const foreheadTopY = pts[LM.FOREHEAD * 2 + 1];
  assert.ok(apex.y < foreheadTopY, `Cranial apex (${apex.y}) must extend above forehead top landmark (${foreheadTopY})`);
});

test('OralCavityRenderer & Aperture: accurately extracts mouth dimensions and viseme kinematics', () => {
  const pts = createSyntheticLandmarks();

  // Initially closed mouth
  const mClosed = extractOralApertureMetrics(pts);
  assert.ok(mClosed !== null);
  assert.ok(mClosed!.mar < 0.12, 'Closed mouth should have low MAR');

  // Simulate speaking jaw drop (mar > 0.25)
  pts[LM.MOUTH.lowerInner * 2 + 1] = 315;
  const mOpen = extractOralApertureMetrics(pts);
  assert.ok(mOpen !== null);
  assert.ok(mOpen!.mar > 0.25, 'Open speech mouth should have high MAR');
  assert.ok(mOpen!.jawOpenPx > mClosed!.jawOpenPx);
});

test('Speech anatomy & 3D perspective foreshortening preserve facial structure', () => {
  const pts = createSyntheticLandmarks();
  const initialNoseY = pts[LM.NOSE_TIP * 2 + 1];

  // Under high MAR (speech), speech anatomy prevents upper lip / mustache from sagging downward
  applySpeechAnatomy(pts, 0.35, 230);
  const diffAfter = pts[LM.MOUTH.upperInner * 2 + 1] - initialNoseY;
  assert.ok(diffAfter < 50, 'Upper lip should not sag excessively during open-jaw speech');

  // Test 3D perspective foreshortening
  const boundsBefore = pointBounds(pts.subarray(0, 468 * 2));
  applyPerspectiveForeshortening(pts, 35, 10, boundsBefore.width, boundsBefore.height, {
    x: (boundsBefore.minX + boundsBefore.maxX) / 2,
    y: (boundsBefore.minY + boundsBefore.maxY) / 2,
  });

  for (let i = 0; i < 468 * 2; i++) {
    assert.ok(!Number.isNaN(pts[i]), `Landmark coordinate at index ${i} must not be NaN`);
    assert.ok(Number.isFinite(pts[i]), `Landmark coordinate at index ${i} must be finite`);
  }
});

test('Autonomous Driver Sequence: 30 sequential frames across multi-axis motion execute stably', () => {
  const masterLandmarks = new Float32Array(468 * 2).fill(0.5);
  const dummyCanvas = { width: 1280, height: 720 } as unknown as HTMLCanvasElement;
  const bank = new MultiReferenceBank(
    MultiReferenceBank.synthesizeSuiteFromMaster(dummyCanvas, masterLandmarks, [130, 115, 105])
  );

  const tStart = performance.now();
  let frameCount = 0;

  for (let f = 0; f < 30; f++) {
    // Dynamic trajectory: turning head, speaking phonemes, smiling
    const t = f / 30;
    const yaw = Math.sin(t * Math.PI * 2) * 35; // sweep -35 to +35 deg
    const pitch = Math.cos(t * Math.PI * 2) * 15;
    const mar = 0.05 + Math.abs(Math.sin(t * Math.PI * 4)) * 0.28; // rapid vowel visemes
    const smile = Math.max(0, Math.sin(t * Math.PI * 2));

    const driverState: DriverState = {
      yaw,
      pitch,
      roll: 0,
      mar,
      smile,
      browElevation: 0.1,
    };

    const res = bank.query(driverState);
    assert.ok(res.primary !== null);
    assert.ok(res.primaryWeight >= 0.5 && res.primaryWeight <= 1.0);
    frameCount++;
  }

  const duration = performance.now() - tStart;
  const avgFrameMs = duration / frameCount;

  assert.equal(frameCount, 30);
  assert.ok(avgFrameMs < 1.0, `Average query latency (${avgFrameMs.toFixed(3)}ms) must be well under 1ms`);
});

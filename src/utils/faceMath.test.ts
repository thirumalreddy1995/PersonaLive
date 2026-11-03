import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateEyeAspectRatio,
  calculateMouthAspectRatio,
  estimateHeadPose,
  OneEuroFilter,
  evaluateImageQuality,
  generateConsentHash,
} from './faceMath.ts';

test('calculateEyeAspectRatio computes expected ratio for open vs closed eyes', () => {
  // Open eye coordinates
  const p1 = { x: 10, y: 50 }; // left corner
  const p4 = { x: 30, y: 50 }; // right corner (width = 20)
  const p2 = { x: 15, y: 45 };
  const p6 = { x: 15, y: 55 }; // vertical 1 = 10
  const p3 = { x: 25, y: 45 };
  const p5 = { x: 25, y: 55 }; // vertical 2 = 10

  const earOpen = calculateEyeAspectRatio(p1, p2, p3, p4, p5, p6);
  // (10 + 10) / (2 * 20) = 20 / 40 = 0.5
  assert.equal(earOpen, 0.5);

  // Closed eye coordinates (eyelids touching)
  const p2Closed = { x: 15, y: 50 };
  const p6Closed = { x: 15, y: 51 }; // height = 1
  const p3Closed = { x: 25, y: 50 };
  const p5Closed = { x: 25, y: 51 }; // height = 1

  const earClosed = calculateEyeAspectRatio(p1, p2Closed, p3Closed, p4, p5Closed, p6Closed);
  // (1 + 1) / (2 * 20) = 2 / 40 = 0.05
  assert.equal(earClosed, 0.05);
  assert.ok(earClosed < earOpen);
});

test('calculateMouthAspectRatio detects speech/open mouth', () => {
  const upper = { x: 50, y: 70 };
  const lower = { x: 50, y: 90 }; // height = 20
  const left = { x: 30, y: 80 };
  const right = { x: 70, y: 80 }; // width = 40

  const mar = calculateMouthAspectRatio(upper, lower, left, right);
  // 20 / 40 = 0.5
  assert.equal(mar, 0.5);
});

test('estimateHeadPose computes yaw, pitch and roll correctly', () => {
  const leftEye = { x: 40, y: 50, z: 0 };
  const rightEye = { x: 60, y: 50, z: 0 };
  const nose = { x: 50, y: 65, z: 10 };
  const chin = { x: 50, y: 90, z: 0 };

  const pose = estimateHeadPose(nose, chin, leftEye, rightEye);
  assert.equal(pose.roll, 0); // eyes horizontal
  assert.equal(pose.yaw, 0); // nose centered
  assert.ok(typeof pose.pitch === 'number');
});

test('OneEuroFilter suppresses noise and smooths signal', () => {
  const filter = new OneEuroFilter(1.0, 0.01);
  const now = 1000;
  const initial = filter.filter(10, now);
  assert.equal(initial, 10);

  // Small perturbation should be attenuated
  const smoothed = filter.filter(10.2, now + 33);
  assert.ok(smoothed < 10.2);
  assert.ok(smoothed >= 10.0);
});

test('evaluateImageQuality penalizes low resolution and poor lighting', () => {
  const good = evaluateImageQuality(1920, 1080, 130, 50, 90);
  assert.ok(good.passed);
  assert.ok(good.score >= 85);
  assert.equal(good.lightingCategory, 'Optimal');

  const lowRes = evaluateImageQuality(320, 240, 40, 20, 30);
  assert.ok(!lowRes.passed);
  assert.ok(lowRes.score < 65);
  assert.equal(lowRes.lightingCategory, 'Underexposed');
});

test('generateConsentHash returns unique C2PA compliant identifier', () => {
  const hash1 = generateConsentHash('John Doe', '2026-11-03T10:00:00Z', 1048576);
  assert.ok(hash1.startsWith('C2PA-SEC-'));
  assert.ok(hash1.includes('20261103'));
});

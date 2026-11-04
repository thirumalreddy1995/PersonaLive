import test from 'node:test';
import assert from 'node:assert/strict';
import { computeImageStatistics, sharpnessScoreFromLaplacianVariance, SHARPNESS_REFERENCE_VARIANCE } from './imageStatistics.ts';
import { evaluateImageQuality } from './faceMath.ts';

function rgba(width: number, height: number, pixel: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = pixel(x, y);
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return data;
}

test('a flat grey image has its grey level as luminance and zero contrast/sharpness', () => {
  const stats = computeImageStatistics(rgba(16, 16, () => 128), 16, 16);
  assert.ok(Math.abs(stats.averageLuminance - 128) < 1e-3);
  assert.ok(stats.contrastStdDev < 1e-6);
  assert.equal(stats.estimatedSharpness, 0);
  assert.equal(stats.laplacianVariance, 0);
});

test('a half black / half white image has mid luminance and maximal contrast', () => {
  const stats = computeImageStatistics(rgba(32, 32, (x) => (x < 16 ? 0 : 255)), 32, 32);
  assert.ok(Math.abs(stats.averageLuminance - 127.5) < 1e-3);
  assert.ok(Math.abs(stats.contrastStdDev - 127.5) < 1e-3);
  assert.ok(stats.estimatedSharpness > 0, 'the hard edge registers as detail');
});

test('a checkerboard is sharper than a smooth gradient', () => {
  const checker = computeImageStatistics(rgba(32, 32, (x, y) => ((x + y) % 2 ? 255 : 0)), 32, 32);
  const gradient = computeImageStatistics(rgba(32, 32, (x) => Math.round((x / 31) * 255)), 32, 32);
  assert.equal(checker.estimatedSharpness, 100);
  assert.ok(gradient.estimatedSharpness < 50, `gradient sharpness ${gradient.estimatedSharpness} should read as blurry`);
  assert.ok(checker.laplacianVariance > gradient.laplacianVariance);
});

test('sharpness mapping is monotonic, clamped and anchored at the reference variance', () => {
  assert.equal(sharpnessScoreFromLaplacianVariance(0), 0);
  assert.equal(sharpnessScoreFromLaplacianVariance(-5), 0);
  assert.equal(sharpnessScoreFromLaplacianVariance(Number.NaN), 0);
  assert.equal(sharpnessScoreFromLaplacianVariance(SHARPNESS_REFERENCE_VARIANCE), 100);
  assert.equal(sharpnessScoreFromLaplacianVariance(SHARPNESS_REFERENCE_VARIANCE * 10), 100);
  const low = sharpnessScoreFromLaplacianVariance(10);
  const mid = sharpnessScoreFromLaplacianVariance(100);
  assert.ok(low > 0 && low < mid && mid < 100);
});

test('computeImageStatistics rejects inconsistent buffers', () => {
  assert.throws(() => computeImageStatistics(new Uint8ClampedArray(8), 4, 4), RangeError);
  assert.throws(() => computeImageStatistics(new Uint8ClampedArray(64), 0, 4), RangeError);
  assert.throws(() => computeImageStatistics(new Uint8ClampedArray(64), 2.5, 4), RangeError);
});

test('evaluateImageQuality penalises flat, low-contrast photos', () => {
  const normal = evaluateImageQuality(1920, 1080, 130, 50, 90);
  const flat = evaluateImageQuality(1920, 1080, 130, 10, 90);
  assert.ok(flat.score < normal.score);
  assert.equal(flat.lightingCategory, 'Acceptable');
  assert.ok(flat.warnings.some((w) => /contrast/i.test(w)));
});

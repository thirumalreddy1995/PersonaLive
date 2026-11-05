import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeImageStatistics,
  sharpnessScoreFromLaplacianVariance,
  SHARPNESS_REFERENCE_VARIANCE,
  jpegBlockiness,
  leftRightLuminanceRatio,
} from './imageStatistics.ts';
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

test('jpegBlockiness is ~1 on smooth noise and rises when 8×8 block edges are present', () => {
  const w = 96, h = 96;
  let seed = 5;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const smooth = new Uint8ClampedArray(w * h * 4);
  const blocky = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = 128 + Math.round((rnd() - 0.5) * 20);
      smooth[o] = smooth[o + 1] = smooth[o + 2] = v;
      smooth[o + 3] = 255;
      // Each 8×8 block gets its own flat level: steps only at block boundaries.
      const level = 100 + ((Math.floor(x / 8) * 7 + Math.floor(y / 8) * 13) % 6) * 12;
      blocky[o] = blocky[o + 1] = blocky[o + 2] = level;
      blocky[o + 3] = 255;
    }
  }
  const s = jpegBlockiness(smooth, w, h);
  const b = jpegBlockiness(blocky, w, h);
  assert.ok(s > 0.8 && s < 1.25, `smooth ${s}`);
  assert.ok(b > 5, `blocky ${b}`);
});

test('leftRightLuminanceRatio compares the two halves of a rectangle', () => {
  const w = 40, h = 20;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = x < 20 ? 200 : 100;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  assert.ok(Math.abs(leftRightLuminanceRatio(data, w, { x: 0, y: 0, w: 40, h: 20 }) - 2) < 1e-9);
  assert.equal(leftRightLuminanceRatio(data, w, { x: 0, y: 0, w: 20, h: 20 }), 1);
});

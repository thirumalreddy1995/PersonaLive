import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MATCH_LIMITS, initialCameraMatch, stepCameraMatch } from './cameraMatch.ts';
import { faceStatsFromPixels, toGlslEs3 } from './meshWarpRenderer.ts';

const stats = (laplacianVariance: number, noiseMad: number, samples = 5000) => ({ laplacianVariance, noiseMad, samples });

test('stepCameraMatch blurs a persona that is sharper than the camera and sharpens a softer one', () => {
  let s = initialCameraMatch();
  // Output 8× sharper: the LOD bias rises step by step and sharpen stays 0.
  for (let i = 0; i < 5; i++) s = stepCameraMatch(s, stats(50, 2), stats(400, 1));
  assert.ok(s.lodBias > 1 && s.lodBias <= CAMERA_MATCH_LIMITS.lodBias[1], `lodBias ${s.lodBias}`);
  assert.equal(s.sharpen, 0);
  assert.ok(s.noiseSigma > 0, 'noise added to match the camera');
  // Output now softer than the camera: the bias comes back down and sharpen rises.
  for (let i = 0; i < 12; i++) s = stepCameraMatch(s, stats(400, 1), stats(50, 1));
  assert.ok(s.lodBias < 0.5, `lodBias ${s.lodBias}`);
  assert.ok(s.sharpen > 0.2, `sharpen ${s.sharpen}`);
  // Matched: nothing moves.
  const before = { ...s };
  s = stepCameraMatch(s, stats(100, 1.5), stats(100, 1.5));
  assert.ok(Math.abs(s.lodBias - before.lodBias) < 1e-9 && Math.abs(s.sharpen - before.sharpen) < 1e-9 && Math.abs(s.noiseSigma - before.noiseSigma) < 1e-9);
  assert.equal(s.updates, 18);
  // Too few samples: measurements recorded, controls untouched.
  const few = stepCameraMatch(s, stats(1, 1, 10), stats(1000, 1, 10));
  assert.equal(few.lodBias, s.lodBias);
  assert.equal(few.outputLaplacian, 1000);
});

test('faceStatsFromPixels measures Laplacian variance and noise and skips transparent pixels', () => {
  const w = 32, h = 32;
  const flat = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < w * h; i++) flat[i * 4] = flat[i * 4 + 1] = flat[i * 4 + 2] = 128;
  const f = faceStatsFromPixels(flat, w, h);
  assert.equal(f.laplacianVariance, 0);
  assert.equal(f.noiseMad, 0);
  assert.equal(f.samples, (w - 2) * (h - 2));
  let seed = 3;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const noisy = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = 128 + Math.round((rnd() - 0.5) * 40);
    noisy[i * 4] = noisy[i * 4 + 1] = noisy[i * 4 + 2] = v;
    noisy[i * 4 + 3] = i % w < 8 ? 0 : 255; // left strip transparent
  }
  const n = faceStatsFromPixels(noisy, w, h);
  assert.ok(n.laplacianVariance > 100, `lap ${n.laplacianVariance}`);
  assert.ok(n.noiseMad > 3, `mad ${n.noiseMad}`);
  assert.ok(n.samples < f.samples, 'transparent pixels skipped');
});

test('toGlslEs3 rewrites ES 1.00 shaders for WebGL2', () => {
  const v = toGlslEs3('attribute vec2 aPosition;\nvarying vec2 vUv;\nvoid main() { vUv = aPosition; }', 'vertex');
  assert.ok(v.startsWith('#version 300 es\n'));
  assert.ok(v.includes('in vec2 aPosition;') && v.includes('out vec2 vUv;'));
  const f = toGlslEs3('precision highp float;\nuniform sampler2D uTexture;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = texture2D(uTexture, vUv, 1.0); }', 'fragment');
  assert.ok(f.includes('out vec4 fragColor;') && f.includes('in vec2 vUv;') && f.includes('fragColor = texture(uTexture, vUv, 1.0);'));
  assert.ok(!f.includes('gl_FragColor') && !f.includes('texture2D'));
});

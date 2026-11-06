import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MATCH_EVERY, CAMERA_MATCH_LIMITS, CAMERA_MATCH_WARM_UPDATES, STEADY_DEADBAND, cameraMatchDue, initialCameraMatch, stepCameraMatch } from './cameraMatch.ts';
import { RELIGHT_RADIUS_SHARE, blendMean, blurTaps, derivativesPreamble, faceStatsFromPixels, lowPassSigma, meanChroma, softHoleRadiusPx, toGlslEs3, uvWidth } from './meshWarpRenderer.ts';

const stats = (laplacianVariance: number, noiseMad: number, samples = 5000) => ({ laplacianVariance, noiseMad, samples });

test('stepCameraMatch blurs a persona that is sharper than the camera and sharpens a softer one', () => {
  let s = initialCameraMatch();
  // Output 8× sharper: the LOD bias rises step by step and sharpen stays 0.
  for (let i = 0; i < 5; i++) s = stepCameraMatch(s, stats(50, 2), stats(400, 1));
  assert.ok(s.lodBias > 1 && s.lodBias <= CAMERA_MATCH_LIMITS.lodBias[1], `lodBias ${s.lodBias}`);
  assert.equal(s.sharpen, 0);
  assert.ok(s.noiseSigma > 0, 'noise added to match the camera');
  // Output now softer than the camera: the bias comes back down to 0 first, then sharpen rises.
  for (let i = 0; i < 16; i++) s = stepCameraMatch(s, stats(400, 1), stats(50, 1));
  assert.equal(s.lodBias, 0, `lodBias ${s.lodBias}`);
  assert.ok(s.sharpen > 0.2, `sharpen ${s.sharpen}`);
  // Only one of the two opposing controls is ever away from zero.
  assert.ok(s.lodBias === 0 || s.sharpen === 0);
  // Matched for a while: the smoothed error decays and the controls settle.
  for (let i = 0; i < 8; i++) s = stepCameraMatch(s, stats(100, 1.5), stats(100, 1.5));
  const before = { ...s };
  s = stepCameraMatch(s, stats(100, 1.5), stats(100, 1.5));
  assert.ok(Math.abs(s.sharpen - before.sharpen) < 0.01 && Math.abs(s.noiseSigma - before.noiseSigma) < 1e-9);
  assert.equal(s.updates, 30);
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

test('steady camera match follows a slow EMA, ignores small errors and holds during motion', () => {
  let s = initialCameraMatch();
  // Persona 8× sharper: the steady loop still blurs, but needs more updates than the plain one.
  for (let i = 0; i < 6; i++) s = stepCameraMatch(s, stats(50, 2), stats(400, 1), 0.35, { steady: true });
  const slow = s.lodBias;
  let fast = initialCameraMatch();
  for (let i = 0; i < 6; i++) fast = stepCameraMatch(fast, stats(50, 2), stats(400, 1));
  assert.ok(slow > 0 && slow <= fast.lodBias, `steady ${slow} vs plain ${fast.lodBias}`);
  // Matched: one motion-blurred driver measurement (Laplacian collapses) barely moves the estimate ...
  for (let i = 0; i < 60; i++) s = stepCameraMatch(s, stats(100, 1), stats(100, 1), 0.35, { steady: true });
  const settled = s.lodBias;
  s = stepCameraMatch(s, stats(10, 1), stats(100, 1), 0.35, { steady: true });
  assert.ok(Math.abs(s.lodBias - settled) < 0.15, `one blurred frame moved the bias by ${Math.abs(s.lodBias - settled)}`);
  // ... and a held update moves nothing at all while still recording the measurement.
  const held = stepCameraMatch(s, stats(10, 1), stats(100, 1), 0.35, { steady: true, hold: true });
  assert.equal(held.lodBias, s.lodBias);
  assert.equal(held.driverLaplacian, 10);
  assert.equal(held.driverLogEma, s.driverLogEma);
  // Inside the dead band the controls stay put.
  const inBand = stepCameraMatch(s, stats(100, 1), stats(100 * Math.exp(STEADY_DEADBAND * 0.5), 1), 0.35, { steady: true });
  assert.equal(inBand.lodBias, s.lodBias);
});

test('R3 relight helpers: low-pass sigma, blur taps, soft-hole radius, UV width and the derivatives preamble', () => {
  // 8% of a 300 px face at 1/4 scale is 6 texels; tiny and huge faces are clamped.
  assert.ok(Math.abs(lowPassSigma(300, 0.08) - 6) < 1e-9);
  assert.ok(Math.abs(lowPassSigma(480) - (RELIGHT_RADIUS_SHARE * 480) / 4) < 1e-9, 'the default share at 1/4 scale');
  assert.equal(lowPassSigma(10), 1);
  assert.equal(lowPassSigma(100000), 40);
  // Small sigmas sample every texel; larger ones spread the 15 taps so ±7 taps still cover ~2.8 sigma.
  assert.deepEqual(blurTaps(2), { spacing: 1, sigmaTaps: 2 });
  const wide = blurTaps(10);
  assert.ok(wide.spacing > 1 && Math.abs(wide.sigmaTaps - 2.5) < 1e-9);
  // Soft holes: a bias of 2 at one texel per pixel widens the fade to 6 px; clamped to 1..12.
  assert.ok(Math.abs(softHoleRadiusPx(2, 1) - 6) < 1e-9);
  assert.equal(softHoleRadiusPx(0, 0.1), 1);
  assert.equal(softHoleRadiusPx(4, 2), 12);
  const uv = new Float32Array(468 * 2);
  for (let i = 0; i < 468; i++) uv[i * 2] = 0.2 + (i / 467) * 0.5;
  assert.ok(Math.abs(uvWidth(uv) - 0.5) < 1e-6, `uv width ${uvWidth(uv)} (float32 storage)`);
  assert.equal(uvWidth(new Float32Array(468 * 2)), 1, 'degenerate UVs fall back to 1');
  assert.equal(derivativesPreamble(true, false), '#define HAS_DERIVATIVES 1\n');
  assert.ok(derivativesPreamble(false, true).startsWith('#extension GL_OES_standard_derivatives : enable'));
  assert.equal(derivativesPreamble(false, false), '');
  // The ES3 conversion keeps the version line first and the defines right after it.
  const es3 = toGlslEs3('precision highp float;\nvoid main() {}', 'fragment', '#define HAS_DERIVATIVES 1\n');
  assert.ok(es3.startsWith('#version 300 es\n#define HAS_DERIVATIVES 1\n'));
});

test('meanChroma averages the painted (premultiplied) low pass and normalises by luma', () => {
  const w = 8, h = 4;
  const px = new Uint8Array(w * h * 4);
  // Left half: warm skin at full coverage; right half: unpainted (alpha 0) with garbage colour.
  for (let i = 0; i < w * h; i++) {
    const painted = i % w < 4;
    px[i * 4] = painted ? 200 : 255;
    px[i * 4 + 1] = painted ? 120 : 255;
    px[i * 4 + 2] = painted ? 80 : 255;
    px[i * 4 + 3] = painted ? 255 : 0;
  }
  const m = meanChroma(px, w, h)!;
  const lum = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  assert.ok(Math.abs(lum - 1) < 1e-9, `luma ${lum}`);
  assert.ok(Math.abs(m[0] / m[2] - 200 / 80) < 1e-9, 'channel ratios survive the normalisation');
  // Half coverage with premultiplied colour gives the same chroma.
  const half = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const painted = i % w < 4;
    half[i * 4] = painted ? 100 : 255;
    half[i * 4 + 1] = painted ? 60 : 255;
    half[i * 4 + 2] = painted ? 40 : 255;
    half[i * 4 + 3] = painted ? 128 : 0;
  }
  const m2 = meanChroma(half, w, h)!;
  assert.ok(Math.abs(m2[0] - m[0]) < 0.02 && Math.abs(m2[2] - m[2]) < 0.02);
  assert.equal(meanChroma(new Uint8Array(w * h * 4), w, h), null, 'nothing painted');
  assert.deepEqual(blendMean(null, [1, 2, 3], 0.3), [1, 2, 3]);
  const b = blendMean([1, 1, 1], [2, 1, 0], 0.5);
  assert.deepEqual(b, [1.5, 1, 0.5]);
});

test('cameraMatchDue runs the warm-start updates on consecutive frames, then every 15th frame', () => {
  assert.ok(CAMERA_MATCH_WARM_UPDATES >= 3 && CAMERA_MATCH_EVERY === 15);
  for (let f = 1; f <= 4; f++) assert.ok(cameraMatchDue(f, 2), `frame ${f} is due while warm`);
  assert.ok(!cameraMatchDue(1, 0) && !cameraMatchDue(14, 0));
  assert.ok(cameraMatchDue(15, 0) && cameraMatchDue(0, 0));
  assert.ok(cameraMatchDue(7, 0, 7));
});

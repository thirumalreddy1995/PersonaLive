import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MATCH_EVERY, CAMERA_MATCH_LIMITS, CAMERA_MATCH_SETTLE_FRAMES, CAMERA_MATCH_WARM_UPDATES, STEADY_DEADBAND, cameraMatchDue, cameraMatchDueSettled, initialCameraMatch, stepCameraMatch } from './cameraMatch.ts';
import { RELIGHT_RADIUS_SHARE, blendMean, blurTaps, derivativesPreamble, faceStatsFromPixels, lowPassSigma, meanChroma, meanColour, pairedFaceStats, skinTintGain, softHoleRadiusPx, toGlslEs3, uvWidth } from './meshWarpRenderer.ts';

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

test('pairedFaceStats measures the driver only where the output is opaque (flipped rows, mirrored columns)', () => {
  const w = 32, h = 32;
  let seed = 11;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const grey = (alpha: (x: number, y: number) => number) => {
    const img = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img[i] = img[i + 1] = img[i + 2] = 128;
      img[i + 3] = alpha(x, y);
    }
    return img;
  };
  // Driver: noise only in rows 22..31 and columns 22..31 of its own buffer, flat elsewhere.
  const driver = grey(() => 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y < 22 && x < 22) continue;
    const v = 128 + Math.round((rnd() - 0.5) * 60);
    const i = (y * w + x) * 4;
    driver[i] = driver[i + 1] = driver[i + 2] = v;
  }
  const plain = faceStatsFromPixels(driver, w, h);
  assert.ok(plain.laplacianVariance > 100, `unmasked driver is busy: ${plain.laplacianVariance}`);
  // Output transparent in rows 0..9 (driver rows 22..31 once flipped) and columns 0..9
  // (driver columns 22..31 when mirrored): the paired driver statistics see only flat pixels.
  const output = grey((x, y) => (y < 10 || x < 10 ? 0 : 255));
  const mirrored = pairedFaceStats(output, driver, w, h, { mirror: true });
  assert.equal(mirrored.driver.laplacianVariance, 0);
  assert.equal(mirrored.driver.samples, mirrored.output.samples);
  // Without the mirror the transparent columns land on flat driver columns, the noisy ones count.
  const straight = pairedFaceStats(output, driver, w, h, { mirror: false });
  assert.ok(straight.driver.laplacianVariance > 100, `unmirrored mask keeps the noisy columns: ${straight.driver.laplacianVariance}`);
  // An opaque output leaves the driver statistics as they were.
  const opaque = pairedFaceStats(grey(() => 255), driver, w, h, { mirror: false });
  assert.equal(opaque.driver.laplacianVariance, plain.laplacianVariance);
  assert.equal(opaque.driver.samples, plain.samples);
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

test('meanColour is the coverage-weighted linear colour of a premultiplied low pass (R6b)', () => {
  const w = 8, h = 4;
  const px = new Uint8Array(w * h * 4);
  // Left half: colour (0.8, 0.4, 0.2) at half skin weight (premultiplied); right half unpainted.
  for (let i = 0; i < w * h; i++) {
    const painted = i % w < 4;
    px[i * 4] = painted ? 102 : 255;
    px[i * 4 + 1] = painted ? 51 : 255;
    px[i * 4 + 2] = painted ? 25.5 : 255;
    px[i * 4 + 3] = painted ? 128 : 0;
  }
  const m = meanColour(px, w, h)!;
  assert.ok(Math.abs(m[0] - 0.8) < 0.01 && Math.abs(m[1] - 0.4) < 0.01 && Math.abs(m[2] - 0.2) < 0.01, `mean ${m}`);
  assert.equal(meanColour(new Uint8Array(w * h * 4), w, h), null, 'nothing painted');
});

test('skinTintGain moves the wearer to the shared tone: none at full tone match, all the way at zero (R6b)', () => {
  const persona = [0.3, 0.15, 0.1];
  const wearer = [0.4, 0.25, 0.18];
  assert.deepEqual(skinTintGain(persona, wearer, 1), [1, 1, 1]);
  const full = skinTintGain(persona, wearer, 0);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(full[i] - Math.max(0.5, persona[i] / wearer[i])) < 1e-9);
  const half = skinTintGain(persona, wearer, 0.5);
  assert.ok(Math.abs(half[0] - Math.sqrt(0.3 / 0.4)) < 1e-9);
  assert.deepEqual(skinTintGain([1, 1, 1], [0.01, 0.01, 0.01], 0), [2, 2, 2], 'clamped');
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

test('median camera match (R6): unrepresentative first readings do not wind the sharpen control up', () => {
  // Clip B with keyframes, as traced: two readings just after the persona loads show the output
  // four times softer than the camera; from then on it matches, and later it is several times sharper.
  const sequence: Array<[number, number]> = [
    [16.7, 4.2],
    [16.7, 4.2],
    ...Array.from({ length: 6 }, (): [number, number] => [12, 12.5]),
    ...Array.from({ length: 6 }, (): [number, number] => [12, 80]),
  ];
  const run = (median: boolean) => {
    let s = initialCameraMatch();
    let peak = 0;
    for (const [d, o] of sequence) {
      s = stepCameraMatch(s, stats(d, 1), stats(o, 1), 0.35, { steady: true, median });
      peak = Math.max(peak, s.sharpen);
    }
    return { s, peak };
  };
  const ema = run(false);
  const med = run(true);
  // The slow EMAs keep sharpening long after the output stopped being soft.
  assert.ok(ema.peak > 0.4, `EMA loop peak sharpen ${ema.peak}`);
  // The median loop never moves on the two outliers: too few readings at first, and from the
  // third on the newest reading no longer agrees with the median (anti-windup).
  assert.equal(med.peak, 0, `median loop peak sharpen ${med.peak}`);
  // ...and blurs once the output really is sharper, within the window.
  assert.ok(med.s.lodBias > 0.3, `median loop lodBias ${med.s.lodBias}`);
  assert.equal(med.s.sharpen, 0);
});

test('median camera match (R6): converges on a steady offset, keeps the dead band and skips held readings', () => {
  // A persona that is steadily 3x sharper than the camera: blur rises after MEDIAN_MIN_SAMPLES readings.
  let s = initialCameraMatch();
  s = stepCameraMatch(s, stats(20, 1), stats(60, 1), 0.35, { steady: true, median: true });
  s = stepCameraMatch(s, stats(20, 1), stats(60, 1), 0.35, { steady: true, median: true });
  assert.equal(s.lodBias, 0, 'nothing moves on fewer than three readings');
  for (let i = 0; i < 4; i++) s = stepCameraMatch(s, stats(20, 1), stats(60, 1), 0.35, { steady: true, median: true });
  assert.ok(s.lodBias > 0.8, `lodBias ${s.lodBias}`);
  assert.equal(s.ratioHistory!.length, 6);
  // Held readings (fast head motion) are recorded but never enter the history.
  const held = stepCameraMatch(s, stats(2, 1), stats(60, 1), 0.35, { steady: true, median: true, hold: true });
  assert.equal(held.ratioHistory!.length, 6);
  assert.equal(held.lodBias, s.lodBias);
  assert.equal(held.driverLaplacian, 2);
  // The history is bounded, and a matched output leaves the controls alone (dead band).
  let m = initialCameraMatch();
  for (let i = 0; i < 20; i++) m = stepCameraMatch(m, stats(30, 1), stats(30 * Math.exp(STEADY_DEADBAND * 0.8), 1), 0.35, { steady: true, median: true });
  assert.equal(m.ratioHistory!.length, 7);
  assert.equal(m.lodBias, 0);
  assert.equal(m.sharpen, 0);
  // One motion-blurred reading among matched ones changes nothing.
  m = stepCameraMatch(m, stats(3, 1), stats(30, 1), 0.35, { steady: true, median: true });
  assert.equal(m.lodBias, 0);
});

test('median camera match (R6): no reading for the first frames after a change, then every 15th frame', () => {
  const due: number[] = [];
  for (let frame = 100; frame < 100 + CAMERA_MATCH_SETTLE_FRAMES + 40; frame++) if (cameraMatchDueSettled(frame, frame - 100)) due.push(frame);
  assert.ok(due.length >= 2);
  assert.ok(due[0] - 100 >= CAMERA_MATCH_SETTLE_FRAMES, `first reading ${due[0] - 100} frames after the change`);
  assert.ok(due.every((f) => f % CAMERA_MATCH_EVERY === 0));
  // Windup stops as soon as the newest reading disagrees with the median, and resumes when it agrees again.
  let s = initialCameraMatch();
  for (let i = 0; i < 4; i++) s = stepCameraMatch(s, stats(40, 1), stats(10, 1), 0.35, { steady: true, median: true });
  const rising = s.sharpen;
  assert.ok(rising > 0);
  s = stepCameraMatch(s, stats(40, 1), stats(60, 1), 0.35, { steady: true, median: true });
  assert.equal(s.sharpen, rising, 'held: the newest reading says sharper, the median still says softer');
  s = stepCameraMatch(s, stats(40, 1), stats(10, 1), 0.35, { steady: true, median: true });
  assert.ok(s.sharpen > rising);
});

test('camera match targets (R6): the loop aims for the set sharpness and noise ratios', () => {
  // Output and camera equally sharp: with target 1 nothing moves; with target 1.5 the loop sharpens; with 0.7 it blurs.
  const step = (sharpnessTarget: number, noiseTarget = 1) => {
    let s = initialCameraMatch();
    for (let i = 0; i < 8; i++) s = stepCameraMatch(s, stats(30, 2), stats(30, 2), 0.35, { steady: true, median: true, sharpnessTarget, noiseTarget });
    return s;
  };
  assert.equal(step(1).sharpen + step(1).lodBias, 0);
  assert.ok(step(1.5).sharpen > 0.2 && step(1.5).lodBias === 0);
  assert.ok(step(0.7).lodBias > 0.2 && step(0.7).sharpen === 0);
  // An output already 1.5x sharper satisfies a 1.5 target.
  let s = initialCameraMatch();
  for (let i = 0; i < 8; i++) s = stepCameraMatch(s, stats(30, 2), stats(45, 2), 0.35, { steady: true, median: true, sharpnessTarget: 1.5 });
  assert.equal(s.sharpen + s.lodBias, 0);
  // Noise: target 1 leaves matched noise alone, 1.5 adds some, 0 adds none even when the camera is noisier.
  assert.equal(step(1, 1).noiseSigma, 0);
  assert.ok(step(1, 1.5).noiseSigma > 0);
  let q = initialCameraMatch();
  for (let i = 0; i < 8; i++) q = stepCameraMatch(q, stats(30, 6), stats(30, 2), 0.35, { steady: true, noiseTarget: 0 });
  assert.equal(q.noiseSigma, 0);
  // The old loops honour the target too.
  let e = initialCameraMatch();
  for (let i = 0; i < 12; i++) e = stepCameraMatch(e, stats(30, 2), stats(30, 2), 0.35, { steady: true, sharpnessTarget: 1.5 });
  assert.ok(e.sharpen > 0.1);
});

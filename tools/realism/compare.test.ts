import test from 'node:test';
import assert from 'node:assert/strict';
import { compareClips, compareGrids, verdict } from './compare.ts';

function summary(over: Record<string, unknown>) {
  return {
    targets: {
      skinToneNeck: { driver: 20, output: 26, gap: 6, pass: false },
      skinToneEars: { driver: 10, output: 12, gap: 2, pass: true },
      sharpness: { driver: 0.3, output: 2.4, gap: 7, pass: false },
    },
    seamRatio: 2.5,
    mouthLipErrorPct: 2,
    syntheticTeethFramesWholeClip: 500,
    framesRenderedWholeClip: 1000,
    foreheadToneStepOutput: 14,
    foreheadToneStepDriver: 12,
    foreheadToneStepDelta: 2,
    flicker: { delta: 1 },
    textureSlide: { residualPx: 2 },
    performance: { fps: 60, frameP95Ms: 14 },
    ...over,
  };
}

test('verdict marks improvements, regressions and unchanged values', () => {
  assert.equal(verdict(2, 1, true), 'better');
  assert.equal(verdict(1, 2, true), 'WORSE');
  assert.equal(verdict(60, 59.5, false), '=');
  assert.equal(verdict(30, 40, false), 'better');
  assert.equal(verdict(null, 1, true), '');
});

test('compareClips lines up the lead metrics of two runs per clip', () => {
  const before = { run: 'b', clips: { A: { flags: 'r0', summary: summary({}) }, E: { flags: 'r0', summary: summary({ textureSlide: { residualPx: 2.1 } }) } } };
  const after = {
    run: 'a',
    clips: {
      A: { flags: 'r1', summary: summary({ syntheticTeethFramesWholeClip: 0, textureSlide: { residualPx: 0.3 } }) },
      E: { flags: 'r1', summary: summary({ textureSlide: { residualPx: 0.2 }, flicker: { delta: 3 } }) },
    },
  };
  const rows = compareClips(before as never, after as never);
  assert.deepEqual(rows.map((r) => r.clip), ['A', 'E']);
  const teeth = rows[0].rows.find((r) => r.label.startsWith('synthetic-teeth'))!;
  assert.equal(teeth.before, 0.5);
  assert.equal(teeth.after, 0);
  assert.equal(teeth.verdict, 'better');
  const flicker = rows[1].rows.find((r) => r.label.startsWith('flicker'))!;
  assert.equal(flicker.verdict, 'WORSE');
  assert.equal(compareClips(before as never, after as never, ['E']).length, 1);
});

test('compareGrids compares medians and lists personas that regressed', () => {
  const grid = (slideP1: number, slideP2: number) => ({
    personas: {
      p1: { status: 'ready', clips: { A: summary({ textureSlide: { residualPx: slideP1 } }) } },
      p2: { status: 'ready', clips: { A: summary({ textureSlide: { residualPx: slideP2 } }) } },
    },
    aggregate: { personas: 2, metrics: { textureSlidePx: { label: 'texture slide (px/frame)', median: (slideP1 + slideP2) / 2, worst10pct: Math.max(slideP1, slideP2), worst3: [] } } },
  });
  const before = { run: 'b', grid: grid(2, 2) };
  const after = { run: 'a', grid: grid(0.5, 3) };
  const g = compareGrids(before as never, after as never)!;
  assert.equal(g.metrics[0].verdictMedian, 'better');
  assert.equal(g.metrics[0].verdictWorst10, 'WORSE');
  assert.deepEqual(g.regressions.map((r) => r.persona), ['p2']);
  assert.equal(compareGrids({ run: 'x' } as never, after as never), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { settingLabel, sweepRow } from './sweep.ts';
import type { ClipSummary } from './capture.ts';

function clip(partial: Partial<ClipSummary> & { neck: number; ears: number; side: number; slope: number; sharp: number; margin: number | null }): ClipSummary {
  return {
    targets: {
      skinToneNeck: { driver: 20, output: 20 + partial.neck, gap: partial.neck, pass: Math.abs(partial.neck) <= 3, rule: '' },
      skinToneEars: { driver: 10, output: 10 + partial.ears, gap: partial.ears, pass: Math.abs(partial.ears) <= 3, rule: '' },
      sharpnessInterior: { driver: 0.2, output: 0.2 * (1 + partial.sharp), gap: partial.sharp, pass: Math.abs(partial.sharp) <= 0.15, rule: '' },
    },
    shading: { slope: partial.slope, correlation: 1, sideGap: partial.side, samples: 4 },
    identity: partial.margin === null ? null : { frames: 4, detected: 4, toPersona: 0.5 + partial.margin, toDriver: 0.5, margin: partial.margin, minMargin: partial.margin, driverToPersona: 0.2 },
    personaDelightRange: 2,
  } as unknown as ClipSummary;
}

test('settingLabel reads the radius and de-light state from the run name', () => {
  assert.equal(settingLabel('r3b-sweep-r0.04-d1', { run: 'x' }), '4% / de-light on');
  assert.equal(settingLabel('r3b-sweep-r0.02-d0', { run: 'x' }), '2% / de-light off');
  assert.equal(settingLabel('custom', { run: 'custom', app: { settingsOverrides: { relightRadius: 0.06 } }, clips: { A: { flags: 'personaDelight=1', summary: {} as ClipSummary } } }), '6% / de-light on');
});

test('sweepRow averages the clips and takes the lamp slope from clip D', () => {
  const r = sweepRow('p05', '2% / de-light off', {
    A: clip({ neck: -2, ears: 1, side: 3, slope: 0.3, sharp: 0.2, margin: -0.4 }),
    D: clip({ neck: 4, ears: -1, side: 1, slope: 0.9, sharp: -0.1, margin: null }),
  });
  assert.equal(r.persona, 'p05');
  assert.ok(Math.abs(r.neckGapAbs! - 3) < 1e-9 && Math.abs(r.earsGapAbs! - 1) < 1e-9);
  assert.ok(Math.abs(r.sideGap! - 2) < 1e-9);
  assert.equal(r.lampSlopeD, 0.9);
  assert.ok(Math.abs(r.interiorSharpGapAbs! - 0.15) < 1e-9);
  assert.ok(Math.abs(r.identityMargin! + 0.4) < 1e-9, 'identity averaged over the clips that have it');
  assert.equal(r.delightRange, 2);
});

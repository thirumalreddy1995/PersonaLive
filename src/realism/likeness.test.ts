import test from 'node:test';
import assert from 'node:assert/strict';
import { R6B_FLAG_STRING, R6_FLAG_STRING, defaultRealismFlags, parseRealismFlagString, type RealismFlags } from './flags.ts';
import {
  LIKENESS_SKIN_TONE_MATCH,
  STRONGER_LIKENESS_FLAGS,
  changedFlagKeys,
  effectiveRealismFlags,
  isGuidedEnrollment,
  resolveSkinToneMatch,
  reviewLikeness,
  skinToneMatchKey,
  strongerLikenessDefault,
  strongerLikenessFor,
} from './likeness.ts';
import type { PersonaReference } from '../types/index.ts';

const preset = (s: string): RealismFlags => ({ ...defaultRealismFlags(), ...parseRealismFlagString(s).flags });
const ref: PersonaReference = { id: 'r', label: 'Frontal', imageUrl: 'data:,', pose: { yaw: 0, pitch: 0, roll: 0 }, expression: { mar: 0, smile: 0, browElevation: 0 } };
const upload = { references: undefined };
const guided = { references: [ref, ref, ref, ref, ref, ref, ref] };

test('the switch turns on exactly the R6b identity flags: r6 plus the switch is the r6b preset', () => {
  const r6 = preset(R6_FLAG_STRING);
  const r6b = preset(R6B_FLAG_STRING);
  assert.deepEqual(effectiveRealismFlags(r6, true), r6b);
  assert.deepEqual([...changedFlagKeys(r6, r6b)].sort(), [...STRONGER_LIKENESS_FLAGS].sort());
  // The shipped defaults are r6, so the switch on the defaults is r6b too.
  assert.deepEqual(effectiveRealismFlags(defaultRealismFlags(), true), r6b);
});

test('with the switch off the stored flags are returned unchanged (debug and review overrides still apply)', () => {
  const flags = preset('r6,jawExtension=1');
  assert.equal(effectiveRealismFlags(flags, false), flags);
  assert.equal(effectiveRealismFlags(flags, false).jawExtension, true);
  // Already all on: the same object, so a flag-store change that the switch masks is no change.
  const r6b = preset(R6B_FLAG_STRING);
  assert.equal(effectiveRealismFlags(r6b, true), r6b);
  assert.deepEqual(changedFlagKeys(r6b, effectiveRealismFlags(preset(R6_FLAG_STRING), true)), []);
});

test('the switch only adds flags and never touches the guardrail or base pipeline flags', () => {
  const r0 = preset('r0');
  const on = effectiveRealismFlags(r0, true);
  for (const k of Object.keys(r0) as Array<keyof RealismFlags>) {
    if ((STRONGER_LIKENESS_FLAGS as readonly string[]).includes(k)) assert.equal(on[k], true, k);
    else assert.equal(on[k], r0[k], k);
  }
});

test('default: on for a guided webcam enrollment, off for an uploaded photo; the user choice wins either way', () => {
  assert.equal(isGuidedEnrollment(upload), false);
  assert.equal(isGuidedEnrollment({ references: [] }), false);
  assert.equal(isGuidedEnrollment(guided), true);
  assert.equal(strongerLikenessDefault(upload), false);
  assert.equal(strongerLikenessDefault(guided), true);
  assert.equal(strongerLikenessFor(upload), false);
  assert.equal(strongerLikenessFor(guided), true);
  assert.equal(strongerLikenessFor({ ...guided, strongerLikeness: false }), false);
  assert.equal(strongerLikenessFor({ ...upload, strongerLikeness: true }), true);
  assert.equal(strongerLikenessFor(null), false);
  assert.equal(strongerLikenessFor(undefined), false);
});

test('skin tone match: the likeness value (0.3 to start) with the switch on, the usual slider without it', () => {
  assert.equal(LIKENESS_SKIN_TONE_MATCH, 0.3);
  assert.equal(resolveSkinToneMatch({ skinToneMatch: 1 }, true), 0.3);
  assert.equal(resolveSkinToneMatch({ skinToneMatch: 1 }, false), 1);
  assert.equal(resolveSkinToneMatch({ skinToneMatch: 1, likenessSkinToneMatch: 0.55 }, true), 0.55);
  assert.equal(resolveSkinToneMatch({ skinToneMatch: 0.4, likenessSkinToneMatch: 0.55 }, false), 0.4);
  // Clamped to 0..1; a missing or broken value falls back.
  assert.equal(resolveSkinToneMatch({ skinToneMatch: 1, likenessSkinToneMatch: 3 }, true), 1);
  assert.equal(resolveSkinToneMatch({ skinToneMatch: 1, likenessSkinToneMatch: Number.NaN }, true), 0.3);
  assert.equal(resolveSkinToneMatch({ skinToneMatch: -1 }, false), 0);
  assert.equal(skinToneMatchKey(true), 'likenessSkinToneMatch');
  assert.equal(skinToneMatchKey(false), 'skinToneMatch');
});

test('review runs: --likeness auto leaves the app default, and a run that names its flags renders exactly them', () => {
  assert.equal(reviewLikeness('auto', true), undefined);
  assert.equal(reviewLikeness('on', true), true);
  assert.equal(reviewLikeness('off', false), false);
  assert.equal(reviewLikeness(null, true), false);
  assert.equal(reviewLikeness(null, false), undefined);
});

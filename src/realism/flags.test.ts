import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REALISM_FLAG_DEFS,
  defaultRealismFlags,
  describeRealismFlags,
  parseRealismFlagString,
  parseRealismFlagsFromSearch,
  realismFlags,
} from './flags.ts';

test('flag defaults come from the registry and the R0 stages are all on in the r0 preset', () => {
  const defaults = defaultRealismFlags();
  for (const def of REALISM_FLAG_DEFS) assert.equal(defaults[def.key], def.defaultValue, def.key);
  assert.equal(describeRealismFlags(defaults), 'defaults');
  // The stages that existed before R1 were all on at the end of R0 (the baseline run).
  const r0 = parseRealismFlagString('r0').flags;
  for (const key of ['speechAnatomy', 'perspectiveForeshortening', 'eyelidKinematics', 'foreheadHarmonize', 'hairlineSoften', 'oralCavity', 'catchlights', 'syntheticSuite'] as const) {
    assert.equal(r0[key], true, key);
  }
});

test('parseRealismFlagString accepts key=value, bare keys and negations', () => {
  const { flags, errors } = parseRealismFlagString('oralCavity=0, catchlights=off !hairlineSoften speechAnatomy');
  assert.deepEqual(flags, { oralCavity: false, catchlights: false, hairlineSoften: false, speechAnatomy: true });
  assert.deepEqual(errors, []);
});

test('parseRealismFlagString reports unknown keys and bad values without applying them', () => {
  const { flags, errors } = parseRealismFlagString('bogus=1,oralCavity=maybe,catchlights=0');
  assert.deepEqual(flags, { catchlights: false });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /unknown flag "bogus"/);
  assert.match(errors[1], /oralCavity/);
});

test('parseRealismFlagsFromSearch reads the rf query parameter', () => {
  assert.deepEqual(parseRealismFlagsFromSearch('?realism=1&rf=syntheticSuite%3D0%2Coralcavity%3D0'), {
    syntheticSuite: false,
  });
  assert.deepEqual(parseRealismFlagsFromSearch('?realism=1'), {});
});

test('the flag store notifies listeners with only the keys that changed', () => {
  const seen: string[][] = [];
  const unsubscribe = realismFlags.subscribe((_flags, changed) => seen.push([...changed]));
  try {
    // Flip oralCavity away from its default and leave catchlights at its default.
    const defaults = defaultRealismFlags();
    const flipped = !defaults.oralCavity;
    assert.deepEqual(realismFlags.set({ oralCavity: flipped, catchlights: defaults.catchlights }), ['oralCavity']);
    assert.deepEqual(realismFlags.set({ oralCavity: flipped }), []);
    assert.equal(realismFlags.get().oralCavity, flipped);
    assert.equal(describeRealismFlags(realismFlags.get()), `oralCavity=${flipped ? 'on' : 'off'}`);
    assert.deepEqual(realismFlags.reset(), ['oralCavity']);
    assert.deepEqual(seen, [['oralCavity'], ['oralCavity']]);
  } finally {
    unsubscribe();
    realismFlags.reset();
  }
});

test('the r0 preset reproduces the R0 behaviour whatever the defaults are', () => {
  const { flags, errors } = parseRealismFlagString('r0');
  assert.deepEqual(errors, []);
  assert.equal(flags.oralCavity, true);
  assert.equal(flags.syntheticSuite, true);
  assert.equal(flags.shaderSebum, true);
  assert.equal(flags.realMouth, false);
  assert.equal(flags.eyePassThrough, false);
  assert.equal(Object.keys(flags).length, REALISM_FLAG_DEFS.length, 'preset covers every flag');
  const r1 = parseRealismFlagString('r1').flags;
  assert.equal(r1.realMouth, true);
  assert.equal(r1.oralCavity, false);
  assert.equal(r1.closedLipMask, false);
  assert.equal(Object.keys(r1).length, REALISM_FLAG_DEFS.length, 'r1 preset covers every flag');
  // Later tokens override the preset.
  assert.equal(parseRealismFlagString('r0,oralCavity=0').flags.oralCavity, false);
});

test('the r4 preset is the R4 defaults with the R4b forehead extension off', () => {
  const { flags, errors } = parseRealismFlagString('r4');
  assert.deepEqual(errors, []);
  assert.equal(Object.keys(flags).length, REALISM_FLAG_DEFS.length, 'r4 preset covers every flag');
  assert.equal(flags.segmentation, true);
  assert.equal(flags.foreshortenFade, true);
  assert.equal(flags.personaInpaint, true);
  assert.equal(flags.autoRadius, true);
  assert.equal(flags.twoBandBlend, false);
  assert.equal(flags.cameraMatchSameMask, false);
  assert.equal(flags.foreheadExtension, false);
  // The extension is opt-in until a measured comparison: off by default and in every earlier preset.
  assert.equal(defaultRealismFlags().foreheadExtension, false);
  for (const preset of ['r0', 'r1', 'r2', 'r3', 'r3c']) assert.equal(parseRealismFlagString(preset).flags.foreheadExtension, false, preset);
  assert.equal(parseRealismFlagString('r4,foreheadExtension=1').flags.foreheadExtension, true);
  // R5 flags are off in every preset up to r4.
  for (const key of ['keyframeCrossfade', 'guidedEnrollment', 'videoFramePacing', 'singleGlComposite', 'matrixHeadPose'] as const) {
    for (const preset of ['r0', 'r1', 'r2', 'r3', 'r3c', 'r4']) assert.equal(parseRealismFlagString(preset).flags[key], false, `${preset} ${key}`);
    assert.equal(parseRealismFlagString(`r4,${key}=1`).flags[key], true);
  }
  // r4 differs from the R6 defaults in exactly the four flags R6 turned on.
  const defaults = defaultRealismFlags();
  const differing = REALISM_FLAG_DEFS.map((d) => d.key).filter((k) => flags[k] !== defaults[k]);
  assert.deepEqual(differing.sort(), ['guidedEnrollment', 'keyframeCrossfade', 'matrixHeadPose', 'videoFramePacing']);
});

test('the r6 preset is the Balanced defaults chosen at the end of R6', () => {
  const { flags, errors } = parseRealismFlagString('r6');
  assert.deepEqual(errors, []);
  assert.equal(Object.keys(flags).length, REALISM_FLAG_DEFS.length, 'r6 preset covers every flag');
  assert.deepEqual(flags, defaultRealismFlags());
  // Balanced = r4 + video-frame pacing, the MediaPipe head pose and the keyframe cross-fade; the
  // guided enrollment (the seven-shot capture in the library) is on next to the photo upload.
  for (const key of ['keyframeCrossfade', 'videoFramePacing', 'matrixHeadPose', 'guidedEnrollment'] as const) {
    assert.equal(defaultRealismFlags()[key], true, key);
    assert.equal(flags[key], true, key);
  }
  // Still opt-in: the single GL composite, the median camera-match loop (dropped in R6 Part 2)
  // and the forehead extension are off by default and in every preset.
  for (const key of ['singleGlComposite', 'cameraMatchMedian', 'foreheadExtension'] as const) {
    assert.equal(defaultRealismFlags()[key], false, key);
    for (const preset of ['r0', 'r1', 'r2', 'r3', 'r3c', 'r4', 'r6']) assert.equal(parseRealismFlagString(preset).flags[key], false, `${preset} ${key}`);
    assert.equal(parseRealismFlagString(`r6,${key}=1`).flags[key], true);
  }
  // Relighting stays on: the R0 5-zone gain it replaced was removed in R6.
  assert.equal(defaultRealismFlags().relight, true);
});

test('the R6b identity flags are off by default and in every shipped preset, and on in r6b', () => {
  const keys = ['relightIllumination', 'skinTint', 'personaProportions', 'jawExtension', 'lidPassThrough', 'seamFade', 'photoLighting'] as const;
  for (const key of keys) {
    assert.equal(defaultRealismFlags()[key], false, key);
    for (const preset of ['r0', 'r1', 'r2', 'r3', 'r3c', 'r4', 'r6']) assert.equal(parseRealismFlagString(preset).flags[key], false, `${preset} ${key}`);
  }
  const { flags, errors } = parseRealismFlagString('r6b');
  assert.deepEqual(errors, []);
  assert.equal(Object.keys(flags).length, REALISM_FLAG_DEFS.length, 'r6b preset covers every flag');
  for (const key of keys) assert.equal(flags[key], true, `r6b ${key}`);
  // Otherwise r6b is r6.
  const r6 = parseRealismFlagString('r6').flags;
  for (const def of REALISM_FLAG_DEFS) if (!(keys as readonly string[]).includes(def.key)) assert.equal(flags[def.key], r6[def.key], def.key);
});

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

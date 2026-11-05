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

test('flag defaults equal the pre-realism behaviour (every stage on)', () => {
  const defaults = defaultRealismFlags();
  for (const def of REALISM_FLAG_DEFS) assert.equal(defaults[def.key], true, def.key);
  assert.equal(describeRealismFlags(defaults), 'defaults');
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
    assert.deepEqual(realismFlags.set({ oralCavity: false, catchlights: true }), ['oralCavity']);
    assert.deepEqual(realismFlags.set({ oralCavity: false }), []);
    assert.equal(realismFlags.get().oralCavity, false);
    assert.equal(describeRealismFlags(realismFlags.get()), 'oralCavity=off');
    assert.deepEqual(realismFlags.reset(), ['oralCavity']);
    assert.deepEqual(seen, [['oralCavity'], ['oralCavity']]);
  } finally {
    unsubscribe();
    realismFlags.reset();
  }
});

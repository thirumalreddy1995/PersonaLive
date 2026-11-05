import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettingsFromSearch, parseSettingsString } from './settings.ts';

test('parseSettingsString coerces numbers, booleans and enums and reports bad input', () => {
  const { settings, errors } = parseSettingsString('temporalSmoothing=20, keepRealMouth=off;outputResolution=720p eyePassThroughRadius=1.5');
  assert.deepEqual(errors, []);
  assert.deepEqual(settings, { temporalSmoothing: 20, keepRealMouth: false, outputResolution: '720p', eyePassThroughRadius: 1.5 });
  const bad = parseSettingsString('temporalSmoothing=soft,viewMode=round,nope=1,blendStrength');
  assert.deepEqual(bad.settings, {});
  assert.equal(bad.errors.length, 4);
});

test('parseSettingsFromSearch reads the rs parameter', () => {
  assert.deepEqual(parseSettingsFromSearch('?realism=1&rs=blendStrength%3D100%2CeyeGazeSync%3D0'), { blendStrength: 100, eyeGazeSync: false });
  assert.deepEqual(parseSettingsFromSearch('?realism=1'), {});
});

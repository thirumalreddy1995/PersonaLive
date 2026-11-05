/**
 * Transformation-settings overrides for the realism tools (`?rs=temporalSmoothing=20,...` and the
 * capture tool's `--settings`). Pure, like flags.ts, so the capture tool and the tests can import it.
 */
import type { TransformationSettings } from '../types/index.ts';

type SettingKey = keyof TransformationSettings;

const NUMERIC_KEYS: ReadonlyArray<SettingKey> = [
  'blendStrength',
  'temporalSmoothing',
  'expressionGain',
  'lipSyncSensitivity',
  'manualSmileBias',
  'eyePassThroughRadius',
];
const BOOLEAN_KEYS: ReadonlyArray<SettingKey> = [
  'audioReactiveLipSync',
  'eyeGazeSync',
  'keepRealMouth',
  'lightingAdaptation',
  'preserveFacialHair',
  'showLandmarkOverlay',
  'showBoundingBoxes',
];
const ENUM_KEYS: Partial<Record<SettingKey, ReadonlyArray<string>>> = {
  outputResolution: ['1080p', '720p', '540p'],
  viewMode: ['split', 'side-by-side', 'transformed-only', 'pip'],
};
const NUMERIC_ENUM_KEYS: Partial<Record<SettingKey, ReadonlyArray<number>>> = {
  personaTextureSize: [512, 1024, 2048],
};

const TRUE_WORDS = new Set(['1', 'true', 'on', 'yes']);
const FALSE_WORDS = new Set(['0', 'false', 'off', 'no']);

/** Parses `key=value` pairs (comma, semicolon or whitespace separated) into a settings patch. */
export function parseSettingsString(input: string): { settings: Partial<TransformationSettings>; errors: string[] } {
  const settings: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq < 0) {
      errors.push(`setting "${token}" needs a value`);
      continue;
    }
    const key = token.slice(0, eq).trim() as SettingKey;
    const value = token.slice(eq + 1).trim();
    if (NUMERIC_KEYS.includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) errors.push(`setting "${key}" needs a number`);
      else settings[key] = n;
    } else if (BOOLEAN_KEYS.includes(key)) {
      const w = value.toLowerCase();
      if (TRUE_WORDS.has(w)) settings[key] = true;
      else if (FALSE_WORDS.has(w)) settings[key] = false;
      else errors.push(`setting "${key}" needs on/off`);
    } else if (ENUM_KEYS[key]) {
      if (ENUM_KEYS[key]!.includes(value)) settings[key] = value;
      else errors.push(`setting "${key}" must be one of ${ENUM_KEYS[key]!.join(', ')}`);
    } else if (NUMERIC_ENUM_KEYS[key]) {
      const n = Number(value);
      if (NUMERIC_ENUM_KEYS[key]!.includes(n)) settings[key] = n;
      else errors.push(`setting "${key}" must be one of ${NUMERIC_ENUM_KEYS[key]!.join(', ')}`);
    } else {
      errors.push(`unknown setting "${key}"`);
    }
  }
  return { settings: settings as Partial<TransformationSettings>, errors };
}

/** Overrides from the page URL (`rs` parameter), ignoring errors. */
export function parseSettingsFromSearch(search: string): Partial<TransformationSettings> {
  const rs = new URLSearchParams(search).get('rs');
  return rs ? parseSettingsString(rs).settings : {};
}

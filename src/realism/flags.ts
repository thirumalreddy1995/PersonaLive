/**
 * Realism stage flags.
 *
 * Every visual stage of the persona pipeline that the realism pass touches sits behind one of
 * these flags so before/after can be compared live (debug panel) and headlessly (capture tool).
 * Defaults are the behaviour of the latest finished phase (R1: no painted mouth or glints, warp on
 * the tracked landmarks, one real keyframe, no shader beautification, real mouth and eye
 * pass-through on). `--flags r0` restores the pre-R1 behaviour; a default changes only after a
 * phase report shows the comparison.
 *
 * This module is pure (no DOM, no Vite env) so the capture tool and the unit tests can import it.
 */
export interface RealismFlagDef {
  key: RealismFlagKey;
  label: string;
  description: string;
  defaultValue: boolean;
  /** Where in the pipeline the flag acts. */
  group: 'mesh' | 'overlay' | 'post' | 'bank' | 'shader' | 'mouth-eyes';
  /** Set when toggling needs the persona to be re-prepared rather than taking effect next frame. */
  appliesOn?: 'persona-reload';
}

export type RealismFlagKey =
  | 'speechAnatomy'
  | 'perspectiveForeshortening'
  | 'eyelidKinematics'
  | 'foreheadHarmonize'
  | 'hairlineSoften'
  | 'oralCavity'
  | 'catchlights'
  | 'syntheticSuite'
  | 'shaderUnsharp'
  | 'shaderSubsurface'
  | 'shaderSebum'
  | 'realMouth'
  | 'eyePassThrough'
  | 'closedLipMask';

export const REALISM_FLAG_DEFS: ReadonlyArray<RealismFlagDef> = [
  {
    key: 'speechAnatomy',
    label: 'Speech anatomy offsets',
    description: 'applySpeechAnatomy moves upper-lip vertices away from the tracked lips while talking.',
    defaultValue: false,
    group: 'mesh',
  },
  {
    key: 'perspectiveForeshortening',
    label: 'Perspective foreshortening',
    description: 'applyPerspectiveForeshortening shifts vertices by yaw/pitch instead of using the tracked points.',
    defaultValue: false,
    group: 'mesh',
  },
  {
    key: 'eyelidKinematics',
    label: 'Eyelid kinematics',
    description: 'applyEyelidKinematics folds persona eyelid vertices down on blinks.',
    defaultValue: false,
    group: 'mesh',
  },
  {
    key: 'foreheadHarmonize',
    label: 'Forehead boundary erase',
    description: 'CranialBoundaryBlender.harmonizeForeheadBoundary erases persona alpha across the upper forehead.',
    defaultValue: true,
    group: 'overlay',
  },
  {
    key: 'hairlineSoften',
    label: 'Hairline blur pass',
    description: 'CranialBoundaryBlender.softenHairlineEdges blurs the overlay alpha along the hairline (blur(4px) per frame).',
    defaultValue: true,
    group: 'overlay',
  },
  {
    key: 'oralCavity',
    label: 'Procedural oral cavity',
    description: 'OralCavityRenderer paints synthetic teeth, tongue and mouth shadows over the real mouth.',
    defaultValue: false,
    group: 'post',
  },
  {
    key: 'catchlights',
    label: 'Painted eye catchlights',
    description: 'A fixed white glint is drawn on each iris regardless of the real lighting.',
    defaultValue: false,
    group: 'post',
  },
  {
    key: 'syntheticSuite',
    label: 'Synthesised keyframe suite',
    description:
      'MultiReferenceBank.synthesizeSuiteFromMaster builds yaw/pitch/viseme/smile keyframes by shifting the one photo.',
    defaultValue: false,
    group: 'bank',
    appliesOn: 'persona-reload',
  },
  {
    key: 'shaderUnsharp',
    label: 'Shader unsharp mask',
    description: 'Fixed-offset high-pass sharpening of the persona texture in the warp shader (R1 §5).',
    defaultValue: false,
    group: 'shader',
  },
  {
    key: 'shaderSubsurface',
    label: 'Shader subsurface tint',
    description: 'Warm "subdermal" tint mixed into mid-tones in the warp shader (R1 §5).',
    defaultValue: false,
    group: 'shader',
  },
  {
    key: 'shaderSebum',
    label: 'Shader sebum sheen',
    description: 'Synthetic specular sheen added where the lighting gain is high (R1 §5).',
    defaultValue: false,
    group: 'shader',
  },
  {
    key: 'realMouth',
    label: 'Keep my real mouth (lip fade)',
    description: 'Fades the persona lip band as the mouth opens so the wearer\'s real lips show instead of stretched persona lips (R1 §2). Also needs the user setting.',
    defaultValue: true,
    group: 'mouth-eyes',
  },
  {
    key: 'eyePassThrough',
    label: 'Eye pass-through ring',
    description: 'Fades the persona in a ring around the eye holes so the wearer\'s lids and lashes show (R1 §6). Radius is a user setting.',
    defaultValue: true,
    group: 'mouth-eyes',
  },
  {
    key: 'closedLipMask',
    label: 'Closed-lip mask',
    description: 'With the mouth closed, removes persona lip colour outside the wearer\'s outer lip contour (feathered to the next ring) so fuller persona lips draw no painted outline (R2).',
    defaultValue: false,
    group: 'mouth-eyes',
  },
];

/**
 * The behaviour shipped at the end of R0, as a flag string: `--flags r0` reproduces it whatever
 * the current defaults are. Update this only when a phase report changes defaults.
 */
export const R0_FLAG_STRING =
  'speechAnatomy=1,perspectiveForeshortening=1,eyelidKinematics=1,foreheadHarmonize=1,hairlineSoften=1,oralCavity=1,catchlights=1,syntheticSuite=1,shaderUnsharp=1,shaderSubsurface=1,shaderSebum=1,realMouth=0,eyePassThrough=0,closedLipMask=0';

/** The R1 defaults, as a flag string: `--flags r1` reproduces the end-of-R1 behaviour. */
export const R1_FLAG_STRING =
  'speechAnatomy=0,perspectiveForeshortening=0,eyelidKinematics=0,foreheadHarmonize=1,hairlineSoften=1,oralCavity=0,catchlights=0,syntheticSuite=0,shaderUnsharp=0,shaderSubsurface=0,shaderSebum=0,realMouth=1,eyePassThrough=1,closedLipMask=0';

/** Named flag presets accepted by parseRealismFlagString (case-insensitive). */
export const REALISM_FLAG_PRESETS: Record<string, string> = { r0: R0_FLAG_STRING, r1: R1_FLAG_STRING };

export type RealismFlags = Record<RealismFlagKey, boolean>;

export function defaultRealismFlags(): RealismFlags {
  const flags = {} as RealismFlags;
  for (const def of REALISM_FLAG_DEFS) flags[def.key] = def.defaultValue;
  return flags;
}

export function isRealismFlagKey(key: string): key is RealismFlagKey {
  return REALISM_FLAG_DEFS.some((d) => d.key === key);
}

const TRUE_WORDS = new Set(['1', 'true', 'on', 'yes']);
const FALSE_WORDS = new Set(['0', 'false', 'off', 'no']);

/**
 * Parses `key=value` pairs separated by commas, semicolons or whitespace, e.g.
 * `oralCavity=0,catchlights=off syntheticSuite=false`. A bare key means `true`; a `!key` or `-key`
 * prefix means `false`. Unknown keys and unparseable values are reported, not applied.
 */
export function parseRealismFlagString(input: string): { flags: Partial<RealismFlags>; errors: string[] } {
  const flags: Partial<RealismFlags> = {};
  const errors: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const preset = REALISM_FLAG_PRESETS[token.toLowerCase()];
    if (preset !== undefined) {
      const expanded = parseRealismFlagString(preset);
      Object.assign(flags, expanded.flags);
      errors.push(...expanded.errors);
      continue;
    }
    let key = token;
    let value: boolean | null = true;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      key = token.slice(0, eq).trim();
      const word = token.slice(eq + 1).trim().toLowerCase();
      value = TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : null;
    } else if (key.startsWith('!') || key.startsWith('-')) {
      key = key.slice(1);
      value = false;
    }
    if (!isRealismFlagKey(key)) {
      errors.push(`unknown flag "${key}"`);
      continue;
    }
    if (value === null) {
      errors.push(`flag "${key}" needs on/off, 1/0 or true/false`);
      continue;
    }
    flags[key] = value;
  }
  return { flags, errors };
}

/** Reads flag overrides from a URL query string (`?rf=oralCavity=0,catchlights=0`). */
export function parseRealismFlagsFromSearch(search: string): Partial<RealismFlags> {
  const params = new URLSearchParams(search);
  const rf = params.get('rf');
  return rf ? parseRealismFlagString(rf).flags : {};
}

/** Serialises the flags that differ from their defaults, for run labels and report.json. */
export function describeRealismFlags(flags: RealismFlags): string {
  const defaults = defaultRealismFlags();
  const parts: string[] = [];
  for (const def of REALISM_FLAG_DEFS) {
    if (flags[def.key] !== defaults[def.key]) parts.push(`${def.key}=${flags[def.key] ? 'on' : 'off'}`);
  }
  return parts.length ? parts.join(',') : 'defaults';
}

type Listener = (flags: RealismFlags, changed: RealismFlagKey[]) => void;

/** Process-wide flag store. The engine reads it per frame; the panel and the debug hook write it. */
class RealismFlagStore {
  private flags = defaultRealismFlags();
  private listeners = new Set<Listener>();

  get(): RealismFlags {
    return this.flags;
  }

  set(patch: Partial<RealismFlags>): RealismFlagKey[] {
    const changed: RealismFlagKey[] = [];
    const next = { ...this.flags };
    for (const def of REALISM_FLAG_DEFS) {
      const v = patch[def.key];
      if (typeof v === 'boolean' && v !== next[def.key]) {
        next[def.key] = v;
        changed.push(def.key);
      }
    }
    if (changed.length === 0) return changed;
    this.flags = next;
    for (const l of this.listeners) l(next, changed);
    return changed;
  }

  reset(): RealismFlagKey[] {
    return this.set(defaultRealismFlags());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const realismFlags = new RealismFlagStore();

/**
 * Realism stage flags.
 *
 * Every visual stage of the persona pipeline that the realism pass touches sits behind one of
 * these flags so before/after can be compared live (debug panel) and headlessly (capture tool).
 * Defaults equal the behaviour shipped before the realism pass; a default changes only after a
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
  group: 'mesh' | 'overlay' | 'post' | 'bank';
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
  | 'syntheticSuite';

export const REALISM_FLAG_DEFS: ReadonlyArray<RealismFlagDef> = [
  {
    key: 'speechAnatomy',
    label: 'Speech anatomy offsets',
    description: 'applySpeechAnatomy moves upper-lip vertices away from the tracked lips while talking.',
    defaultValue: true,
    group: 'mesh',
  },
  {
    key: 'perspectiveForeshortening',
    label: 'Perspective foreshortening',
    description: 'applyPerspectiveForeshortening shifts vertices by yaw/pitch instead of using the tracked points.',
    defaultValue: true,
    group: 'mesh',
  },
  {
    key: 'eyelidKinematics',
    label: 'Eyelid kinematics',
    description: 'applyEyelidKinematics folds persona eyelid vertices down on blinks.',
    defaultValue: true,
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
    defaultValue: true,
    group: 'post',
  },
  {
    key: 'catchlights',
    label: 'Painted eye catchlights',
    description: 'A fixed white glint is drawn on each iris regardless of the real lighting.',
    defaultValue: true,
    group: 'post',
  },
  {
    key: 'syntheticSuite',
    label: 'Synthesised keyframe suite',
    description:
      'MultiReferenceBank.synthesizeSuiteFromMaster builds yaw/pitch/viseme/smile keyframes by shifting the one photo.',
    defaultValue: true,
    group: 'bank',
    appliesOn: 'persona-reload',
  },
];

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

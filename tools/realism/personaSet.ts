/**
 * The persona test set: synthetic faces in gitignored `realism-review/personas/` described by a
 * `manifest.json` written by `personas-select.ts`. Pure helpers (manifest parsing, selection
 * coverage, prompt attribute parsing) live here so they can be unit-tested.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_DIR } from './session.ts';

export type PersonaCategory = 'men' | 'women';

export interface PersonaAttributes {
  gender: 'man' | 'woman' | 'unknown';
  ethnicity: string;
  /** Decade label such as "20s", "40s", "60s", or "unknown". */
  age: string;
  skinTone: 'light' | 'medium' | 'dark' | 'unknown';
  facialHair: 'beard' | 'moustache' | 'clean-shaven' | 'unknown';
  glasses: boolean;
  hairline: 'receding' | 'fringe' | 'normal' | 'unknown';
}

export interface PersonaManifestEntry {
  id: string;
  file: string;
  category: PersonaCategory;
  /** Source dataset and image id, e.g. { dataset: "SFHQ-T2I", imageId: "...", model: "Flux1.dev" }. */
  source: Record<string, string>;
  prompt: string;
  attributes: PersonaAttributes;
  /** Id of the clean persona this is a degraded (downscaled, recompressed) copy of. */
  degradedOf: string | null;
}

export interface PersonaManifest {
  source: string;
  licence: string;
  createdAt: string;
  personas: PersonaManifestEntry[];
}

export interface PersonaEntry {
  id: string;
  file: string;
  category: PersonaCategory;
  attributes: Record<string, unknown>;
  degradedOf: string | null;
}

export const PERSONAS_DIR = path.join(REVIEW_DIR, 'personas');
export const MANIFEST_FILE = path.join(PERSONAS_DIR, 'manifest.json');
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

export function readManifest(file = MANIFEST_FILE): PersonaManifest {
  if (!fs.existsSync(file)) {
    throw new Error(`No persona manifest at ${file}. Run \`npm run realism:personas -- --source <SFHQ-T2I download>\` first.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PersonaManifest;
}

/**
 * Resolves `--personas`: "all" (every manifest entry), a comma list of manifest ids, or a folder
 * of images without a manifest (ids from file names, the given category).
 */
export function loadPersonaSet(spec: string, category: PersonaCategory): PersonaEntry[] {
  if (spec !== 'all' && fs.existsSync(spec) && fs.statSync(spec).isDirectory()) {
    const manifest = path.join(spec, 'manifest.json');
    if (fs.existsSync(manifest)) return fromManifest(readManifest(manifest), spec, null);
    return fs
      .readdirSync(spec)
      .filter((f) => IMAGE_RE.test(f))
      .sort()
      .map((f) => ({ id: path.basename(f, path.extname(f)), file: path.join(spec, f), category, attributes: {}, degradedOf: null }));
  }
  const ids = spec === 'all' ? null : spec.split(',').map((s) => s.trim()).filter(Boolean);
  return fromManifest(readManifest(), PERSONAS_DIR, ids);
}

function fromManifest(manifest: PersonaManifest, dir: string, ids: string[] | null): PersonaEntry[] {
  const entries = manifest.personas.filter((p) => !ids || ids.includes(p.id));
  if (ids) {
    const missing = ids.filter((id) => !entries.some((p) => p.id === id));
    if (missing.length) throw new Error(`Personas not in the manifest: ${missing.join(', ')}`);
  }
  return entries.map((p) => ({
    id: p.id,
    file: path.isAbsolute(p.file) ? p.file : path.join(dir, p.file),
    category: p.category,
    attributes: { ...p.attributes, source: p.source },
    degradedOf: p.degradedOf,
  }));
}

// --- Prompt attribute parsing (SFHQ-T2I prompts are free text) ----------------------------------------

const ETHNICITIES: Array<[RegExp, string]> = [
  [/\b(south asian|indian|pakistani|bangladeshi|sri lankan|nepali|desi)\b/i, 'South Asian'],
  [/\b(east asian|chinese|japanese|korean|vietnamese|taiwanese)\b/i, 'East Asian'],
  [/\b(southeast asian|thai|filipino|filipina|indonesian|malaysian)\b/i, 'Southeast Asian'],
  [/\b(middle eastern|arab|persian|iranian|turkish|lebanese|egyptian)\b/i, 'Middle Eastern'],
  [/\b(black|african|african[- ]american|nigerian|ethiopian|ghanaian|kenyan|afro)\b/i, 'Black'],
  [/\b(hispanic|latino|latina|latinx|mexican|brazilian|colombian)\b/i, 'Hispanic / Latino'],
  [/\b(native american|indigenous|first nations)\b/i, 'Indigenous'],
  [/\b(white|caucasian|european|scandinavian|irish|british|german|italian|french|russian|polish)\b/i, 'White'],
  [/\b(mixed[- ]race|biracial|multiracial)\b/i, 'Mixed'],
];

export function parsePromptAttributes(prompt: string): PersonaAttributes {
  const p = prompt.toLowerCase();
  const gender: PersonaAttributes['gender'] = /\b(woman|female|lady|girl|she|her|grandmother|mother)\b/.test(p)
    ? 'woman'
    : /\b(man|male|gentleman|guy|boy|he|his|grandfather|father)\b/.test(p)
      ? 'man'
      : 'unknown';
  let ethnicity = 'unknown';
  for (const [re, label] of ETHNICITIES) {
    if (re.test(p)) {
      ethnicity = label;
      break;
    }
  }
  const age = parseAge(p);
  const skinTone: PersonaAttributes['skinTone'] = /\b(dark|deep|ebony|rich brown|very dark)[- ]?(skin|complexion)/.test(p) || ethnicity === 'Black'
    ? 'dark'
    : /\b(light|fair|pale|porcelain|very light)[- ]?(skin|complexion)/.test(p) || ['White', 'East Asian'].includes(ethnicity)
      ? 'light'
      : /\b(medium|olive|tan|tanned|brown|wheatish|golden)[- ]?(skin|complexion)/.test(p) || ['South Asian', 'Middle Eastern', 'Hispanic / Latino', 'Southeast Asian', 'Mixed'].includes(ethnicity)
        ? 'medium'
        : 'unknown';
  const facialHair: PersonaAttributes['facialHair'] = /\b(clean[- ]shaven|no beard|shaved face|smooth face)\b/.test(p)
    ? 'clean-shaven'
    : /\b(beard|bearded|goatee|stubble)\b/.test(p)
      ? 'beard'
      : /\b(mustache|moustache)\b/.test(p)
        ? 'moustache'
        : gender === 'woman'
          ? 'clean-shaven'
          : 'unknown';
  const glasses = /\b(glasses|spectacles|eyeglasses)\b/.test(p) && !/\b(no glasses|without glasses|sunglasses)\b/.test(p);
  const hairline: PersonaAttributes['hairline'] = /\b(receding hairline|receding hair|balding|bald|widow'?s peak|high forehead)\b/.test(p)
    ? 'receding'
    : /\b(fringe|bangs|hair (falling |hanging )?over (the |his |her )?forehead)\b/.test(p)
      ? 'fringe'
      : /\b(hair|hairstyle|haircut)\b/.test(p)
        ? 'normal'
        : 'unknown';
  return { gender, ethnicity, age, skinTone, facialHair, glasses, hairline };
}

function parseAge(p: string): string {
  const decade = p.match(/\b(?:in (?:his|her|their) |aged? )?(20|30|40|50|60|70)s\b/);
  if (decade) return `${decade[1]}s`;
  const years = p.match(/\b(\d{2})[- ]year[s]?[- ]old\b/);
  if (years) return `${Math.floor(Number(years[1]) / 10) * 10}s`;
  if (/\b(elderly|senior|old man|old woman|grandfather|grandmother|retired)\b/.test(p)) return '60s';
  if (/\b(middle[- ]aged)\b/.test(p)) return '40s';
  if (/\b(young adult|young man|young woman|college|student)\b/.test(p)) return '20s';
  if (/\b(teen|teenager|child|kid|boy|girl|baby|toddler)\b/.test(p)) return 'minor';
  return 'unknown';
}

// --- Coverage ---------------------------------------------------------------------------------------

export interface CoverageReport {
  total: number;
  southAsian: number;
  skinTones: Record<string, number>;
  genders: Record<string, number>;
  ages: Record<string, number>;
  facialHair: Record<string, number>;
  glasses: number;
  hairlines: Record<string, number>;
  missing: string[];
}

function tally<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Checks the set against the coverage the plan asks for and lists what is still missing. */
export function coverage(entries: Array<{ attributes: PersonaAttributes; degradedOf: string | null }>): CoverageReport {
  const clean = entries.filter((e) => !e.degradedOf).map((e) => e.attributes);
  const southAsian = clean.filter((a) => a.ethnicity === 'South Asian').length;
  const skinTones = tally(clean.map((a) => a.skinTone));
  const genders = tally(clean.map((a) => a.gender));
  const ages = tally(clean.map((a) => a.age));
  const facialHair = tally(clean.map((a) => a.facialHair));
  const glasses = clean.filter((a) => a.glasses).length;
  const hairlines = tally(clean.map((a) => a.hairline));
  const missing: string[] = [];
  if (southAsian < 8) missing.push(`South Asian faces: ${southAsian}/8`);
  for (const tone of ['light', 'medium', 'dark']) if (!skinTones[tone]) missing.push(`${tone} skin tone`);
  if (!genders.man) missing.push('men');
  if (!genders.woman) missing.push('women');
  for (const decade of ['20s', '30s', '40s', '50s', '60s']) if (!ages[decade]) missing.push(`age ${decade}`);
  for (const fh of ['beard', 'moustache', 'clean-shaven']) if (!facialHair[fh]) missing.push(fh);
  if (!glasses) missing.push('glasses');
  if (!hairlines.receding) missing.push('receding hairline');
  if (!hairlines.fringe) missing.push('fringe over the forehead');
  return { total: clean.length, southAsian, skinTones, genders, ages, facialHair, glasses, hairlines, missing };
}

/** The coverage the plan asks for, as (predicate, how many). */
export const REQUIREMENTS: Array<{ label: string; count: number; test: (a: PersonaAttributes) => boolean }> = [
  { label: 'South Asian', count: 8, test: (a) => a.ethnicity === 'South Asian' },
  { label: 'dark skin', count: 3, test: (a) => a.skinTone === 'dark' },
  { label: 'medium skin', count: 3, test: (a) => a.skinTone === 'medium' },
  { label: 'light skin', count: 3, test: (a) => a.skinTone === 'light' },
  { label: 'women', count: 8, test: (a) => a.gender === 'woman' },
  { label: 'men', count: 8, test: (a) => a.gender === 'man' },
  ...['20s', '30s', '40s', '50s', '60s'].map((decade) => ({ label: `age ${decade}`, count: 2, test: (a: PersonaAttributes) => a.age === decade })),
  { label: 'beard', count: 3, test: (a) => a.facialHair === 'beard' },
  { label: 'moustache', count: 2, test: (a) => a.facialHair === 'moustache' },
  { label: 'clean-shaven', count: 3, test: (a) => a.facialHair === 'clean-shaven' },
  { label: 'glasses', count: 3, test: (a) => a.glasses },
  { label: 'receding hairline', count: 2, test: (a) => a.hairline === 'receding' },
  { label: 'fringe', count: 2, test: (a) => a.hairline === 'fringe' },
];

/**
 * Greedy selection by coverage gain: at each step take the candidate that fills the most still-open
 * requirement slots, until every requirement is met; then top up to `target` in candidate order.
 * The result exceeds `target` only when the requirements cannot be met within it.
 */
export function selectPersonas<T extends { attributes: PersonaAttributes }>(candidates: T[], target = 24): T[] {
  const chosen: T[] = [];
  const taken = new Set<T>();
  const need = REQUIREMENTS.map((r) => r.count);
  const eligible = candidates.filter((c) => c.attributes.age !== 'minor');
  for (;;) {
    let best: T | null = null;
    let bestGain = 0;
    for (const c of eligible) {
      if (taken.has(c)) continue;
      let gain = 0;
      REQUIREMENTS.forEach((r, i) => {
        if (need[i] > 0 && r.test(c.attributes)) gain++;
      });
      if (gain > bestGain) {
        best = c;
        bestGain = gain;
      }
    }
    if (!best) break;
    chosen.push(best);
    taken.add(best);
    REQUIREMENTS.forEach((r, i) => {
      if (need[i] > 0 && r.test(best!.attributes)) need[i]--;
    });
  }
  for (const c of eligible) {
    if (chosen.length >= target) break;
    if (!taken.has(c)) {
      chosen.push(c);
      taken.add(c);
    }
  }
  return chosen;
}

// --- CSV --------------------------------------------------------------------------------------------

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

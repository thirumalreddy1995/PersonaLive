/**
 * Identity-vs-lighting sweep sheets and table (R3b item 2).
 *
 *   npx tsx tools/realism/sweep.ts [--runs a,b,c] [--out r3b-sweep] [--clips A,B,D,E]
 *
 * Reads the sweep runs' report.json files (default: the eight r3b-sweep-r<radius>-d<0|1> runs) and
 * the identity crops they wrote, then writes one side-by-side sheet per persona (rows = settings,
 * columns = the persona photo and two frames per clip) plus a markdown table of identity margin,
 * neck/ears gap, side shading gap, clip D lamp slope and interior sharpness per persona × setting,
 * with the median over the personas per setting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RgbaImage, medianOf } from './metrics.ts';
import { SheetRow, contactSheet, decodeImageFile, scaleImage, writePng } from './png.ts';
import { ROOT } from './session.ts';
import type { ClipSummary } from './capture.ts';

const OUT = path.join(ROOT, 'realism-review', 'out');
const DEFAULT_RUNS = ['0.02', '0.04', '0.06', '0.08'].flatMap((r) => [`r3b-sweep-r${r}-d0`, `r3b-sweep-r${r}-d1`]);
const TILE_H = 150;

interface Args { runs: string[]; out: string; clips: string[] }

function parseArgs(argv: string[]): Args {
  const a: Args = { runs: DEFAULT_RUNS, out: 'r3b-sweep', clips: ['A', 'B', 'D', 'E'] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--runs') a.runs = argv[++i].split(',');
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--clips') a.clips = argv[++i].split(',');
    else throw new Error(`unknown argument ${v}`);
  }
  return a;
}

interface Report {
  run: string;
  app?: { settingsOverrides?: Record<string, number> };
  clips?: Record<string, { flags: string; summary: ClipSummary }>;
  grid?: { personas: Record<string, { file: string; clips: Record<string, ClipSummary> }> };
}

/** "2% / de-light on" from the run name or its report. */
export function settingLabel(run: string, report: Report): string {
  const m = /r(\d+(?:\.\d+)?)-d([01])/.exec(run);
  const radius = m ? Number(m[1]) : report.app?.settingsOverrides?.relightRadius ?? NaN;
  const delight = m ? m[2] === '1' : /personaDelight=1/i.test(Object.values(report.clips ?? {})[0]?.flags ?? '');
  return `${Number.isFinite(radius) ? `${Math.round(radius * 100)}%` : run} / de-light ${delight ? 'on' : 'off'}`;
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);
}

function mean(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

export interface SweepRow {
  persona: string;
  setting: string;
  identityMargin: number | null;
  toPersona: number | null;
  toDriver: number | null;
  neckGapAbs: number | null;
  earsGapAbs: number | null;
  sideGap: number | null;
  lampSlopeD: number | null;
  interiorSharpGapAbs: number | null;
  delightRange: number | null;
}

/** Aggregates one persona's clip summaries under one setting. */
export function sweepRow(persona: string, setting: string, clips: Record<string, ClipSummary>): SweepRow {
  const all = Object.values(clips);
  return {
    persona,
    setting,
    identityMargin: mean(all.map((c) => c.identity?.margin)),
    toPersona: mean(all.map((c) => c.identity?.toPersona)),
    toDriver: mean(all.map((c) => c.identity?.toDriver)),
    neckGapAbs: mean(all.map((c) => (c.targets.skinToneNeck.gap === null ? null : Math.abs(c.targets.skinToneNeck.gap)))),
    earsGapAbs: mean(all.map((c) => (c.targets.skinToneEars.gap === null ? null : Math.abs(c.targets.skinToneEars.gap)))),
    sideGap: mean(all.map((c) => c.shading?.sideGap)),
    lampSlopeD: clips.D?.shading?.slope ?? null,
    interiorSharpGapAbs: mean(all.map((c) => (c.targets.sharpnessInterior?.gap === null || c.targets.sharpnessInterior?.gap === undefined ? null : Math.abs(c.targets.sharpnessInterior.gap)))),
    delightRange: mean(all.map((c) => c.personaDelightRange)),
  };
}

function fitHeight(img: RgbaImage, h: number): RgbaImage {
  return scaleImage(img, h / img.height);
}

function identityCrops(dir: string, count: number): RgbaImage[] {
  const idDir = path.join(dir, 'identity');
  if (!fs.existsSync(idDir)) return [];
  const files = fs.readdirSync(idDir).filter((f) => f.endsWith('-output.png')).sort();
  if (!files.length) return [];
  const picks = count >= files.length ? files : Array.from({ length: count }, (_, i) => files[Math.floor(((i + 0.5) * files.length) / count)]);
  return picks.map((f) => fitHeight(decodeImageFile(path.join(idDir, f)), TILE_H));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.join(OUT, args.out);
  fs.mkdirSync(path.join(outDir, 'sheets'), { recursive: true });
  const reports = args.runs.map((run) => {
    const file = path.join(OUT, run, 'report.json');
    if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
    return { run, report: JSON.parse(fs.readFileSync(file, 'utf8')) as Report };
  });
  // Personas: the default persona (clips at the run root) plus every grid persona.
  const personas = new Set<string>();
  for (const { report } of reports) {
    if (report.clips && Object.keys(report.clips).length) personas.add('default');
    for (const id of Object.keys(report.grid?.personas ?? {})) personas.add(id);
  }
  const rows: SweepRow[] = [];
  const settings: string[] = [];
  for (const persona of personas) {
    const sheetRows: SheetRow[] = [];
    for (const { run, report } of reports) {
      const setting = settingLabel(run, report);
      if (!settings.includes(setting)) settings.push(setting);
      const clips = persona === 'default' ? Object.fromEntries(Object.entries(report.clips ?? {}).map(([k, v]) => [k, v.summary])) : report.grid?.personas[persona]?.clips;
      if (!clips) continue;
      const picked = Object.fromEntries(Object.entries(clips).filter(([k]) => args.clips.includes(k)));
      rows.push(sweepRow(persona, setting, picked));
      const tiles: SheetRow['tiles'] = [];
      const photo = persona === 'default' ? null : report.grid?.personas[persona]?.file;
      if (photo && fs.existsSync(path.join(ROOT, photo))) tiles.push({ label: setting, image: fitHeight(decodeImageFile(path.join(ROOT, photo)), TILE_H) });
      for (const clip of args.clips) {
        const dir = persona === 'default' ? path.join(OUT, run, clip) : path.join(OUT, run, 'personas', persona, clip);
        const crops = identityCrops(dir, 2);
        crops.forEach((img, i) => tiles.push({ label: `${clip} ${i + 1}`, image: img }));
      }
      const r = rows[rows.length - 1];
      sheetRows.push({ label: `${persona === 'default' ? setting.replace(' / de-light ', ' dl ') : 'id'} ${fmt(r.identityMargin)}`, tiles });
    }
    if (sheetRows.length) {
      const sheet = contactSheet(`${persona}  identity-vs-lighting sweep (rows = settings; label = identity margin)`, sheetRows);
      writePng(path.join(outDir, 'sheets', `${persona}.png`), sheet);
    }
  }
  // Table: per persona × setting, then the median per setting over the personas.
  const header = '| persona | setting | id margin | out↔persona | out↔wearer | neck gap | ears gap | side gap L | D slope | int. sharp gap | de-light range |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = [header, sep];
  for (const r of rows) {
    lines.push(`| ${r.persona} | ${r.setting} | ${fmt(r.identityMargin)} | ${fmt(r.toPersona)} | ${fmt(r.toDriver)} | ${fmt(r.neckGapAbs)} | ${fmt(r.earsGapAbs)} | ${fmt(r.sideGap, 1)} | ${fmt(r.lampSlopeD)} | ${fmt(r.interiorSharpGapAbs)} | ${fmt(r.delightRange, 1)} |`);
  }
  lines.push('', '| setting (median over personas) | id margin | out↔persona | out↔wearer | neck gap | ears gap | side gap L | D slope | int. sharp gap |', '|---|---|---|---|---|---|---|---|---|');
  const summary: Array<Record<string, number | string | null>> = [];
  for (const setting of settings) {
    const rs = rows.filter((r) => r.setting === setting);
    const med = (pick: (r: SweepRow) => number | null) => medianOf(rs.map(pick).filter((v): v is number => v !== null));
    const s = {
      setting,
      identityMargin: med((r) => r.identityMargin),
      toPersona: med((r) => r.toPersona),
      toDriver: med((r) => r.toDriver),
      neckGapAbs: med((r) => r.neckGapAbs),
      earsGapAbs: med((r) => r.earsGapAbs),
      sideGap: med((r) => r.sideGap),
      lampSlopeD: med((r) => r.lampSlopeD),
      interiorSharpGapAbs: med((r) => r.interiorSharpGapAbs),
    };
    summary.push(s);
    lines.push(`| ${setting} | ${fmt(s.identityMargin)} | ${fmt(s.toPersona)} | ${fmt(s.toDriver)} | ${fmt(s.neckGapAbs)} | ${fmt(s.earsGapAbs)} | ${fmt(s.sideGap, 1)} | ${fmt(s.lampSlopeD)} | ${fmt(s.interiorSharpGapAbs)} |`);
  }
  fs.writeFileSync(path.join(outDir, 'table.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'sweep.json'), JSON.stringify({ runs: args.runs, clips: args.clips, rows, summary }, null, 2) + '\n');
  console.log(lines.join('\n'));
  console.log(`\nsheets: ${path.relative(ROOT, path.join(outDir, 'sheets'))}  table: ${path.relative(ROOT, path.join(outDir, 'table.md'))}`);
}

if (process.argv[1] && /sweep\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) main();

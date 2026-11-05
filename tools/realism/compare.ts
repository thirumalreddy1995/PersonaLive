/**
 * Before → after comparison of two capture runs (docs/REALISM_PLAN.md, phase report).
 *
 *   npm run realism:compare -- baseline r1-candidate [--clips A,E] [--md]
 *
 * Reads realism-review/out/<run>/report.json of both runs and prints, per clip, the metrics the
 * phase reports lead with: texture slide, flicker, synthetic-teeth frames, skin-tone gaps,
 * sharpness gap, forehead tone step, seam and lip error. With persona grids in both runs it also
 * compares the per-metric median / worst-10% and lists personas that regressed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_DIR } from './session.ts';

interface Targets {
  skinToneNeck: { driver: number | null; output: number | null; gap: number | null; pass: boolean | null };
  skinToneEars: { driver: number | null; output: number | null; gap: number | null; pass: boolean | null };
  sharpness: { driver: number | null; output: number | null; gap: number | null; pass: boolean | null };
}

interface Summary {
  targets: Targets;
  seamRatio: number | null;
  mouthLipErrorPct: number | null;
  syntheticTeethFramesWholeClip: number;
  framesRenderedWholeClip: number;
  foreheadToneStepOutput: number | null;
  foreheadToneStepDriver: number | null;
  foreheadToneStepDelta: number | null;
  flicker: { delta: number | null } | null;
  textureSlide: { residualPx: number | null } | null;
  performance: { fps: number; frameP95Ms: number };
}

interface Report {
  run: string;
  clips?: Record<string, { summary: Summary; flags: string }>;
  grid?: {
    personas: Record<string, { clips: Record<string, Summary>; status: string }>;
    aggregate: { personas: number; metrics: Record<string, { label: string; median: number | null; worst10pct: number | null; worst3: Array<{ persona: string; value: number }> }> };
  };
}

/** The rows of the before → after table; `higherIsWorse` decides the arrow. */
export const COMPARE_ROWS: Array<{ key: string; label: string; pick: (s: Summary) => number | null; higherIsWorse: boolean; digits?: number }> = [
  { key: 'textureSlide', label: 'texture slide (px/frame)', pick: (s) => s.textureSlide?.residualPx ?? null, higherIsWorse: true },
  { key: 'flicker', label: 'flicker Δ (output − driver)', pick: (s) => s.flicker?.delta ?? null, higherIsWorse: true },
  { key: 'teeth', label: 'synthetic-teeth frames (share)', pick: (s) => (s.framesRenderedWholeClip ? s.syntheticTeethFramesWholeClip / s.framesRenderedWholeClip : null), higherIsWorse: true },
  { key: 'skinNeckGap', label: 'skin tone gap vs neck (ΔE)', pick: (s) => s.targets.skinToneNeck.gap, higherIsWorse: true },
  { key: 'skinEarsGap', label: 'skin tone gap vs ears (ΔE)', pick: (s) => s.targets.skinToneEars.gap, higherIsWorse: true },
  { key: 'sharpnessGap', label: 'sharpness gap (fraction of driver)', pick: (s) => s.targets.sharpness.gap, higherIsWorse: true },
  { key: 'foreheadDelta', label: 'forehead step Δ (output − driver)', pick: (s) => s.foreheadToneStepDelta, higherIsWorse: true },
  { key: 'foreheadOut', label: 'forehead step output (ΔE)', pick: (s) => s.foreheadToneStepOutput, higherIsWorse: true },
  { key: 'seam', label: 'seam ratio', pick: (s) => s.seamRatio, higherIsWorse: true },
  { key: 'lipErr', label: 'lip error (% face width)', pick: (s) => s.mouthLipErrorPct, higherIsWorse: true },
  { key: 'fps', label: 'fps', pick: (s) => s.performance?.fps ?? null, higherIsWorse: false, digits: 1 },
  { key: 'p95', label: 'p95 frame ms', pick: (s) => s.performance?.frameP95Ms ?? null, higherIsWorse: true, digits: 1 },
];

function fmt(v: number | null, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(digits);
}

/** Direction marker: better, worse or unchanged (within 2% or 0.01). */
export function verdict(before: number | null, after: number | null, higherIsWorse: boolean): string {
  if (before === null || after === null) return '';
  const diff = after - before;
  if (Math.abs(diff) <= Math.max(0.01, Math.abs(before) * 0.02)) return '=';
  const better = higherIsWorse ? diff < 0 : diff > 0;
  return better ? 'better' : 'WORSE';
}

function loadReport(run: string): Report {
  const file = path.isAbsolute(run) ? run : path.join(REVIEW_DIR, 'out', run, 'report.json');
  if (!fs.existsSync(file)) throw new Error(`No report at ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Report;
}

export interface ClipComparison {
  clip: string;
  rows: Array<{ label: string; before: number | null; after: number | null; verdict: string; digits: number }>;
}

export function compareClips(before: Report, after: Report, clips?: string[]): ClipComparison[] {
  const labels = clips ?? Object.keys(after.clips ?? {}).filter((c) => before.clips?.[c]);
  return labels.map((clip) => {
    const b = before.clips?.[clip]?.summary;
    const a = after.clips?.[clip]?.summary;
    return {
      clip,
      rows: COMPARE_ROWS.map((r) => {
        const bv = b ? r.pick(b) : null;
        const av = a ? r.pick(a) : null;
        return { label: r.label, before: bv, after: av, verdict: verdict(bv, av, r.higherIsWorse), digits: r.digits ?? 2 };
      }),
    };
  });
}

export interface GridComparison {
  metrics: Array<{ key: string; label: string; medianBefore: number | null; medianAfter: number | null; worst10Before: number | null; worst10After: number | null; verdictMedian: string; verdictWorst10: string }>;
  /** Personas whose per-persona value got worse by more than the tolerance on a metric. */
  regressions: Array<{ persona: string; metric: string; before: number; after: number }>;
}

function personaValue(g: Report['grid'], persona: string, pick: (s: Summary) => number | null): number | null {
  const clips = g?.personas[persona]?.clips;
  if (!clips) return null;
  const v = Object.values(clips).map(pick).filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null;
}

export function compareGrids(before: Report, after: Report): GridComparison | null {
  if (!before.grid || !after.grid) return null;
  const metrics = Object.keys(after.grid.aggregate.metrics)
    .filter((k) => before.grid!.aggregate.metrics[k])
    .map((key) => {
      const b = before.grid!.aggregate.metrics[key];
      const a = after.grid!.aggregate.metrics[key];
      return {
        key,
        label: a.label,
        medianBefore: b.median,
        medianAfter: a.median,
        worst10Before: b.worst10pct,
        worst10After: a.worst10pct,
        verdictMedian: verdict(b.median, a.median, true),
        verdictWorst10: verdict(b.worst10pct, a.worst10pct, true),
      };
    });
  const regressions: GridComparison['regressions'] = [];
  const rows = COMPARE_ROWS.filter((r) => !['fps', 'p95', 'foreheadOut'].includes(r.key));
  for (const persona of Object.keys(after.grid.personas)) {
    if (!before.grid.personas[persona]) continue;
    for (const r of rows) {
      const bv = personaValue(before.grid, persona, r.pick);
      const av = personaValue(after.grid, persona, r.pick);
      if (bv === null || av === null) continue;
      if (verdict(bv, av, r.higherIsWorse) === 'WORSE') regressions.push({ persona, metric: r.label, before: bv, after: av });
    }
  }
  return { metrics, regressions };
}

function main() {
  const argv = process.argv.slice(2);
  const runs = argv.filter((a) => !a.startsWith('--'));
  const md = argv.includes('--md');
  const clipsArg = argv.indexOf('--clips');
  const clips = clipsArg >= 0 ? argv[clipsArg + 1].split(',') : undefined;
  if (runs.length !== 2) throw new Error('usage: realism:compare <before-run> <after-run> [--clips A,E] [--md]');
  const before = loadReport(runs[0]);
  const after = loadReport(runs[1]);

  const comparisons = compareClips(before, after, clips);
  for (const c of comparisons) {
    console.log(`\n${md ? '### ' : ''}Clip ${c.clip}: ${runs[0]} → ${runs[1]}`);
    if (md) console.log('| Metric | before | after | |\n|---|---|---|---|');
    for (const r of c.rows) {
      if (md) console.log(`| ${r.label} | ${fmt(r.before, r.digits)} | ${fmt(r.after, r.digits)} | ${r.verdict} |`);
      else console.log(`  ${r.label.padEnd(36)} ${fmt(r.before, r.digits).padStart(8)} → ${fmt(r.after, r.digits).padStart(8)}  ${r.verdict}`);
    }
  }
  const grid = compareGrids(before, after);
  if (grid) {
    console.log(`\n${md ? '### ' : ''}Persona grid: median / worst 10% (${Object.keys(before.grid!.personas).length} → ${Object.keys(after.grid!.personas).length} personas)`);
    if (md) console.log('| Metric | median before | median after | | worst 10% before | worst 10% after | |\n|---|---|---|---|---|---|---|');
    for (const m of grid.metrics) {
      if (md) console.log(`| ${m.label} | ${fmt(m.medianBefore)} | ${fmt(m.medianAfter)} | ${m.verdictMedian} | ${fmt(m.worst10Before)} | ${fmt(m.worst10After)} | ${m.verdictWorst10} |`);
      else console.log(`  ${m.label.padEnd(40)} median ${fmt(m.medianBefore)} → ${fmt(m.medianAfter)} ${m.verdictMedian.padEnd(6)} worst10% ${fmt(m.worst10Before)} → ${fmt(m.worst10After)} ${m.verdictWorst10}`);
    }
    console.log(`\nPersonas that regressed (${grid.regressions.length}):`);
    for (const r of grid.regressions) console.log(`  ${r.persona}: ${r.metric} ${fmt(r.before)} → ${fmt(r.after)}`);
  }
}

if (process.argv[1] && /compare\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

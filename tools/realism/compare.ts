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

interface Check {
  driver: number | null;
  output: number | null;
  gap: number | null;
  pass: boolean | null;
}

interface Targets {
  skinToneNeck: Check;
  skinToneEars: Check;
  sharpness: Check;
  /** Present from R2 on (driver-side controls). */
  slide?: Check;
  seam?: Check;
  /** Present from R3 on. */
  sharpnessInterior?: Check;
  seamStep?: Check;
}

interface Summary {
  identity?: { toPersona: number | null; toDriver: number | null; margin: number | null } | null;
  relightRadius?: number | null;
  ghostHairShare?: number | null;
  handLeakShare?: number | null;
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
  /** Present from R3 on. */
  shading?: { slope: number | null; correlation: number | null; sideGap: number } | null;
  cameraMatchTrace?: { min: number; max: number; std: number; meanStep: number; updates: number } | null;
}

interface Report {
  run: string;
  clips?: Record<string, { summary: Summary; flags: string }>;
  grid?: {
    personas: Record<string, { clips: Record<string, Summary>; status: string }>;
    aggregate: { personas: number; metrics: Record<string, { label: string; median: number | null; worst10pct: number | null; worst3: Array<{ persona: string; value: number }> }> };
  };
}

/**
 * The rows of the before → after table. `higherIsWorse` decides the arrow, `abs` judges a signed
 * gap by its magnitude, and `noise` is the run-to-run spread measured by repeating a capture
 * (same build, same flags): a change smaller than that is "=", not a regression.
 */
export interface CompareRow {
  key: string;
  label: string;
  pick: (s: Summary) => number | null;
  higherIsWorse: boolean;
  abs?: boolean;
  noise: number;
  digits?: number;
}

export const COMPARE_ROWS: CompareRow[] = [
  { key: 'idPersona', label: 'identity: output ↔ persona cosine', pick: (s) => s.identity?.toPersona ?? null, higherIsWorse: false, noise: 0.03 },
  { key: 'idDriver', label: 'identity: output ↔ wearer cosine', pick: (s) => s.identity?.toDriver ?? null, higherIsWorse: true, noise: 0.03 },
  { key: 'idMargin', label: 'identity margin (persona − wearer)', pick: (s) => s.identity?.margin ?? null, higherIsWorse: false, noise: 0.04 },
  { key: 'ghostHair', label: 'ghost hair share (persona over hair)', pick: (s) => s.ghostHairShare ?? null, higherIsWorse: true, noise: 0.01, digits: 3 },
  { key: 'handLeak', label: 'hand leak share (persona over a hand)', pick: (s) => s.handLeakShare ?? null, higherIsWorse: true, noise: 0.01, digits: 3 },
  { key: 'radius', label: 'relight radius (% face width)', pick: (s) => (s.relightRadius === null || s.relightRadius === undefined ? null : s.relightRadius * 100), higherIsWorse: false, noise: 0.3, digits: 1 },
  { key: 'textureSlide', label: 'texture slide (px/frame)', pick: (s) => s.textureSlide?.residualPx ?? null, higherIsWorse: true, noise: 0.25 },
  { key: 'slideGap', label: 'texture slide gap (output − driver)', pick: (s) => s.targets.slide?.gap ?? null, higherIsWorse: true, noise: 0.25 },
  { key: 'flicker', label: 'flicker Δ (output − driver)', pick: (s) => s.flicker?.delta ?? null, higherIsWorse: true, noise: 0.6 },
  { key: 'teeth', label: 'synthetic-teeth frames (share)', pick: (s) => (s.framesRenderedWholeClip ? s.syntheticTeethFramesWholeClip / s.framesRenderedWholeClip : null), higherIsWorse: true, noise: 0.02 },
  { key: 'skinNeckGap', label: 'skin tone gap vs neck (ΔE)', pick: (s) => s.targets.skinToneNeck.gap, higherIsWorse: true, abs: true, noise: 0.5 },
  { key: 'skinEarsGap', label: 'skin tone gap vs ears (ΔE)', pick: (s) => s.targets.skinToneEars.gap, higherIsWorse: true, abs: true, noise: 0.5 },
  { key: 'sharpnessInteriorGap', label: 'sharpness gap, interior skin', pick: (s) => s.targets.sharpnessInterior?.gap ?? null, higherIsWorse: true, abs: true, noise: 0.3 },
  { key: 'sharpnessGap', label: 'sharpness gap, face/ring', pick: (s) => s.targets.sharpness.gap, higherIsWorse: true, abs: true, noise: 0.3 },
  { key: 'foreheadDelta', label: 'forehead step Δ (output − driver)', pick: (s) => s.foreheadToneStepDelta, higherIsWorse: true, abs: true, noise: 0.5 },
  { key: 'foreheadOut', label: 'forehead step output (ΔE)', pick: (s) => s.foreheadToneStepOutput, higherIsWorse: true, noise: 0.5 },
  { key: 'seamStepOut', label: 'seam step output (ΔE)', pick: (s) => s.targets.seamStep?.output ?? null, higherIsWorse: true, noise: 0.5 },
  { key: 'seamStepGap', label: 'seam step gap (output − driver, ΔE)', pick: (s) => s.targets.seamStep?.gap ?? null, higherIsWorse: true, noise: 0.5 },
  { key: 'shadingSlope', label: 'shading slope (1 = follows the lamp)', pick: (s) => s.shading?.slope ?? null, higherIsWorse: false, noise: 0.1 },
  { key: 'sideShadingGap', label: 'side shading gap (L)', pick: (s) => s.shading?.sideGap ?? null, higherIsWorse: true, noise: 1 },
  { key: 'blurBiasSwing', label: 'blur bias swing (max − min)', pick: (s) => (s.cameraMatchTrace ? s.cameraMatchTrace.max - s.cameraMatchTrace.min : null), higherIsWorse: true, noise: 0.3 },
  { key: 'seam', label: 'seam ratio', pick: (s) => s.seamRatio, higherIsWorse: true, noise: 0.1 },
  { key: 'seamGap', label: 'seam gap (output − driver)', pick: (s) => s.targets.seam?.gap ?? null, higherIsWorse: true, noise: 0.1 },
  { key: 'lipErr', label: 'lip error (% face width)', pick: (s) => s.mouthLipErrorPct, higherIsWorse: true, noise: 0.3 },
  { key: 'fps', label: 'fps', pick: (s) => s.performance?.fps ?? null, higherIsWorse: false, noise: 2, digits: 1 },
  { key: 'p95', label: 'p95 frame ms', pick: (s) => s.performance?.frameP95Ms ?? null, higherIsWorse: true, noise: 2, digits: 1 },
];

function fmt(v: number | null, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(digits);
}

/** Direction marker: better, worse or unchanged (within `noise`, or 2% of the value when no noise is given). */
export function verdict(before: number | null, after: number | null, higherIsWorse: boolean, noise = 0, abs = false): string {
  if (before === null || after === null) return '';
  const b = abs ? Math.abs(before) : before;
  const a = abs ? Math.abs(after) : after;
  const diff = a - b;
  if (Math.abs(diff) <= Math.max(noise, 0.01, Math.abs(b) * 0.02)) return '=';
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
        return { label: r.label, before: bv, after: av, verdict: verdict(bv, av, r.higherIsWorse, r.noise, r.abs), digits: r.digits ?? 2 };
      }),
    };
  });
}

/** Noise floor per report.grid aggregate key (same values as the matching COMPARE_ROWS). */
const GRID_NOISE: Record<string, number> = {
  skinToneNeckGapAbs: 0.5,
  skinToneEarsGapAbs: 0.5,
  sharpnessGapAbs: 0.3,
  sharpnessInteriorGapAbs: 0.3,
  seamStepOut: 0.5,
  seamStepGap: 0.5,
  sideShadingGap: 1,
  seamRatio: 0.1,
  mouthLipErrorPct: 0.3,
  syntheticTeethShare: 0.02,
  foreheadToneStepDelta: 0.5,
  flickerDelta: 0.6,
  textureSlidePx: 0.25,
  slideGapPx: 0.25,
  seamGap: 0.1,
};

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
        verdictMedian: verdict(b.median, a.median, true, GRID_NOISE[key] ?? 0),
        verdictWorst10: verdict(b.worst10pct, a.worst10pct, true, GRID_NOISE[key] ?? 0),
      };
    });
  const regressions: GridComparison['regressions'] = [];
  const rows = COMPARE_ROWS.filter((r) => !['fps', 'p95', 'foreheadOut', 'shadingSlope', 'blurBiasSwing'].includes(r.key));
  for (const persona of Object.keys(after.grid.personas)) {
    if (!before.grid.personas[persona]) continue;
    for (const r of rows) {
      const bv = personaValue(before.grid, persona, r.pick);
      const av = personaValue(after.grid, persona, r.pick);
      if (bv === null || av === null) continue;
      if (verdict(bv, av, r.higherIsWorse, r.noise, r.abs) === 'WORSE') regressions.push({ persona, metric: r.label, before: bv, after: av });
    }
  }
  return { metrics, regressions };
}

function main() {
  const argv = process.argv.slice(2);
  const md = argv.includes('--md');
  const clipsArg = argv.indexOf('--clips');
  const clips = clipsArg >= 0 ? argv[clipsArg + 1].split(',') : undefined;
  const runs = argv.filter((a, i) => !a.startsWith('--') && (clipsArg < 0 || i !== clipsArg + 1));
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

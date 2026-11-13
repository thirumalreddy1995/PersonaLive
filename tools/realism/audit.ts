/**
 * Visual audit pages (R6b): full-resolution face crops, never thumbnails, with the persona's own
 * photo beside them. One row per capture time: persona photo | camera | the output of each run.
 *
 *   npm run realism:audit -- --runs r7a-me2bro,r6b-me2bro --labels before,after --clip A,B,C,E --out r6b-audit-me2bro
 *
 * Options
 *   --runs <a,b,...>        run folders under realism-review/out (same clip, same capture times)
 *   --labels <a,b,...>      column captions (default: the run names)
 *   --clip <A,B,...>        clip labels (default: every clip folder of the first run)
 *   --reference <file>      the persona photo (default: report.json app.personaPhoto of the first run)
 *   --out <name>            output folder under realism-review/out (default: audit-<first run>)
 *   --per-page <n>          rows per page (default 3)
 *
 * The pages are PNGs under realism-review/out/<name>/, which is gitignored like every frame.
 */
import fs from 'node:fs';
import path from 'node:path';
import { auditFaceRect, referenceRect } from './auditLayout.ts';
import { contactSheet, crop, decodeImageFile, scaleImage, writePng, type SheetRow } from './png.ts';
import type { RgbaImage } from './metrics.ts';
import { REVIEW_DIR, ROOT } from './session.ts';

interface Args {
  runs: string[];
  labels: string[];
  clips: string[];
  reference: string | null;
  out: string | null;
  perPage: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { runs: [], labels: [], clips: [], reference: null, out: null, perPage: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === '--runs') a.runs = next().split(',').filter(Boolean);
    else if (k === '--labels') a.labels = next().split(',');
    else if (k === '--clip') a.clips = next().split(',').filter(Boolean);
    else if (k === '--reference') a.reference = path.resolve(next());
    else if (k === '--out') a.out = next();
    else if (k === '--per-page') a.perPage = Math.max(1, Number(next()) || 3);
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.runs.length) throw new Error('--runs is required');
  return a;
}

const OUT_DIR = path.join(REVIEW_DIR, 'out');

function timeOf(file: string): number {
  const m = /^t(\d+)_(\d+)-output\.png$/.exec(file);
  return m ? Number(`${m[1]}.${m[2]}`) : NaN;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const first = path.join(OUT_DIR, args.runs[0]);
  const report = JSON.parse(fs.readFileSync(path.join(first, 'report.json'), 'utf8')) as { app?: { personaPhoto?: string | null } };
  const refFile = args.reference ?? (report.app?.personaPhoto ? path.join(ROOT, report.app.personaPhoto) : null);
  const reference: RgbaImage | null = refFile && fs.existsSync(refFile) ? decodeImageFile(refFile) : null;
  if (!reference) console.warn('No persona photo (pass --reference <file>): the pages show camera and outputs only.');
  const clips = args.clips.length ? args.clips : fs.readdirSync(first).filter((d) => fs.statSync(path.join(first, d)).isDirectory() && d !== 'personas');
  const outName = args.out ?? `audit-${args.runs[0]}`;
  const outDir = path.join(OUT_DIR, outName);
  fs.mkdirSync(outDir, { recursive: true });
  const labels = args.runs.map((r, i) => args.labels[i] ?? r);
  for (const clip of clips) {
    const dir = path.join(first, clip);
    if (!fs.existsSync(dir)) {
      console.warn(`clip ${clip}: not in ${args.runs[0]}`);
      continue;
    }
    const frames = fs.readdirSync(dir).filter((f) => /^t\d+_\d+-output\.png$/.test(f)).sort((x, y) => timeOf(x) - timeOf(y));
    const rows: SheetRow[] = [];
    for (const f of frames) {
      const tag = f.replace(/-output\.png$/, '');
      const lmFile = path.join(dir, `${tag}-landmarks.json`);
      if (!fs.existsSync(lmFile)) continue;
      const lm = JSON.parse(fs.readFileSync(lmFile, 'utf8')) as { driver: number[] };
      const camera = decodeImageFile(path.join(dir, `${tag}-driver.png`));
      const box = auditFaceRect(lm.driver, camera.width, camera.height);
      const tiles: SheetRow['tiles'] = [];
      if (reference) {
        const rr = referenceRect(reference.width, reference.height, box.w / box.h);
        tiles.push({ label: 'persona photo', image: scaleImage(crop(reference, rr), box.h / Math.max(1, rr.h)) });
      }
      tiles.push({ label: 'camera', image: crop(camera, box) });
      args.runs.forEach((run, i) => {
        const file = path.join(OUT_DIR, run, clip, f);
        if (fs.existsSync(file)) tiles.push({ label: labels[i], image: crop(decodeImageFile(file), box) });
        else console.warn(`  ${run}/${clip}/${f} missing`);
      });
      rows.push({ label: `${clip} ${timeOf(f).toFixed(2)}s`, tiles });
    }
    for (let p = 0; p * args.perPage < rows.length; p++) {
      const page = rows.slice(p * args.perPage, (p + 1) * args.perPage);
      const file = path.join(outDir, `${clip}-${p + 1}.png`);
      writePng(file, contactSheet(`${clip}  ${labels.join(' / ')}`, page));
      console.log(path.relative(ROOT, file));
    }
  }
}

main();

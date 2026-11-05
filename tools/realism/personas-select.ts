/**
 * Builds the persona test set (synthetic faces only) — docs/REALISM_PLAN.md, "Persona test set".
 *
 *   npm run realism:personas -- --source <folder with the SFHQ-T2I download> [--count 24] [--degrade 4]
 *
 * The source folder is the Kaggle download of SFHQ-T2I (github.com/SelfishGene/SFHQ-T2I-dataset):
 * its `SFHQ_T2I_dataset.csv` (one row per image: prompt, model, seed, …) and the images. Nothing
 * is downloaded by this tool; it only selects. Prompts are parsed into attributes (gender,
 * ethnicity, age decade, skin tone, facial hair, glasses, hairline) and ~`count` frontal, neutral
 * faces are picked so the set covers at least 8 South Asian faces, light to dark skin, men and
 * women, ages 20s–60s, beard / moustache / clean-shaven, glasses, a receding hairline and a
 * fringe. The chosen images are copied to gitignored realism-review/personas/<id>.<ext>, `degrade`
 * of them also get a downscaled, twice-recompressed copy (<id>-degraded.jpg) to exercise the R2
 * quality gate, and manifest.json records source, image id, prompt, attributes and the licence note.
 *
 * Options
 *   --source <dir>     the SFHQ-T2I download (required)
 *   --count <n>        clean personas to select (default 24)
 *   --degrade <n>      how many of them get a degraded copy (default 4)
 *   --models <list>    generator models to accept (default Flux1.pro,Flux1.dev,Flux1.schnell,SDXL; DALL-E 3 is excluded)
 *   --out <dir>        output folder (default realism-review/personas)
 *   --dry-run          print the selection and coverage without copying anything
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeImageFile, writePng } from './png.ts';
import { degradeImage, WHATSAPP_LIKE } from './degrade.ts';
import { PERSONAS_DIR, PersonaAttributes, PersonaManifest, PersonaManifestEntry, coverage, parseCsv, parsePromptAttributes, promptRejectReason, selectPersonas } from './personaSet.ts';
import { ROOT } from './session.ts';

interface Args {
  source: string;
  count: number;
  degrade: number;
  models: string[];
  out: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { source: '', count: 24, degrade: 4, models: ['Flux1.pro', 'Flux1.dev', 'Flux1.schnell', 'SDXL'], out: PERSONAS_DIR, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--source':
        args.source = path.resolve(next());
        break;
      case '--count':
        args.count = Number(next());
        break;
      case '--degrade':
        args.degrade = Number(next());
        break;
      case '--models':
        args.models = next().split(',').map((s) => s.trim());
        break;
      case '--out':
        args.out = path.resolve(next());
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${a}`);
    }
  }
  if (!args.source) throw new Error('--source <SFHQ-T2I download folder> is required');
  return args;
}

function findColumn(columns: string[], candidates: RegExp[]): string | null {
  for (const re of candidates) {
    const hit = columns.find((c) => re.test(c));
    if (hit) return hit;
  }
  return null;
}

interface Candidate {
  imageId: string;
  /** Local file, or null in plan mode (CSV only, images not downloaded yet). */
  file: string | null;
  originalFile: string;
  model: string;
  prompt: string;
  attributes: PersonaAttributes;
}

function indexImages(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
        map.set(entry.name, full);
        map.set(path.basename(entry.name, path.extname(entry.name)), full);
      }
    }
  };
  walk(dir);
  return map;
}

function loadCandidates(source: string, models: string[]): Candidate[] {
  const csvFile = fs
    .readdirSync(source)
    .map((f) => path.join(source, f))
    .find((f) => /\.csv$/i.test(f));
  if (!csvFile) throw new Error(`No CSV found in ${source} (expected SFHQ_T2I_dataset.csv next to the images)`);
  const rows = parseCsv(fs.readFileSync(csvFile, 'utf8'));
  if (!rows.length) throw new Error(`${csvFile} is empty`);
  const columns = Object.keys(rows[0]);
  const promptCol = findColumn(columns, [/^text_prompt$/i, /^prompt$/i, /prompt/i]);
  const fileCol = findColumn(columns, [/^image_filename$/i, /^image_name$/i, /^filename$/i, /file|image/i]);
  const modelCol = findColumn(columns, [/^model(_name)?$/i, /model/i]);
  if (!promptCol || !fileCol) throw new Error(`Could not find the prompt/file columns in ${csvFile}; columns: ${columns.join(', ')}`);
  const images = indexImages(source);
  const planMode = images.size === 0;
  const wanted = new Set(models.map((m) => m.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const out: Candidate[] = [];
  const rejected = new Map<string, number>();
  for (const row of rows) {
    const model = modelCol ? row[modelCol] : 'unknown';
    if (modelCol && !wanted.has(model.toLowerCase().replace(/[^a-z0-9]/g, ''))) continue;
    const ref = row[fileCol];
    const file = planMode ? null : (images.get(ref) ?? images.get(path.basename(ref)) ?? images.get(path.basename(ref, path.extname(ref))) ?? null);
    if (!planMode && !file) continue;
    const prompt = row[promptCol];
    const attributes = parsePromptAttributes(prompt);
    // Frontal, neutral, unoccluded, one adult face: reject prompts that ask for anything else.
    const reason = promptRejectReason(prompt, attributes);
    if (reason) {
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
      continue;
    }
    out.push({ imageId: path.basename(ref, path.extname(ref)), file, originalFile: path.basename(ref), model, prompt, attributes });
  }
  const top = [...rejected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`${planMode ? 'plan mode (no images in the source folder): ' : ''}${out.length} suitable prompts; top reject reasons: ${top.map(([r, n]) => `${r} ×${n}`).join(', ')}`);
  return out;
}

function printCoverage(entries: PersonaManifestEntry[]) {
  const c = coverage(entries);
  console.log(`selected ${c.total} clean personas: South Asian ${c.southAsian}, skin ${JSON.stringify(c.skinTones)}, gender ${JSON.stringify(c.genders)}, ages ${JSON.stringify(c.ages)}, facial hair ${JSON.stringify(c.facialHair)}, glasses ${c.glasses}, hairline ${JSON.stringify(c.hairlines)}`);
  if (c.missing.length) console.warn(`coverage gaps: ${c.missing.join('; ')}`);
  else console.log('coverage: all required attributes present');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = loadCandidates(args.source, args.models);
  console.log(`${candidates.length} frontal neutral candidates from ${path.relative(ROOT, args.source) || args.source}`);
  // Deterministic order: by image id, so the same download yields the same set.
  candidates.sort((a, b) => a.imageId.localeCompare(b.imageId));
  const chosen = selectPersonas(candidates, args.count);
  const entries: PersonaManifestEntry[] = chosen.map((c, i) => {
    const id = `p${String(i + 1).padStart(2, '0')}`;
    return {
      id,
      file: `${id}${path.extname(c.originalFile).toLowerCase()}`,
      category: c.attributes.gender === 'woman' ? 'women' : 'men',
      source: { dataset: 'SFHQ-T2I', imageId: c.imageId, model: c.model, originalFile: c.originalFile, kagglePath: `images/images/${c.originalFile}` },
      prompt: c.prompt,
      attributes: c.attributes,
      degradedOf: null,
    };
  });
  printCoverage(entries);
  for (const e of entries) console.log(`  ${e.id} ${e.category} ${JSON.stringify(e.attributes)} ← ${e.source.originalFile}`);
  if (chosen.some((c) => c.file === null)) {
    // Plan mode: list what to fetch (Kaggle single-file downloads), then run again with the images present.
    const selection = { source: path.relative(ROOT, args.source) || args.source, createdAt: new Date().toISOString(), files: chosen.map((c) => `images/images/${c.originalFile}`) };
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'selection.json'), JSON.stringify(selection, null, 2) + '\n');
    console.log(`\nselection written to ${path.relative(ROOT, path.join(args.out, 'selection.json'))}; fetch each file with`);
    console.log(`  kaggle datasets download -d selfishgene/sfhq-t2i-synthetic-faces-from-text-2-image-models -f <path> -p ${path.relative(ROOT, args.source) || args.source}`);
    console.log('then run this command again.');
    return;
  }
  if (args.dryRun) return;

  fs.mkdirSync(args.out, { recursive: true });
  for (const e of entries) fs.copyFileSync(chosen[entries.indexOf(e)].file!, path.join(args.out, e.file));

  // Degraded copies of the first `degrade` entries that cover different attributes.
  const degraded: PersonaManifestEntry[] = [];
  const picks = entries.filter((_, i) => i % Math.max(1, Math.floor(entries.length / Math.max(1, args.degrade))) === 0).slice(0, args.degrade);
  for (const e of picks) {
    const img = decodeImageFile(path.join(args.out, e.file));
    const { image, jpeg } = degradeImage(img, WHATSAPP_LIKE);
    const file = `${e.id}-degraded.jpg`;
    fs.writeFileSync(path.join(args.out, file), jpeg);
    writePng(path.join(args.out, `${e.id}-degraded-preview.png`), image);
    degraded.push({ ...e, id: `${e.id}d`, file, degradedOf: e.id, source: { ...e.source, degradation: `${WHATSAPP_LIKE.maxEdge}px long edge, JPEG q${WHATSAPP_LIKE.quality} × ${WHATSAPP_LIKE.passes}` } });
  }

  const manifest: PersonaManifest = {
    source: 'SFHQ-T2I (github.com/SelfishGene/SFHQ-T2I-dataset; Kaggle selfishgene/sfhq-t2i-synthetic-faces-from-text-2-image-models). Synthetic faces of people who do not exist.',
    licence: 'SFHQ-T2I repository: MIT. Images are synthetic (Flux1 / SDXL outputs); the dataset README states there are no privacy or licence issues. Kept locally for the realism review only; never committed.',
    createdAt: new Date().toISOString(),
    personas: [...entries, ...degraded],
  };
  fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${entries.length} personas + ${degraded.length} degraded copies → ${path.relative(ROOT, args.out)}/manifest.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

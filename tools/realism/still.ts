/**
 * Output-side metrics on still images (screenshots) — docs/REALISM_PLAN.md, forehead tone step.
 *
 *   npm run realism:still -- --image realism-review/before [--run before-check] [--crop x,y,w,h]
 *
 * Runs the app's FaceLandmarker on each image through the built app (Playwright + Chrome), then
 * measures what can be measured without a driver frame: the forehead tone step (upper vs lower
 * forehead patch), the sharpness ratio and the seam score. It writes the image with the patch
 * positions, the face oval and landmarks 9/10 drawn on it (`<name>-patches.png`), a 3x face zoom
 * (`<name>-face.png`) and `stills.json` into realism-review/out/<run>/stills/.
 *
 * Options
 *   --image <path|dir>        image file(s) or a folder of PNG/JPEG screenshots (repeatable, or comma separated)
 *   --run <name>              output folder name (default: stills)
 *   --crop <x,y,w,h>          crop every image to this rectangle first (e.g. the video panel of a UI screenshot)
 *   --url / --browser / --headed   as in capture.ts
 */
import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Browser } from 'playwright';
import * as M from './metrics.ts';
import { REVIEW_DIR, ROOT, driveAppShell, launchBrowser, startPreview, waitForHookState } from './session.ts';
import { crop, decodeImageFile, drawDot, drawPolyline, drawText, encodePng, scaleImage, writePng } from './png.ts';
import { LMK } from './landmarks.ts';

interface Args {
  images: string[];
  run: string;
  crop: M.Rect | null;
  url: string | null;
  browser: string;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { images: [], run: 'stills', crop: null, url: null, browser: 'chrome', headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--image':
        args.images.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--run':
        args.run = next();
        break;
      case '--crop': {
        const [x, y, w, h] = next().split(',').map(Number);
        if (![x, y, w, h].every(Number.isFinite)) throw new Error('--crop needs x,y,w,h');
        args.crop = { x, y, w, h };
        break;
      }
      case '--url':
        args.url = next();
        break;
      case '--browser':
        args.browser = next();
        break;
      case '--headed':
        args.headed = true;
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
  if (!args.images.length) throw new Error('--image is required');
  return args;
}

function expandImages(inputs: string[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    const p = path.resolve(input);
    if (!fs.existsSync(p)) throw new Error(`Not found: ${p}`);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (/\.(png|jpe?g)$/i.test(f)) out.push(path.join(p, f));
    } else out.push(p);
  }
  return out;
}

const CYAN: [number, number, number] = [34, 211, 238];
const ORANGE: [number, number, number] = [251, 146, 60];
const GREEN: [number, number, number] = [74, 222, 128];
const MAGENTA: [number, number, number] = [232, 121, 249];
const WHITE: [number, number, number] = [255, 255, 255];

function annotate(img: M.RgbaImage, pts: Float32Array, step: M.ForeheadStep, scale = 1): M.RgbaImage {
  const out = scale === 1 ? { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) } : scaleImage(img, scale);
  const r = M.faceRegions(pts, img.width, img.height);
  drawPolyline(out, r.oval.map((p) => ({ x: p.x * scale, y: p.y * scale })), GREEN, true, 1);
  // R3 seam-step bands on the jaw and cheeks: inner band magenta, outer band white.
  const seam = M.seamStep(img, pts);
  if (seam) {
    for (const s of seam.segments) {
      drawPolyline(out, s.inner.map((p) => ({ x: p.x * scale, y: p.y * scale })), MAGENTA, true, 1);
      drawPolyline(out, s.outer.map((p) => ({ x: p.x * scale, y: p.y * scale })), WHITE, true, 1);
    }
  }
  const g = M.lm(pts, LMK.GLABELLA);
  const t = M.lm(pts, LMK.TOP);
  drawDot(out, g.x * scale, g.y * scale, MAGENTA, 3);
  drawDot(out, t.x * scale, t.y * scale, MAGENTA, 3);
  const sc = (poly: M.Point[]) => poly.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  drawPolyline(out, sc(step.patches.upper), CYAN, true, 2);
  drawPolyline(out, sc(step.patches.lower), ORANGE, true, 2);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const images = expandImages(args.images);
  const outDir = path.join(REVIEW_DIR, 'out', args.run, 'stills');
  fs.mkdirSync(outDir, { recursive: true });

  let server: { url: string; child: ChildProcess } | null = null;
  let browser: Browser | null = null;
  try {
    const url = args.url ?? (server = await startPreview()).url;
    browser = await launchBrowser({ browser: args.browser, software: false, headed: args.headed });
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    await driveAppShell(page, url, '');
    // The landmarker is ready once the default persona has been analysed.
    await waitForHookState(page, 'landmarker ready', (s) => s?.personaStatus === 'ready' || s?.personaStatus === 'no-face', 120000);

    const results: Array<Record<string, unknown>> = [];
    for (const file of images) {
      const name = path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9_-]+/g, '_');
      let img = decodeImageFile(file);
      if (args.crop) img = crop(img, args.crop);

      // Detect at 1x, then at 2x for small faces (UI screenshots).
      let pts: Float32Array | null = null;
      for (const scale of [1, 2]) {
        const probe = scale === 1 ? img : scaleImage(img, scale);
        const dataUrl = `data:image/png;base64,${encodePng(probe).toString('base64')}`;
        const det = await page.evaluate((d) => window.__personaLiveRealism!.detectImage(d), dataUrl);
        if (det) {
          pts = new Float32Array(det.landmarks.map((v) => v / scale));
          break;
        }
      }
      if (!pts) {
        console.warn(`${name}: no face found`);
        results.push({ file: path.relative(ROOT, file), faceDetected: false });
        continue;
      }

      const step = M.foreheadStep(img, pts);
      const regions = M.faceRegions(pts, img.width, img.height);
      // The same two patches without the hair exclusion, for comparison.
      const rawStep = M.deltaE(img, regions.foreheadUpper, img, regions.foreheadLower);
      const sharpness = M.sharpnessMatch(img, pts);
      const sharpnessInterior = M.sharpnessMatchInterior(img, pts);
      const seam = M.seamScore(img, pts);
      const seamStep = M.seamStep(img, pts);
      // Lip fullness: upper plus lower vermilion height over face height (R3 item 1 persona pick).
      const lipFullness = (M.dist(M.lm(pts, 0), M.lm(pts, 13)) + M.dist(M.lm(pts, 17), M.lm(pts, 14))) / M.faceSize(pts).height;
      if (!step) {
        results.push({ file: path.relative(ROOT, file), faceDetected: true, foreheadStep: null });
        continue;
      }

      const full = annotate(img, pts, step);
      drawText(full, `UPPER (CYAN) VS LOWER (ORANGE) DE ${step.deltaE.toFixed(1)}  RAW ${rawStep === null ? '-' : rawStep.toFixed(1)}`, 8, 8, 2, CYAN);
      drawText(full, `SEAM STEP DE ${seamStep ? seamStep.deltaE.toFixed(1) : '-'} WORST ${seamStep ? seamStep.worst.toFixed(1) : '-'} (MAGENTA IN / WHITE OUT)`, 8, 26, 2, MAGENTA);
      writePng(path.join(outDir, `${name}-patches.png`), full);
      const box = M.clampRect(M.expandRect(regions.ovalBox, 1.5, 1.6), img.width, img.height);
      const zoom = annotate(crop(img, box), shift(pts, -box.x, -box.y), shiftStep(step, -box.x, -box.y), 3);
      drawText(zoom, `DE ${step.deltaE.toFixed(1)} RAW ${rawStep === null ? '-' : rawStep.toFixed(1)}`, 6, 6, 2, CYAN);
      drawText(zoom, `SEAM STEP DE ${seamStep ? seamStep.deltaE.toFixed(1) : '-'} WORST ${seamStep ? seamStep.worst.toFixed(1) : '-'}`, 6, 24, 2, MAGENTA);
      writePng(path.join(outDir, `${name}-face.png`), zoom);

      const faceWidth = regions.size.width;
      const row = {
        file: path.relative(ROOT, file),
        faceDetected: true,
        faceWidthPx: faceWidth,
        foreheadStep: { deltaE: step.deltaE, raw: rawStep, hairlineAt: step.hairlineAt, excluded: step.excluded, pixels: step.pixels, rgb: step.rgb, patches: step.patches },
        sharpnessRatio: sharpness.ratio,
        sharpnessInteriorRatio: sharpnessInterior.ratio,
        lipFullness,
        seamRatio: seam.ratio,
        seamStep: seamStep ? { deltaE: seamStep.deltaE, worst: seamStep.worst, segments: seamStep.segments.map((s) => s.deltaE) } : null,
        outputs: { patches: path.relative(ROOT, path.join(outDir, `${name}-patches.png`)), face: path.relative(ROOT, path.join(outDir, `${name}-face.png`)) },
      };
      results.push(row);
      console.log(
        `${name}: face ${faceWidth.toFixed(0)} px wide, forehead ΔE ${step.deltaE.toFixed(2)} (raw ${rawStep?.toFixed(2)}), hairline ${step.hairlineAt === null ? 'not met' : `${step.hairlineAt} px above lm10`}, ` +
          `excluded upper ${step.excluded.upper}/${step.pixels.upper + step.excluded.upper} lower ${step.excluded.lower}/${step.pixels.lower + step.excluded.lower}, ` +
          `sharpness ${sharpness.ratio.toFixed(2)} (skin ${sharpnessInterior.ratio.toFixed(2)}), seam ratio ${seam.ratio.toFixed(2)}, seam step ΔE ${seamStep ? seamStep.deltaE.toFixed(2) : '-'} worst ${seamStep ? seamStep.worst.toFixed(2) : '-'}, lip fullness ${lipFullness.toFixed(3)}`
      );
    }
    const report = {
      run: args.run,
      crop: args.crop,
      createdAt: new Date().toISOString(),
      patches: { upperFrom: M.FOREHEAD_UPPER_FROM, upperTo: M.FOREHEAD_UPPER_TO, lowerFrom: M.FOREHEAD_LOWER_FROM, lowerTo: M.FOREHEAD_LOWER_TO, halfWidth: M.FOREHEAD_BAND_HALF_WIDTH, hairLuminanceRatio: M.HAIR_LUMINANCE_RATIO, hairlineRowDarkShare: M.HAIRLINE_ROW_DARK_SHARE },
      images: results,
    };
    fs.writeFileSync(path.join(outDir, 'stills.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`→ ${path.relative(ROOT, outDir)}`);
  } finally {
    await browser?.close().catch(() => undefined);
    server?.child.kill();
  }
}

function shift(pts: Float32Array, dx: number, dy: number): Float32Array {
  const out = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = pts[i] + dx;
    out[i + 1] = pts[i + 1] + dy;
  }
  return out;
}

function shiftStep(step: M.ForeheadStep, dx: number, dy: number): M.ForeheadStep {
  const mv = (poly: M.Point[]) => poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  return { ...step, patches: { upper: mv(step.patches.upper), lower: mv(step.patches.lower) } };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Realism capture tool (docs/REALISM_PLAN.md, "Capture script").
 *
 *   npm run realism:capture -- --clip A [--flags oralCavity=0,catchlights=0] [--run baseline]
 *
 * Renders a driver clip through the built app headlessly (Playwright + Chrome), captures PNG
 * frames at fixed timestamps, re-detects landmarks on the output, computes the review metrics,
 * writes a contact sheet with 2x face crops and merges the numbers into
 * realism-review/out/<run>/report.json. Frames never leave realism-review/out (gitignored).
 *
 * Options
 *   --clip <A..E | path>      clip label (realism-review/clips/<label>.{webm,mp4,mov,mkv}) or a file path
 *   --flags <string>          realism flag overrides, e.g. "oralCavity=0,syntheticSuite=off"
 *   --run <name>              output folder name (default: <date>-<flags>)
 *   --times <s,s,...>         capture timestamps in seconds (default: 8 evenly spaced)
 *   --burst <start:count>     consecutive-frame burst for flicker/texture slide (default: 45% of clip, 16 frames)
 *   --persona <name>          click a persona card by (partial) name before capturing
 *   --url <http://...>        use an already running app instead of starting `vite preview`
 *   --browser <chrome|chromium|msedge>   browser channel (default chrome: it has H.264)
 *   --software                force SwiftShader instead of the GPU
 *   --headed                  show the browser window
 */
import { spawn, ChildProcess, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, Browser, Page } from 'playwright';
import { defaultRealismFlags, describeRealismFlags, parseRealismFlagString } from '../../src/realism/flags.ts';
import type { RealismDebugState, SerializedBurst, SerializedCapture } from '../../src/realism/debug.ts';
import * as M from './metrics.ts';
import { compositeOnChecker, contactSheet, crop, decodePngDataUrl, scaleImage, writeDataUrlPng, writePng } from './png.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const REVIEW_DIR = path.join(ROOT, 'realism-review');
const CLIP_EXTENSIONS = ['.webm', '.mp4', '.mov', '.mkv', '.y4m'];

interface Args {
  clip: string;
  flags: string;
  run: string | null;
  times: number[] | null;
  burst: { start: number | null; count: number };
  persona: string | null;
  url: string | null;
  browser: string;
  software: boolean;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    clip: '',
    flags: '',
    run: null,
    times: null,
    burst: { start: null, count: 16 },
    persona: null,
    url: null,
    browser: 'chrome',
    software: false,
    headed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--clip':
        args.clip = next();
        break;
      case '--flags':
        args.flags = next();
        break;
      case '--run':
        args.run = next();
        break;
      case '--times':
        args.times = next()
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));
        break;
      case '--burst': {
        const [s, c] = next().split(':');
        args.burst = { start: s === '' ? null : Number(s), count: c ? Number(c) : 16 };
        break;
      }
      case '--persona':
        args.persona = next();
        break;
      case '--url':
        args.url = next();
        break;
      case '--browser':
        args.browser = next();
        break;
      case '--software':
        args.software = true;
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
  if (!args.clip) throw new Error('--clip is required (A..E or a path)');
  return args;
}

function resolveClip(clip: string): { label: string; file: string } {
  if (/^[A-Za-z0-9_-]+$/.test(clip)) {
    for (const ext of CLIP_EXTENSIONS) {
      const candidate = path.join(REVIEW_DIR, 'clips', clip + ext);
      if (fs.existsSync(candidate)) return { label: clip, file: candidate };
    }
    if (!fs.existsSync(clip)) {
      throw new Error(`No clip named ${clip} in ${path.join(REVIEW_DIR, 'clips')} (tried ${CLIP_EXTENSIONS.join(', ')})`);
    }
  }
  const file = path.resolve(clip);
  if (!fs.existsSync(file)) throw new Error(`Clip not found: ${file}`);
  return { label: path.basename(file, path.extname(file)), file };
}

async function waitForHttp(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 400);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(300);
  }
  throw new Error(`Server at ${url} did not answer within ${timeoutMs} ms`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startPreview(): Promise<{ url: string; child: ChildProcess }> {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html not found. Run `npm run build` first (the capture uses the production build).');
  }
  const port = 4300 + Math.floor(Math.random() * 200);
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DISABLE_HMR: 'true' },
  });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  const url = `http://127.0.0.1:${port}/`;
  await waitForHttp(url, 30000);
  return { url, child };
}

async function launchBrowser(args: Args): Promise<Browser> {
  const chromeArgs = [
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
  ];
  if (args.software) chromeArgs.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const channels = args.browser === 'chromium' ? [undefined] : [args.browser, undefined];
  let lastError: unknown = null;
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: !args.headed, args: chromeArgs });
    } catch (err) {
      lastError = err;
      console.warn(`Could not launch ${channel ?? 'bundled chromium'}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }
  throw new Error(`No browser could be launched. Install Chrome, or run \`npx playwright install chromium\`. Last error: ${lastError}`);
}

async function hookState(page: Page): Promise<RealismDebugState | null> {
  return page.evaluate(() => (window.__personaLiveRealism ? window.__personaLiveRealism.state() : null));
}

async function waitFor(page: Page, label: string, predicate: (s: RealismDebugState | null) => boolean, timeoutMs: number) {
  const started = Date.now();
  let last: RealismDebugState | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await hookState(page);
    if (predicate(last)) return last;
    // The model download sometimes fails on the first try; the UI offers a retry.
    const retry = page.getByRole('button', { name: /Try Again/i }).first();
    if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => undefined);
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify(last && { ...last, profile: undefined, flags: undefined })}`);
}

async function driveApp(page: Page, url: string, args: Args, clipFile: string, flagString: string) {
  const query = new URLSearchParams({ realism: '1' });
  if (flagString) query.set('rf', flagString);
  await page.goto(`${url}?${query.toString()}`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /demo administrator|Sign In as Admin/i }).click({ timeout: 30000 });
  await page.getByRole('button', { name: 'AI Output Only' }).click({ timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__personaLiveRealism), null, { timeout: 30000 });

  if (args.persona) {
    await page.getByText(args.persona, { exact: false }).first().click({ timeout: 10000 });
  }

  const input = page.locator('input[data-realism-clip]');
  await input.waitFor({ state: 'attached', timeout: 10000 });
  await input.setInputFiles(clipFile);

  await waitFor(page, 'clip source', (s) => s?.source === 'file', 30000);
  await waitFor(page, 'persona ready', (s) => s?.personaStatus === 'ready', 120000);
  await waitFor(page, 'face tracked on the clip', (s) => !!s?.faceVisible, 60000);
  const state = await waitFor(page, 'video duration', (s) => (s?.videoDuration ?? 0) > 0, 15000);
  return state!;
}

interface FrameReport {
  t: number;
  frameIndex: number;
  mar: number;
  pose: { yaw: number; pitch: number; roll: number };
  keyframeId: string | null;
  syntheticTeeth: boolean;
  outputFaceDetected: boolean;
  skinTone: M.SkinToneMatch | null;
  sharpness: M.SharpnessMatch;
  driverSharpness: M.SharpnessMatch;
  seam: M.SeamScore;
  mouth: M.MouthFidelity | null;
  foreheadToneStep: M.ForeheadToneStep | null;
  files: { output: string; driver: string; overlay: string | null };
}

function r3(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
}

function roundDeep<T>(value: T): T {
  if (typeof value === 'number') return r3(value) as unknown as T;
  if (Array.isArray(value)) return value.map(roundDeep) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = roundDeep(v);
    return out as T;
  }
  return value;
}

function gitCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { label: clipLabel, file: clipFile } = resolveClip(args.clip);
  const parsed = parseRealismFlagString(args.flags);
  if (parsed.errors.length) throw new Error(`Bad --flags: ${parsed.errors.join('; ')}`);
  const flagValues = { ...defaultRealismFlags(), ...parsed.flags };
  const flagString = describeRealismFlags(flagValues);
  const runName = args.run ?? `${new Date().toISOString().slice(0, 10)}-${flagString === 'defaults' ? 'defaults' : flagString.replace(/[^a-z0-9]+/gi, '_')}`;
  const outDir = path.join(REVIEW_DIR, 'out', runName);
  const clipDir = path.join(outDir, clipLabel);
  fs.mkdirSync(clipDir, { recursive: true });

  console.log(`clip ${clipLabel} (${path.relative(ROOT, clipFile)}), flags: ${flagString}, run: ${runName}`);

  let server: { url: string; child: ChildProcess } | null = null;
  let browser: Browser | null = null;
  try {
    const url = args.url ?? (server = await startPreview()).url;
    browser = await launchBrowser(args);
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

    const ready = await driveApp(page, url, args, clipFile, flagString === 'defaults' ? '' : flagString);
    const duration = ready.videoDuration!;
    const times = (args.times ?? Array.from({ length: 8 }, (_, i) => duration * (0.1 + (0.8 * i) / 7))).filter((t) => t < duration - 0.1);
    const burstStart = args.burst.start ?? duration * 0.45;
    console.log(`duration ${duration.toFixed(2)} s, capturing at ${times.map((t) => t.toFixed(2)).join(', ')} s; burst from ${burstStart.toFixed(2)} s × ${args.burst.count}`);

    // Replay from the start with everything scheduled, so the temporal filters see the clip as live.
    await page.evaluate(async ({ times, burstStart, burstCount }) => {
      const hook = window.__personaLiveRealism!;
      hook.pause();
      await hook.seek(0);
      hook.resetPerf();
      hook.scheduleCaptures(times);
      hook.scheduleBurst(burstStart, burstCount, 0.5);
      await hook.play();
    }, { times, burstStart, burstCount: args.burst.count });

    const deadline = Date.now() + (duration + 5) * 1000;
    while (Date.now() < deadline) {
      const pending = await page.evaluate(() => window.__personaLiveRealism!.pending());
      if (pending && pending.captures === 0 && pending.burst === 0) break;
      await sleep(250);
    }
    await sleep(300);
    const finalState = (await hookState(page))!;
    const pending = await page.evaluate(() => window.__personaLiveRealism!.pending());
    await page.evaluate(() => window.__personaLiveRealism!.pause());

    console.log('collecting captures…');
    const captures = (await page.evaluate(() => window.__personaLiveRealism!.takeCaptures())) as SerializedCapture[];
    const burst = (await page.evaluate(() => window.__personaLiveRealism!.takeBurst())) as SerializedBurst | null;

    // --- Per-frame metrics and files -----------------------------------------------------------
    const frames: FrameReport[] = [];
    const sheetRows: Array<{ label: string; tiles: Array<{ label: string; image: M.RgbaImage }> }> = [];
    for (const c of captures) {
      const tag = `t${c.t.toFixed(2).replace('.', '_')}`;
      const files = {
        output: path.join(clipDir, `${tag}-output.png`),
        driver: path.join(clipDir, `${tag}-driver.png`),
        overlay: c.overlayPng ? path.join(clipDir, `${tag}-overlay.png`) : null,
      };
      writeDataUrlPng(files.output, c.outputPng);
      writeDataUrlPng(files.driver, c.driverPng);
      if (files.overlay && c.overlayPng) writeDataUrlPng(files.overlay, c.overlayPng);

      fs.writeFileSync(
        path.join(clipDir, `${tag}-landmarks.json`),
        JSON.stringify({ t: c.t, driver: c.landmarks, warp: c.warpPositions, output: c.outputLandmarks })
      );
      const output = decodePngDataUrl(c.outputPng);
      const driver = decodePngDataUrl(c.driverPng);
      const overlay = c.overlayPng ? decodePngDataUrl(c.overlayPng) : null;
      const lms = c.landmarks;
      frames.push({
        t: c.t,
        frameIndex: c.frameIndex,
        mar: c.mar,
        pose: c.pose,
        keyframeId: c.keyframeId,
        syntheticTeeth: c.syntheticTeeth,
        outputFaceDetected: !!c.outputLandmarks,
        skinTone: M.skinToneMatch(output, driver, lms),
        sharpness: M.sharpnessMatch(output, lms),
        driverSharpness: M.sharpnessMatch(driver, lms),
        seam: M.seamScore(output, lms),
        mouth: M.mouthFidelity(c.outputLandmarks, lms),
        foreheadToneStep: M.foreheadToneStep(output, driver, lms),
        files: {
          output: path.relative(ROOT, files.output),
          driver: path.relative(ROOT, files.driver),
          overlay: files.overlay ? path.relative(ROOT, files.overlay) : null,
        },
      });

      // Contact sheet row: 2x face crops of driver, output and persona layer.
      const regions = M.faceRegions(lms, output.width, output.height);
      const box = M.expandRect(regions.ovalBox, 1.5, 1.45);
      const tiles = [
        { label: 'driver', image: scaleImage(crop(driver, box), 2) },
        { label: 'output', image: scaleImage(crop(output, box), 2) },
      ];
      if (overlay) tiles.push({ label: 'persona layer', image: scaleImage(compositeOnChecker(crop(overlay, box)), 2) });
      sheetRows.push({ label: `${c.t.toFixed(2)}s`, tiles });
    }
    if (sheetRows.length) {
      const sheet = contactSheet(`${clipLabel}  ${runName}  flags: ${flagString}`, sheetRows);
      writePng(path.join(clipDir, 'contact.png'), sheet);
    }

    // --- Burst metrics -------------------------------------------------------------------------
    let flicker: M.Flicker | null = null;
    let textureSlide: M.TextureSlide | null = null;
    let burstInfo: { start: number; frames: number; scale: number } | null = null;
    if (burst && burst.frames.length >= 2) {
      const bf: M.BurstFrame[] = burst.frames.map((f) => ({
        output: decodePngDataUrl(f.outputPng),
        driver: decodePngDataUrl(f.driverPng),
        landmarks: f.landmarks,
      }));
      flicker = M.flicker(bf);
      textureSlide = M.textureSlide(bf, { search: 6 });
      burstInfo = { start: burst.start, frames: burst.frames.length, scale: burst.scale };
    }

    // --- Summary ---------------------------------------------------------------------------------
    const summary = {
      frames: frames.length,
      skinToneCheekVsNeck: M.meanOf(frames.map((f) => f.skinTone?.cheekVsNeck ?? NaN)),
      skinToneCheekVsEars: M.meanOf(frames.map((f) => f.skinTone?.cheekVsEars ?? NaN)),
      driverCheekVsNeck: M.meanOf(frames.map((f) => f.skinTone?.driverCheekVsNeck ?? NaN)),
      sharpnessRatio: M.meanOf(frames.map((f) => f.sharpness.ratio)),
      driverSharpnessRatio: M.meanOf(frames.map((f) => f.driverSharpness.ratio)),
      seamRatio: M.meanOf(frames.map((f) => f.seam.ratio)),
      mouthLipErrorPct: M.meanOf(frames.map((f) => f.mouth?.lipErrorPct ?? NaN)),
      outputFacesDetected: frames.filter((f) => f.outputFaceDetected).length,
      syntheticTeethCapturedFrames: frames.filter((f) => f.syntheticTeeth).length,
      syntheticTeethFramesWholeClip: finalState.syntheticTeethFrames,
      framesRenderedWholeClip: finalState.framesRendered,
      foreheadToneStepDelta: M.meanOf(frames.map((f) => f.foreheadToneStep?.delta ?? NaN)),
      flicker,
      textureSlide,
      hairlineAlignment: null as null,
      hairlineAlignmentNote: 'needs the R4 hair mask; personaTopEdge() is ready for it',
      performance: {
        ...finalState.profile,
        window: 'last 300 frames of the replay',
        software: args.software,
      },
    };

    const clipReport = roundDeep({
      file: path.relative(ROOT, clipFile),
      duration,
      capturedAt: new Date().toISOString(),
      flags: flagString,
      flagValues,
      times,
      burst: burstInfo,
      incomplete: pending && (pending.captures > 0 || pending.burst > 0) ? pending : null,
      pageErrors,
      summary,
      frames,
    });

    const reportFile = path.join(outDir, 'report.json');
    const existing = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};
    const report = {
      schema: 1,
      run: runName,
      commit: gitCommit(),
      app: { url, browser: args.browser, canvas: [finalState.canvasWidth, finalState.canvasHeight], persona: args.persona ?? 'default' },
      updatedAt: new Date().toISOString(),
      clips: { ...(existing.clips ?? {}), [clipLabel]: clipReport },
    };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');

    console.log(`\n${clipLabel}: ${frames.length} frames → ${path.relative(ROOT, clipDir)}`);
    console.table(
      Object.fromEntries(
        Object.entries(summary)
          .filter(([, v]) => typeof v === 'number' || v === null)
          .map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v])
      )
    );
    if (flicker) console.log('flicker', roundDeep(flicker));
    if (textureSlide) console.log('textureSlide', roundDeep(textureSlide));
    console.log('performance', roundDeep({ fps: finalState.profile.fps, p50: finalState.profile.frameP50Ms, p95: finalState.profile.frameP95Ms, stages: finalState.profile.stages }));
    if (pageErrors.length) console.warn('page errors:', pageErrors);
    console.log(`report: ${path.relative(ROOT, reportFile)}`);
  } finally {
    await browser?.close().catch(() => undefined);
    server?.child.kill();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Realism capture tool (docs/REALISM_PLAN.md, "Capture script").
 *
 *   npm run realism:capture -- --clip A [--flags oralCavity=0,catchlights=0] [--run baseline]
 *   npm run realism:capture -- --clip all --personas all --run baseline        # persona grid
 *
 * Renders driver clips through the built app headlessly (Playwright + Chrome), captures PNG
 * frames at fixed timestamps, re-detects landmarks on the output, computes the review metrics,
 * writes contact sheets with 2x face crops and merges the numbers into
 * realism-review/out/<run>/report.json. Frames never leave realism-review/out (gitignored).
 *
 * Without --personas the app's default persona is used and every clip gets a full frame dump
 * (report.clips). With --personas every clip is run for every persona of the test set
 * (realism-review/personas/manifest.json, see personas-select.ts); per persona × clip only the
 * contact sheet is written (add --frames for the PNGs), and report.grid holds the per-persona
 * metrics, the median and the worst personas per metric, plus grid.png (rows = personas,
 * columns = clips).
 *
 * Options
 *   --clip <A..E | path | list | all>   clip label(s) (realism-review/clips/<label>.{webm,mp4,mov,mkv}), a file path, or "all" (A–E)
 *   --personas <all | ids | dir>        persona test set: all manifest entries, a comma list of ids, or a folder of images
 *   --category <men|women>              category for personas given as a folder without a manifest (default men)
 *   --frames                            write the frame PNGs in grid mode too
 *   --regions                           also write t<sec>-regions.png: the metric patches drawn on driver and output
 *   --flags <string>          realism flag overrides, e.g. "oralCavity=0,syntheticSuite=off" or the preset "r0"
 *   --settings <string>       transformation settings overrides, e.g. "temporalSmoothing=20,blendStrength=100"
 *   --run <name>              output folder name (default: <date>-<flags>)
 *   --times <s,s,...>         capture timestamps in seconds (default: 8 evenly spaced; 4 in grid mode)
 *   --burst <start:count>     consecutive-frame burst for flicker/texture slide (default: 45% of clip, 16 frames)
 *   --persona <name>          click a built-in persona card by (partial) name before capturing
 *   --url <http://...>        use an already running app instead of starting `vite preview`
 *   --personaPhoto <file>     the default persona's photo for the identity guard (default: first entry of references/personas.json)
 *   --no-identity             skip the identity guard (OpenCV Zoo YuNet + SFace via realism-review/.venv)
 *   --browser <chrome|chromium|msedge>   browser channel (default chrome: it has H.264)
 *   --software                force SwiftShader instead of the GPU
 *   --headed                  show the browser window
 */
import { ChildProcess, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Browser, Page } from 'playwright';
import { defaultRealismFlags, describeRealismFlags, parseRealismFlagString } from '../../src/realism/flags.ts';
import { parseSettingsString } from '../../src/realism/settings.ts';
import type { RealismDebugState, SerializedBurst, SerializedCapture } from '../../src/realism/debug.ts';
import * as M from './metrics.ts';
import { SheetRow, blank, blit, compositeOnChecker, contactSheet, crop, decodeImageFile, decodePngDataUrl, drawText, imageDataUrl, scaleImage, writeDataUrlPng, writePng } from './png.ts';
import { REVIEW_DIR, ROOT, driveAppShell, hookState, launchBrowser, sleep, startPreview, waitForHookState } from './session.ts';
import { regionsSheet } from './regions.ts';
import { PersonaEntry, loadPersonaSet } from './personaSet.ts';
import { IdentityFrame, IdentitySummary, flipHorizontal, identityAvailable, runIdentity, summarizeIdentity } from './identity.ts';

const CLIP_EXTENSIONS = ['.webm', '.mp4', '.mov', '.mkv', '.y4m'];
const CLIP_LABELS = ['A', 'B', 'C', 'D', 'E'];

interface Args {
  identity: boolean;
  personaPhoto: string | null;
  clips: string[];
  personas: string | null;
  category: 'men' | 'women';
  frames: boolean;
  regions: boolean;
  flags: string;
  settings: string;
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
    clips: [],
    personas: null,
    category: 'men',
    frames: false,
    regions: false,
    flags: '',
    settings: '',
    run: null,
    times: null,
    burst: { start: null, count: 16 },
    persona: null,
    url: null,
    browser: 'chrome',
    software: false,
    headed: false,
    identity: true,
    personaPhoto: null,
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
        args.clips.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--personas':
        args.personas = next();
        break;
      case '--category': {
        const c = next();
        if (c !== 'men' && c !== 'women') throw new Error('--category must be men or women');
        args.category = c;
        break;
      }
      case '--frames':
        args.frames = true;
        break;
      case '--regions':
        args.regions = true;
        break;
      case '--flags':
        args.flags = next();
        break;
      case '--settings':
        args.settings = next();
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
      case '--personaPhoto':
        args.personaPhoto = path.resolve(next());
        break;
      case '--no-identity':
        args.identity = false;
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
  if (!args.clips.length) throw new Error('--clip is required (A..E, all, or a path)');
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

function resolveClips(inputs: string[]): Array<{ label: string; file: string }> {
  const names = inputs.flatMap((c) => (c === 'all' ? CLIP_LABELS : [c]));
  const clips = names.map(resolveClip);
  const seen = new Set<string>();
  return clips.filter((c) => !seen.has(c.label) && seen.add(c.label));
}

// --- Per-frame report -------------------------------------------------------------------------------

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
  /** The same boundary/inside ratio on the driver frame: the wearer's own face edge. */
  driverSeam: M.SeamScore;
  /** Interior-skin sharpness (R3 acceptance metric): eyes, brows and mouth cut out of the face mask. */
  sharpnessInterior: M.SharpnessMatch;
  driverSharpnessInterior: M.SharpnessMatch;
  /** ΔE step across the jaw-and-cheek boundary bands (R3), on the output and on the driver. */
  seamStep: { deltaE: number; worst: number } | null;
  driverSeamStep: { deltaE: number; worst: number } | null;
  shading: M.ShadingSample | null;
  mouth: M.MouthFidelity | null;
  foreheadToneStep: M.ForeheadToneStep | null;
  /** Identity guard (R3b): cosine similarity of the output face to the persona photo and to the wearer. */
  identity: IdentityFrame | null;
  files: { output: string; driver: string; overlay: string | null } | null;
}

export interface ClipSummary {
  frames: number;
  skinToneCheekVsNeck: number | null;
  skinToneCheekVsEars: number | null;
  driverCheekVsNeck: number | null;
  driverCheekVsEars: number | null;
  sharpnessRatio: number | null;
  driverSharpnessRatio: number | null;
  /** Relative targets: driver value, output value, gap and pass per the plan's acceptance rules. */
  targets: M.RelativeTargets;
  seamRatio: number | null;
  driverSeamRatio: number | null;
  sharpnessInteriorRatio: number | null;
  driverSharpnessInteriorRatio: number | null;
  seamStepOutput: number | null;
  seamStepDriver: number | null;
  /** Cheek-lightness tracking over the captured frames (clip D: the lamp; clip B: the shadowed side). */
  shading: M.ShadingFollow | null;
  mouthLipErrorPct: number | null;
  outputFacesDetected: number;
  syntheticTeethCapturedFrames: number;
  syntheticTeethFramesWholeClip: number;
  framesRenderedWholeClip: number;
  foreheadToneStepOutput: number | null;
  foreheadToneStepDriver: number | null;
  foreheadToneStepDelta: number | null;
  flicker: M.Flicker | null;
  textureSlide: M.TextureSlide | null;
  /** Slide metric on the raw driver video: the floor set by landmark jitter and head motion. */
  driverTextureSlide: M.TextureSlide | null;
  hairlineAlignment: null;
  hairlineAlignmentNote: string;
  performance: RealismDebugState['profile'] & { window: string; software: boolean };
  renderer: RealismDebugState['renderer'];
  cameraMatch: RealismDebugState['cameraMatch'];
  /** The camera-match blur bias after every loop update over the whole clip (R3 item 3). */
  cameraMatchTrace: (M.TraceStats & { series: number[] }) | null;
  /** Learned resting mouth aperture at the end of the clip (flag restMouth). */
  restMar: number | null;
  /** Identity guard (R3b): means over the captured frames; null when the recogniser was not run. */
  identity: IdentitySummary | null;
  /** Times the 5-zone CPU lighting gain ran over the persona's life (R3b item 4; 0 with default flags). */
  cpuLightingGainUpdates: number | null;
  /** Max/min of the persona de-light field (flag personaDelight). */
  personaDelightRange: number | null;
  /** R3c auto-radius loop: the radius it settled at (end of clip), its smoothed excesses and the per-clip trace. */
  autoRadius: { radius: number; sideExcess: number | null; neckExcess: number | null; updates: number; trace: (M.TraceStats & { series: number[] }) | null } | null;
  /** The relight radius in use at the end of the clip (loop or setting). */
  relightRadius: number | null;
  symmetricDelight: boolean;
}

interface ClipReport {
  file: string;
  duration: number;
  capturedAt: string;
  flags: string;
  flagValues: Record<string, boolean>;
  times: number[];
  burst: { start: number; frames: number; scale: number } | null;
  incomplete: { captures: number; burst: number } | null;
  pageErrors: string[];
  summary: ClipSummary;
  frames: FrameReport[];
  /** Face crop of the capture nearest the middle of the clip (grid tiles). */
  tile?: M.RgbaImage;
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

/** Entries of references/personas.json (empty when the folder is absent). */
function localPersonaManifest(): Array<{ id: string; name: string; category: string; file: string }> {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'references', 'personas.json'), 'utf8')) as { personas?: Array<{ id: string; name: string; category: string; file: string }> };
    return manifest.personas ?? [];
  } catch {
    return [];
  }
}

/** The default persona's photo: --personaPhoto, else the first entry of references/personas.json. */
function defaultPersonaPhoto(override: string | null): string | null {
  if (override) return override;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'references', 'personas.json'), 'utf8')) as { personas?: Array<{ file: string }> };
    const first = manifest.personas?.[0];
    return first ? path.join(ROOT, 'references', first.file) : null;
  } catch {
    return null;
  }
}

function gitCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

// --- One clip through the live pipeline -------------------------------------------------------------

async function loadClip(page: Page, clipFile: string): Promise<RealismDebugState> {
  const input = page.locator('input[data-realism-clip]');
  await input.waitFor({ state: 'attached', timeout: 10000 });
  await input.setInputFiles(clipFile);
  await waitForHookState(page, 'clip source', (s) => s?.source === 'file', 30000);
  await waitForHookState(page, 'persona ready', (s) => s?.personaStatus === 'ready', 120000);
  await waitForHookState(page, 'face tracked on the clip', (s) => !!s?.faceVisible, 60000);
  return (await waitForHookState(page, 'video duration', (s) => (s?.videoDuration ?? 0) > 0, 15000))!;
}

interface CaptureOptions {
  clipLabel: string;
  clipFile: string;
  clipDir: string;
  sheetTitle: string;
  flagString: string;
  flagValues: Record<string, boolean>;
  writeFrames: boolean;
  defaultFrames: number;
  pageErrors: string[];
  /** Persona photo for the identity guard; null skips it. */
  personaPhoto: string | null;
}

async function captureClip(page: Page, args: Args, o: CaptureOptions): Promise<ClipReport> {
  const ready = await loadClip(page, o.clipFile);
  const duration = ready.videoDuration!;
  const n = o.defaultFrames;
  const times = (args.times ?? Array.from({ length: n }, (_, i) => duration * (0.1 + (0.8 * i) / Math.max(1, n - 1)))).filter((t) => t < duration - 0.1);
  const burstStart = args.burst.start ?? duration * 0.45;
  console.log(`  ${o.clipLabel}: ${duration.toFixed(2)} s, capturing at ${times.map((t) => t.toFixed(2)).join(', ')} s; burst from ${burstStart.toFixed(2)} s × ${args.burst.count}`);

  // The camera-match trace on the hook spans the persona's whole life; this clip's part starts here.
  const startState = await hookState(page);
  const traceStart = startState?.cameraMatchTrace?.length ?? 0;
  const radiusTraceStart = startState?.autoRadiusTrace?.length ?? 0;

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

  const captures = (await page.evaluate(() => window.__personaLiveRealism!.takeCaptures())) as SerializedCapture[];
  const burst = (await page.evaluate(() => window.__personaLiveRealism!.takeBurst())) as SerializedBurst | null;
  fs.mkdirSync(o.clipDir, { recursive: true });

  // --- Per-frame metrics and files -----------------------------------------------------------
  const frames: FrameReport[] = [];
  const sheetRows: SheetRow[] = [];
  let tile: M.RgbaImage | undefined;
  let tileDistance = Infinity;
  const identityDir = path.join(o.clipDir, 'identity');
  const identityPairs: Array<{ output: string; driver: string }> = [];
  const identityOn = !!o.personaPhoto && identityAvailable();
  if (identityOn) fs.mkdirSync(identityDir, { recursive: true });
  for (const c of captures) {
    const tag = `t${c.t.toFixed(2).replace('.', '_')}`;
    let files: FrameReport['files'] = null;
    if (o.writeFrames) {
      const f = {
        output: path.join(o.clipDir, `${tag}-output.png`),
        driver: path.join(o.clipDir, `${tag}-driver.png`),
        overlay: c.overlayPng ? path.join(o.clipDir, `${tag}-overlay.png`) : null,
      };
      writeDataUrlPng(f.output, c.outputPng);
      writeDataUrlPng(f.driver, c.driverPng);
      if (f.overlay && c.overlayPng) writeDataUrlPng(f.overlay, c.overlayPng);
      fs.writeFileSync(
        path.join(o.clipDir, `${tag}-landmarks.json`),
        JSON.stringify({ t: c.t, driver: c.landmarks, warp: c.warpPositions, output: c.outputLandmarks })
      );
      files = { output: path.relative(ROOT, f.output), driver: path.relative(ROOT, f.driver), overlay: f.overlay ? path.relative(ROOT, f.overlay) : null };
    }
    const output = decodePngDataUrl(c.outputPng);
    const driver = decodePngDataUrl(c.driverPng);
    const overlay = c.overlayPng ? decodePngDataUrl(c.overlayPng) : null;
    const lms = c.landmarks;
    // A re-detection counts only when it landed on the wearer's face (R2; see detectionAgrees).
    const outputLms = M.detectionAgrees(c.outputLandmarks, lms) ? c.outputLandmarks : null;
    frames.push({
      t: c.t,
      frameIndex: c.frameIndex,
      mar: c.mar,
      pose: c.pose,
      keyframeId: c.keyframeId,
      syntheticTeeth: c.syntheticTeeth,
      outputFaceDetected: !!outputLms,
      skinTone: M.skinToneMatch(output, driver, lms),
      sharpness: M.sharpnessMatch(output, lms),
      driverSharpness: M.sharpnessMatch(driver, lms),
      seam: M.seamScore(output, lms),
      driverSeam: M.seamScore(driver, lms),
      sharpnessInterior: M.sharpnessMatchInterior(output, lms),
      driverSharpnessInterior: M.sharpnessMatchInterior(driver, lms),
      seamStep: stepOf(M.seamStep(output, lms)),
      driverSeamStep: stepOf(M.seamStep(driver, lms)),
      shading: M.shadingSample(output, driver, lms),
      mouth: M.mouthFidelity(outputLms, lms),
      foreheadToneStep: M.foreheadToneStep(output, driver, lms),
      identity: null,
      files,
    });

    // Identity guard crops (face oval × 2, un-mirrored so they match the persona photo's handedness).
    if (identityOn) {
      const idBox = M.clampRect(M.expandRect(M.faceRegions(lms, output.width, output.height).ovalBox, 2.0, 2.0), output.width, output.height);
      const oc = c.mirror ? flipHorizontal(crop(output, idBox)) : crop(output, idBox);
      const dc = c.mirror ? flipHorizontal(crop(driver, idBox)) : crop(driver, idBox);
      const pair = { output: path.join(identityDir, `${tag}-output.png`), driver: path.join(identityDir, `${tag}-driver.png`) };
      writePng(pair.output, oc);
      writePng(pair.driver, dc);
      identityPairs.push(pair);
    }

    if (args.regions) writePng(path.join(o.clipDir, `${tag}-regions.png`), regionsSheet(driver, output, lms));

    // Contact sheet row: 2x face crops of driver, output and persona layer.
    const regions = M.faceRegions(lms, output.width, output.height);
    const box = M.expandRect(regions.ovalBox, 1.5, 1.45);
    const outputCrop = crop(output, box);
    const tiles = [
      { label: 'driver', image: scaleImage(crop(driver, box), 2) },
      { label: 'output', image: scaleImage(outputCrop, 2) },
    ];
    if (overlay) tiles.push({ label: 'persona layer', image: scaleImage(compositeOnChecker(crop(overlay, box)), 2) });
    sheetRows.push({ label: `${c.t.toFixed(2)}s`, tiles });
    const d = Math.abs(c.t - duration / 2);
    if (d < tileDistance) {
      tileDistance = d;
      tile = outputCrop;
    }
  }
  if (sheetRows.length) writePng(path.join(o.clipDir, 'contact.png'), contactSheet(`${o.sheetTitle}  flags: ${o.flagString}`, sheetRows));

  // --- Identity guard (R3b) -------------------------------------------------------------------
  let identity: IdentitySummary | null = null;
  if (identityOn && o.personaPhoto) {
    const res = runIdentity(o.personaPhoto, identityPairs, identityDir);
    if (res) {
      res.forEach((r, i) => { if (frames[i]) frames[i].identity = r; });
      identity = summarizeIdentity(res);
    }
  }

  // --- Burst metrics -------------------------------------------------------------------------
  let flicker: M.Flicker | null = null;
  let textureSlide: M.TextureSlide | null = null;
  let driverTextureSlide: M.TextureSlide | null = null;
  let burstInfo: { start: number; frames: number; scale: number } | null = null;
  if (burst && burst.frames.length >= 2) {
    const bf: M.BurstFrame[] = burst.frames.map((f) => ({
      output: decodePngDataUrl(f.outputPng),
      driver: decodePngDataUrl(f.driverPng),
      landmarks: f.landmarks,
    }));
    flicker = M.flicker(bf);
    textureSlide = M.textureSlide(bf, { search: 6 });
    driverTextureSlide = M.driverTextureSlide(bf, { search: 6 });
    burstInfo = { start: burst.start, frames: burst.frames.length, scale: burst.scale };
  }

  // --- Summary ---------------------------------------------------------------------------------
  const base = {
    skinToneCheekVsNeck: M.meanOf(frames.map((f) => f.skinTone?.cheekVsNeck ?? NaN)),
    skinToneCheekVsEars: M.meanOf(frames.map((f) => f.skinTone?.cheekVsEars ?? NaN)),
    driverCheekVsNeck: M.meanOf(frames.map((f) => f.skinTone?.driverCheekVsNeck ?? NaN)),
    driverCheekVsEars: M.meanOf(frames.map((f) => f.skinTone?.driverCheekVsEars ?? NaN)),
    sharpnessRatio: M.meanOf(frames.map((f) => f.sharpness.ratio)),
    driverSharpnessRatio: M.meanOf(frames.map((f) => f.driverSharpness.ratio)),
    seamRatio: M.meanOf(frames.map((f) => f.seam.ratio)),
    driverSeamRatio: M.meanOf(frames.map((f) => f.driverSeam.ratio)),
    textureSlidePx: textureSlide?.residualPx ?? null,
    driverTextureSlidePx: driverTextureSlide?.residualPx ?? null,
    sharpnessInteriorRatio: M.meanOf(frames.map((f) => f.sharpnessInterior.ratio)),
    driverSharpnessInteriorRatio: M.meanOf(frames.map((f) => f.driverSharpnessInterior.ratio)),
    seamStepOutput: M.meanOf(frames.map((f) => f.seamStep?.deltaE ?? NaN)),
    seamStepDriver: M.meanOf(frames.map((f) => f.driverSeamStep?.deltaE ?? NaN)),
  };
  const whole = finalState.cameraMatchTrace ?? [];
  const trace = whole.length >= traceStart ? whole.slice(traceStart) : whole;
  const traceStats = M.traceStats(trace);
  const summary: ClipSummary = {
    frames: frames.length,
    skinToneCheekVsNeck: base.skinToneCheekVsNeck,
    skinToneCheekVsEars: base.skinToneCheekVsEars,
    driverCheekVsNeck: base.driverCheekVsNeck,
    driverCheekVsEars: base.driverCheekVsEars,
    sharpnessRatio: base.sharpnessRatio,
    driverSharpnessRatio: base.driverSharpnessRatio,
    targets: M.relativeTargets(base),
    seamRatio: base.seamRatio,
    driverSeamRatio: base.driverSeamRatio,
    sharpnessInteriorRatio: base.sharpnessInteriorRatio,
    driverSharpnessInteriorRatio: base.driverSharpnessInteriorRatio,
    seamStepOutput: base.seamStepOutput,
    seamStepDriver: base.seamStepDriver,
    shading: M.shadingFollow(frames.map((f) => f.shading).filter((s): s is M.ShadingSample => !!s)),
    mouthLipErrorPct: M.meanOf(frames.map((f) => f.mouth?.lipErrorPct ?? NaN)),
    outputFacesDetected: frames.filter((f) => f.outputFaceDetected).length,
    syntheticTeethCapturedFrames: frames.filter((f) => f.syntheticTeeth).length,
    syntheticTeethFramesWholeClip: finalState.syntheticTeethFrames,
    framesRenderedWholeClip: finalState.framesRendered,
    foreheadToneStepOutput: M.meanOf(frames.map((f) => f.foreheadToneStep?.output ?? NaN)),
    foreheadToneStepDriver: M.meanOf(frames.map((f) => f.foreheadToneStep?.driver ?? NaN)),
    foreheadToneStepDelta: M.meanOf(frames.map((f) => f.foreheadToneStep?.delta ?? NaN)),
    flicker,
    textureSlide,
    driverTextureSlide,
    hairlineAlignment: null,
    hairlineAlignmentNote: 'needs the R4 hair mask; personaTopEdge() is ready for it',
    performance: { ...finalState.profile, window: 'last 300 frames of the replay', software: args.software },
    renderer: finalState.renderer,
    cameraMatch: finalState.cameraMatch,
    cameraMatchTrace: traceStats ? { ...traceStats, series: trace } : null,
    restMar: finalState.restMar ?? null,
    identity,
    cpuLightingGainUpdates: finalState.lightingGainUpdates ?? null,
    personaDelightRange: finalState.personaDelightRange ?? null,
    autoRadius: finalState.autoRadius
      ? (() => {
          const wholeR = finalState.autoRadiusTrace ?? [];
          const rt = wholeR.length >= radiusTraceStart ? wholeR.slice(radiusTraceStart) : wholeR;
          const st = M.traceStats(rt);
          return { ...finalState.autoRadius, trace: st ? { ...st, series: rt } : null };
        })()
      : null,
    relightRadius: finalState.relightRadius ?? null,
    symmetricDelight: !!finalState.symmetricDelight,
  };

  return {
    file: path.relative(ROOT, o.clipFile),
    duration,
    capturedAt: new Date().toISOString(),
    flags: o.flagString,
    flagValues: o.flagValues,
    times,
    burst: burstInfo,
    incomplete: pending && (pending.captures > 0 || pending.burst > 0) ? pending : null,
    pageErrors: o.pageErrors.splice(0),
    summary,
    frames,
    tile,
  };
}

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(2);
}

function stepOf(s: M.SeamStep | null): { deltaE: number; worst: number } | null {
  return s ? { deltaE: s.deltaE, worst: s.worst } : null;
}

function printSummary(label: string, s: ClipSummary) {
  if (s.identity) {
    console.log(
      `    identity (SFace):  output↔persona ${fmt(s.identity.toPersona)}  output↔wearer ${fmt(s.identity.toDriver)}  margin ${fmt(s.identity.margin)} (min ${fmt(s.identity.minMargin)})  wearer↔persona ${fmt(s.identity.driverToPersona)}  faces ${s.identity.detected}/${s.identity.frames}`
    );
  }
  if (s.cpuLightingGainUpdates !== null) console.log(`    cpu lighting gain: ${s.cpuLightingGainUpdates} updates${s.personaDelightRange !== null ? `  de-light field range ${fmt(s.personaDelightRange)}` : ''}`);
  if (s.autoRadius) console.log(`    auto radius:       ${(s.autoRadius.radius * 100).toFixed(1)}%  side excess ${fmt(s.autoRadius.sideExcess)} L  neck excess ${fmt(s.autoRadius.neckExcess)} ΔE  updates ${s.autoRadius.updates}${s.autoRadius.trace ? `  trace ${(s.autoRadius.trace.min * 100).toFixed(1)}..${(s.autoRadius.trace.max * 100).toFixed(1)}%` : ''}${s.symmetricDelight ? '  symmetric de-light on' : ''}`);
  const t = s.targets;
  const check = (c: M.RelativeCheck) => `driver ${fmt(c.driver)} output ${fmt(c.output)} gap ${fmt(c.gap)} ${c.pass === null ? '' : c.pass ? 'PASS' : 'FAIL'}`;
  console.log(`  ${label}: ${s.frames} frames`);
  console.log(`    skin tone vs neck: ${check(t.skinToneNeck)} (±${t.skinToneNeck.tolerance} ΔE)`);
  console.log(`    skin tone vs ears: ${check(t.skinToneEars)} (±${t.skinToneEars.tolerance} ΔE)`);
  if (t.sharpnessInterior) console.log(`    sharpness (skin):  ${check(t.sharpnessInterior)} (±${Math.round(t.sharpnessInterior.tolerance * 100)}%, acceptance)`);
  console.log(`    sharpness ratio:   ${check(t.sharpness)} (±${Math.round(t.sharpness.tolerance * 100)}%, face/ring diagnostic)`);
  console.log(`    texture slide:     ${check(t.slide)} (gap ≤ ${t.slide.tolerance} px/frame)`);
  if (t.seamStep) console.log(`    seam step (ΔE):    ${check(t.seamStep)} (gap ≤ ${t.seamStep.tolerance} ΔE)`);
  console.log(`    seam ratio:        ${check(t.seam)}`);
  if (s.shading) console.log(`    shading:           slope ${fmt(s.shading.slope)} r ${fmt(s.shading.correlation)} side gap ${fmt(s.shading.sideGap)} L`);
  if (s.cameraMatchTrace) console.log(`    blur bias trace:   ${s.cameraMatchTrace.updates} updates, ${fmt(s.cameraMatchTrace.min)}..${fmt(s.cameraMatchTrace.max)}, std ${fmt(s.cameraMatchTrace.std)}, mean step ${fmt(s.cameraMatchTrace.meanStep)}`);
  console.log(
    `    seam ${fmt(s.seamRatio)}  lip err ${fmt(s.mouthLipErrorPct)}%  teeth ${s.syntheticTeethFramesWholeClip}/${s.framesRenderedWholeClip}  ` +
      `forehead step out ${fmt(s.foreheadToneStepOutput)} drv ${fmt(s.foreheadToneStepDriver)} Δ ${fmt(s.foreheadToneStepDelta)}  ` +
      `flicker Δ ${fmt(s.flicker?.delta)}  slide ${fmt(s.textureSlide?.residualPx)}  fps ${s.performance.fps.toFixed(1)} p95 ${s.performance.frameP95Ms.toFixed(1)} ms`
  );
}

// --- Persona grid aggregation -------------------------------------------------------------------------

/** Metrics compared across personas; every one is "higher is worse" after taking the gap's magnitude. */
export const GRID_METRICS: Array<{ key: string; label: string; pick: (s: ClipSummary) => number | null }> = [
  { key: 'identityToDriver', label: 'identity: output ↔ wearer cosine (higher = fading into the wearer)', pick: (s) => s.identity?.toDriver ?? null },
  { key: 'autoRadiusPct', label: 'auto relight radius at the end of the clip (% face width)', pick: (s) => (s.autoRadius ? s.autoRadius.radius * 100 : null) },
  { key: 'identityMarginDeficit', label: 'identity margin deficit (−(persona − wearer) cosine)', pick: (s) => (s.identity?.margin === null || s.identity?.margin === undefined ? null : -s.identity.margin) },
  { key: 'skinToneNeckGapAbs', label: '|skin tone gap vs neck| (ΔE)', pick: (s) => abs(s.targets.skinToneNeck.gap) },
  { key: 'skinToneEarsGapAbs', label: '|skin tone gap vs ears| (ΔE)', pick: (s) => abs(s.targets.skinToneEars.gap) },
  { key: 'sharpnessInteriorGapAbs', label: '|sharpness gap, interior skin| (fraction)', pick: (s) => abs(s.targets.sharpnessInterior?.gap ?? null) },
  { key: 'sharpnessGapAbs', label: '|sharpness gap, face/ring| (fraction)', pick: (s) => abs(s.targets.sharpness.gap) },
  { key: 'seamStepOut', label: 'seam step output (ΔE)', pick: (s) => s.targets.seamStep?.output ?? null },
  { key: 'seamStepGap', label: 'seam step gap (output − driver, ΔE)', pick: (s) => s.targets.seamStep?.gap ?? null },
  { key: 'sideShadingGap', label: 'side shading gap (L)', pick: (s) => s.shading?.sideGap ?? null },
  { key: 'seamRatio', label: 'seam ratio', pick: (s) => s.seamRatio },
  { key: 'seamGap', label: 'seam gap (output − driver)', pick: (s) => s.targets.seam?.gap ?? null },
  { key: 'mouthLipErrorPct', label: 'lip error (% face width)', pick: (s) => s.mouthLipErrorPct },
  { key: 'syntheticTeethShare', label: 'frames with synthetic teeth (share)', pick: (s) => (s.framesRenderedWholeClip ? s.syntheticTeethFramesWholeClip / s.framesRenderedWholeClip : null) },
  { key: 'foreheadToneStepDelta', label: 'forehead tone step Δ (ΔE)', pick: (s) => s.foreheadToneStepDelta },
  { key: 'flickerDelta', label: 'flicker Δ', pick: (s) => s.flicker?.delta ?? null },
  { key: 'textureSlidePx', label: 'texture slide (px/frame)', pick: (s) => s.textureSlide?.residualPx ?? null },
  { key: 'slideGapPx', label: 'texture slide gap (output − driver, px/frame)', pick: (s) => s.targets.slide?.gap ?? null },
];

function abs(v: number | null): number | null {
  return v === null ? null : Math.abs(v);
}

export interface GridAggregate {
  personas: number;
  metrics: Record<string, { label: string; median: number | null; worst10pct: number | null; worst3: Array<{ persona: string; value: number }> }>;
}

/** Per-persona value = mean over its clips; then median, worst-10% and the worst three personas. */
export function aggregateGrid(perPersona: Record<string, Record<string, ClipSummary>>): GridAggregate {
  const names = Object.keys(perPersona);
  const metrics: GridAggregate['metrics'] = {};
  for (const m of GRID_METRICS) {
    const entries: Array<M.Ranked<string>> = [];
    for (const name of names) {
      const v = M.meanOf(Object.values(perPersona[name]).map((s) => m.pick(s) ?? NaN));
      if (v !== null) entries.push({ key: name, value: v });
    }
    const values = entries.map((e) => e.value);
    metrics[m.key] = {
      label: m.label,
      median: M.medianOf(values),
      worst10pct: M.percentileOf(values, 0.9),
      worst3: M.worstOf(entries, 3).map((e) => ({ persona: e.key, value: e.value })),
    };
  }
  return { personas: names.length, metrics };
}

function gridSheet(title: string, personas: string[], clips: string[], tiles: Map<string, M.RgbaImage>, tileH = 220): M.RgbaImage {
  const pad = 6;
  const labelW = 150;
  const headerH = 22;
  const titleH = 28;
  const tileW = Math.round(tileH * 0.8);
  const width = labelW + clips.length * (tileW + pad) + pad;
  const height = titleH + headerH + personas.length * (tileH + pad) + pad;
  const sheet = blank(width, height);
  drawText(sheet, title, pad, 8, 2);
  clips.forEach((c, i) => drawText(sheet, c, labelW + i * (tileW + pad) + 4, titleH + 4, 2, [148, 163, 184]));
  personas.forEach((p, r) => {
    const y = titleH + headerH + r * (tileH + pad);
    drawText(sheet, p.slice(0, 11), pad, y + 8, 2, [251, 191, 36]);
    clips.forEach((c, i) => {
      const t = tiles.get(`${p}/${c}`);
      if (!t) return;
      const s = Math.min(tileW / t.width, tileH / t.height);
      blit(sheet, scaleImage(t, s), labelW + i * (tileW + pad), y);
    });
  });
  return sheet;
}

type GridPersona = {
  file: string;
  category: string;
  attributes: Record<string, unknown>;
  degradedOf: string | null;
  status: string;
  clips: Record<string, ClipSummary>;
};

// --- Main -----------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clips = resolveClips(args.clips);
  const personas: PersonaEntry[] | null = args.personas ? loadPersonaSet(args.personas, args.category) : null;
  const parsed = parseRealismFlagString(args.flags);
  if (parsed.errors.length) throw new Error(`Bad --flags: ${parsed.errors.join('; ')}`);
  const flagValues = { ...defaultRealismFlags(), ...parsed.flags };
  const flagString = describeRealismFlags(flagValues);
  const parsedSettings = parseSettingsString(args.settings);
  if (parsedSettings.errors.length) throw new Error(`Bad --settings: ${parsedSettings.errors.join('; ')}`);
  const runName = args.run ?? `${new Date().toISOString().slice(0, 10)}-${flagString === 'defaults' ? 'defaults' : flagString.replace(/[^a-z0-9]+/gi, '_')}`;
  const outDir = path.join(REVIEW_DIR, 'out', runName);
  fs.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, 'report.json');
  const existing: Record<string, unknown> = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};

  console.log(`clips ${clips.map((c) => c.label).join(', ')}; ${personas ? `${personas.length} personas; ` : ''}flags: ${flagString}; run: ${runName}`);

  let server: { url: string; child: ChildProcess } | null = null;
  let browser: Browser | null = null;
  try {
    const url = args.url ?? (server = await startPreview()).url;
    browser = await launchBrowser(args);
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
    await driveAppShell(page, url, flagString === 'defaults' ? '' : flagString, args.settings);
    if (args.persona) await page.getByText(args.persona, { exact: false }).first().click({ timeout: 10000 });
    const state = (await hookState(page))!;
    // Builds before the settings hook (R0) have no `settings` on the window hook.
    const liveSettings = await page.evaluate(() => window.__personaLiveRealism!.settings?.get() ?? null);
    const app: Record<string, unknown> & { persona: string } = { url, browser: args.browser, canvas: [state.canvasWidth, state.canvasHeight], persona: args.persona ?? 'default', settingsOverrides: parsedSettings.settings, settings: liveSettings };

    if (!personas) {
      // --- Default persona: full frame dump per clip ----------------------------------------------
      // The local persona's consent record may be pending (R3c item 6): the app's gate then never
      // auto-selects it, so the review loads it explicitly through the dev hook, flagged as pending.
      const localPhoto = args.persona ? null : defaultPersonaPhoto(args.personaPhoto);
      if (localPhoto) {
        const manifest = localPersonaManifest();
        const entry = manifest.find((p) => path.join(ROOT, 'references', p.file) === localPhoto) ?? manifest[0];
        await page.evaluate((spec) => window.__personaLiveRealism!.loadPersona(spec), {
          name: entry?.name ?? 'local persona',
          category: (entry?.category ?? 'men') as 'men' | 'women',
          dataUrl: imageDataUrl(localPhoto),
          id: 'persona-local-review',
          role: 'Local persona (realism review)',
          consent: 'pending' as const,
        });
        await waitForHookState(page, 'local persona ready', (s) => ['ready', 'no-face', 'error'].includes(s?.personaStatus ?? ''), 120000);
        app.persona = `local:${path.basename(localPhoto)}`;
      }
      const clipReports: Record<string, unknown> = { ...((existing.clips as Record<string, unknown>) ?? {}) };
      for (const clip of clips) {
        const report = await captureClip(page, args, {
          clipLabel: clip.label,
          clipFile: clip.file,
          clipDir: path.join(outDir, clip.label),
          sheetTitle: `${clip.label}  ${runName}`,
          flagString,
          flagValues,
          writeFrames: true,
          defaultFrames: 8,
          pageErrors,
          personaPhoto: args.identity ? defaultPersonaPhoto(args.personaPhoto) : null,
        });
        printSummary(clip.label, report.summary);
        const { tile: _tile, ...rest } = report;
        clipReports[clip.label] = roundDeep(rest);
        writeReport(reportFile, { ...existing, run: runName, app, clips: clipReports });
      }
    } else {
      // --- Persona grid -------------------------------------------------------------------------
      const previous = (existing.grid as { personas?: Record<string, GridPersona> } | undefined)?.personas ?? {};
      const grid: Record<string, GridPersona> = { ...previous };
      const perPersona: Record<string, Record<string, ClipSummary>> = {};
      for (const [name, g] of Object.entries(grid)) perPersona[name] = g.clips;
      const tiles = new Map<string, M.RgbaImage>();
      for (const persona of personas) {
        console.log(`persona ${persona.id} (${persona.category}${persona.degradedOf ? `, degraded copy of ${persona.degradedOf}` : ''})`);
        const dataUrl = imageDataUrl(persona.file);
        const before = await hookState(page);
        await page.evaluate((spec) => window.__personaLiveRealism!.loadPersona(spec), {
          name: persona.id,
          category: persona.category,
          dataUrl,
          id: `persona-test-${persona.id}`,
        });
        // Wait for the engine to leave the previous "ready" state, then become ready for this photo.
        if (before?.personaStatus === 'ready') await waitForHookState(page, 'persona reload', (s) => s?.personaStatus !== 'ready', 10000).catch(() => null);
        const st = await waitForHookState(page, 'persona ready', (s) => ['ready', 'no-face', 'error'].includes(s?.personaStatus ?? ''), 120000);
        const entry: GridPersona = {
          file: path.relative(ROOT, persona.file),
          category: persona.category,
          attributes: persona.attributes,
          degradedOf: persona.degradedOf,
          status: st?.personaStatus ?? 'unknown',
          clips: {},
        };
        grid[persona.id] = entry;
        if (st?.personaStatus !== 'ready') {
          console.warn(`  skipped: persona status ${st?.personaStatus}`);
          continue;
        }
        for (const clip of clips) {
          const clipDir = path.join(outDir, 'personas', persona.id, clip.label);
          const report = await captureClip(page, args, {
            clipLabel: clip.label,
            clipFile: clip.file,
            clipDir,
            sheetTitle: `${persona.id} / ${clip.label}  ${runName}`,
            flagString,
            flagValues,
            writeFrames: args.frames,
            defaultFrames: 4,
            pageErrors,
            personaPhoto: args.identity ? persona.file : null,
          });
          printSummary(`${persona.id}/${clip.label}`, report.summary);
          entry.clips[clip.label] = roundDeep(report.summary);
          if (report.tile) {
            tiles.set(`${persona.id}/${clip.label}`, report.tile);
            writePng(path.join(clipDir, 'tile.png'), report.tile);
          }
        }
        perPersona[persona.id] = entry.clips;
        writeReport(reportFile, { ...existing, run: runName, app, grid: { clipsRun: clips.map((c) => c.label), personas: grid, aggregate: roundDeep(aggregateGrid(perPersona)) } });
      }
      // Tiles of personas captured by earlier invocations of the same run are reused from disk.
      const names = Object.keys(grid);
      for (const name of names) {
        for (const clip of clips) {
          const key = `${name}/${clip.label}`;
          const file = path.join(outDir, 'personas', name, clip.label, 'tile.png');
          if (!tiles.has(key) && fs.existsSync(file)) tiles.set(key, decodeImageFile(file));
        }
      }
      writePng(path.join(outDir, 'grid.png'), gridSheet(`${runName}  flags: ${flagString}`, names, clips.map((c) => c.label), tiles));
      const aggregate = aggregateGrid(perPersona);
      console.log('\nper-metric median / worst 10% / worst 3 personas');
      for (const [key, m] of Object.entries(aggregate.metrics)) {
        console.log(`  ${m.label} [${key}]: median ${fmt(m.median)}  worst10% ${fmt(m.worst10pct)}  worst: ${m.worst3.map((w) => `${w.persona} ${fmt(w.value)}`).join(', ')}`);
      }
      console.log(`grid sheet: ${path.relative(ROOT, path.join(outDir, 'grid.png'))}`);
    }
    if (pageErrors.length) console.warn('page errors:', pageErrors);
    console.log(`report: ${path.relative(ROOT, reportFile)}`);
  } finally {
    await browser?.close().catch(() => undefined);
    server?.child.kill();
  }
}

function writeReport(file: string, body: Record<string, unknown>) {
  const report = { schema: 2, ...body, commit: gitCommit(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Drives the guided enrollment dialog (R5 §2, flag guidedEnrollment) end to end and exports the
 * shots as a review-only persona for `realism:capture --enrolled <dir>`.
 *
 *   npm run realism:enroll -- --url http://127.0.0.1:4391/ --video realism-review/enroll/camera.mjpeg [--out realism-review/enrolled/run1]
 *
 * The camera is Chrome's fake capture device playing --video in a loop (.mjpeg or .y4m), so the
 * dialog, its live checks and the save path can be tested without a person at the webcam. That
 * also means the attestation the script ticks is not a person's consent: the export is marked
 * review-only, carries no consent record, and a persona loaded from it runs with a pending record
 * that only a review build activates. Nothing is written outside realism-review/ (gitignored).
 *
 * With --live a person does the enrollment at the real webcam instead: the script opens a visible
 * Chrome, starts the camera and opens the dialog, then touches nothing. The person at the camera
 * reads the consent text, types their own name, ticks the attestation themselves and follows the
 * seven prompts; when they press "Sign and save", the script exports the shots (review-only, like
 * the automated export: the signed record stays in that browser session and is not written out).
 *
 *   npm run realism:enroll -- --live --url http://127.0.0.1:4392/ --out realism-review/enrolled/<name> --category men
 *
 * Options:
 *   --live                a person at the real webcam does the enrollment; --video is not used
 *   --video <file>        the recording behind the fake camera (required without --live)
 *   --out <dir>           export folder (default realism-review/enrolled/<date>)
 *   --name <text>         name typed into the dialog (default "Automated enrollment test")
 *   --category <men|women>   default men
 *   --step-timeout <s>    how long a step may wait for its checks before it is logged as refused (default 45)
 *   --start-pose <yaw,pitch>   start the capture when the head pose is within 2 degrees of this (a recording
 *                         with more than one straight-ahead segment); default: any straight, neutral face
 *   --url <url>           a running build (default: vite preview of dist/)
 *   --browser <chrome|chromium|msedge>, --headed
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Browser } from 'playwright';
import { REVIEW_DIR, driveAppShell, launchBrowser, sleep, startPreview, waitForHookState } from './session.ts';
import { EnrollmentRefusal, StepTally, buildEnrollmentExport, shotBytes, shotFileName } from './enrollExport.ts';
import type { EnrollmentDebugSnapshot } from '../../src/realism/debug.ts';
import { ENROLLMENT_STEPS } from '../../src/utils/enrollment.ts';

export type { EnrollmentExport } from './enrollExport.ts';

interface Args {
  video: string;
  out: string;
  name: string;
  category: 'men' | 'women';
  stepTimeoutMs: number;
  live: boolean;
  startPose: { yaw: number; pitch: number } | null;
  url: string | null;
  browser: string;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    video: '',
    out: path.join(REVIEW_DIR, 'enrolled', new Date().toISOString().slice(0, 10)),
    name: 'Automated enrollment test',
    category: 'men',
    stepTimeoutMs: 45000,
    live: false,
    startPose: null,
    url: null,
    browser: 'chrome',
    headed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === '--video') a.video = path.resolve(next());
    else if (k === '--out') a.out = path.resolve(next());
    else if (k === '--name') a.name = next();
    else if (k === '--category') {
      const c = next();
      if (c !== 'men' && c !== 'women') throw new Error('--category must be men or women');
      a.category = c;
    } else if (k === '--step-timeout') a.stepTimeoutMs = Number(next()) * 1000;
    else if (k === '--start-pose') {
      const [yaw, pitch] = next().split(',').map(Number);
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new Error('--start-pose takes yaw,pitch in degrees');
      a.startPose = { yaw, pitch };
    }
    else if (k === '--live') a.live = true;
    else if (k === '--url') a.url = next();
    else if (k === '--browser') a.browser = next();
    else if (k === '--headed') a.headed = true;
    else throw new Error(`Unknown option ${k}`);
  }
  if (a.live) {
    if (a.video) throw new Error('--live uses the real webcam; do not pass --video');
    a.headed = true;
    if (a.name === 'Automated enrollment test') a.name = 'Live enrollment';
    const rel = path.relative(REVIEW_DIR, a.out);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('--out must be inside realism-review/ (the photos are never committed)');
    return a;
  }
  if (!a.video) throw new Error('--video is required (.mjpeg or .y4m), or use --live');
  if (!fs.existsSync(a.video)) throw new Error(`${a.video} not found`);
  if (!/\.(mjpeg|y4m)$/i.test(a.video)) throw new Error("Chrome's fake camera reads .mjpeg or .y4m files only");
  const rel = path.relative(REVIEW_DIR, a.out);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('--out must be inside realism-review/ (the photos are never committed)');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const steps = ENROLLMENT_STEPS.map((s) => s.id);
  let server: { url: string; child: ChildProcess } | null = null;
  let browser: Browser | null = null;
  try {
    const url = args.url ?? (server = await startPreview()).url;
    browser = await launchBrowser({
      browser: args.browser,
      software: false,
      headed: args.headed,
      // Live: a maximised window that follows the screen size, so the dialog and its buttons are fully visible.
      extraArgs: args.live ? ['--start-maximized'] : ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${args.video}`],
    });
    const page = await (await browser.newContext(args.live ? { viewport: null } : { viewport: { width: 1400, height: 1000 } })).newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
    await driveAppShell(page, url, 'guidedEnrollment=1');
    const snapshot = () => page.evaluate(() => window.__personaLiveRealism!.enrollment()) as Promise<EnrollmentDebugSnapshot | null>;

    // Camera on, then the dialog.
    await page.getByRole('button', { name: /Turn On Webcam/i }).first().click({ timeout: 15000 });
    await waitForHookState(page, 'webcam source', (s) => s?.source === 'webcam', 30000);
    await waitForHookState(page, 'face tracked on the camera', (s) => !!s?.faceVisible, 90000);
    await page.getByRole('button', { name: /Upload Photo/i }).first().click({ timeout: 10000 });
    await page.getByTestId('open-guided-enrollment').click({ timeout: 10000 });

    const refusals: EnrollmentRefusal[] = [];
    const took: Array<{ stepId: string; waitedMs: number }> = [];
    let saved = false;
    let final: EnrollmentDebugSnapshot;
    if (args.live) {
      // The person at the camera does everything from here; the script only watches.
      console.log('The enrollment dialog is open in the Chrome window. The person whose face will be used should now:');
      console.log('  1. read the consent text, type their own name and tick "I am the person at this camera" themselves;');
      console.log('  2. press "I agree" and follow the seven prompts (each photo is taken automatically after a short still hold);');
      console.log('  3. choose Man/Woman and press "Sign and save this face".');
      console.log('Waiting up to 15 minutes. Closing the dialog or the window cancels; nothing is exported then.');
      const deadline = Date.now() + 15 * 60 * 1000;
      let last: EnrollmentDebugSnapshot | null = null;
      let seen = 0;
      while (Date.now() < deadline) {
        const s = await snapshot().catch(() => null);
        if (s) {
          last = s;
          if (s.shots.length !== seen) {
            seen = s.shots.length;
            console.log(`  ${seen} of ${steps.length} shots taken`);
          }
          if (s.phase === 'saved') break;
        }
        if (page.isClosed()) break;
        await sleep(500);
      }
      if (!last || last.phase !== 'saved') {
        // Say where it stopped, so a step that would not pass can be diagnosed.
        if (last) {
          const c = last.checks ? Object.entries(last.checks).map(([k, ok]) => `${k} ${ok ? 'ok' : 'NOT ok'}`).join(', ') : 'no camera frame';
          const v = last.live ? `yaw ${last.live.yaw.toFixed(1)}, pitch ${last.live.pitch.toFixed(1)}, mouth ${last.live.mar.toFixed(2)}, smile ${last.live.smile.toFixed(2)}, sharpness ${last.live.sharpness?.toFixed(1) ?? '-'}, luma ${last.live.meanLuma?.toFixed(0) ?? '-'}` : 'no live values';
          const f = last.shots.find((x) => x.stepId === 'frontal');
          const fp = f ? f.matrixPose ?? f.pose : null;
          console.log(`stopped in phase "${last.phase}"${last.stepId ? `, step "${last.stepId}"` : ''} with ${last.shots.length} of ${steps.length} shots (${page.isClosed() ? 'the window was closed' : Date.now() >= deadline ? 'timed out' : 'ended'})`);
          console.log(`  last checks: ${c}`);
          console.log(`  last hint: ${last.hint ?? 'none'}${last.error ? `; dialog error: ${last.error}` : ''}`);
          console.log(`  last live values: ${v}${fp ? `; frontal baseline yaw ${fp.yaw.toFixed(1)}, pitch ${fp.pitch.toFixed(1)}` : ''}`);
        }
        throw new Error('the enrollment was not signed and saved; nothing was exported');
      }
      final = last;
      saved = true;
    } else {
    // Consent: the start button must refuse without the name and the attestation.
    await page.getByTestId('enrollment-start').click();
    const refusedEmpty = (await page.getByTestId('enrollment-error').textContent({ timeout: 5000 })) ?? '';
    await page.getByTestId('enrollment-name').fill(args.name);
    await page.getByTestId('enrollment-start').click();
    const refusedUnattested = (await page.getByTestId('enrollment-error').textContent({ timeout: 5000 })) ?? '';
    if ((await snapshot())?.phase !== 'consent') throw new Error('the dialog left the consent step without the attestation');
    console.log(`consent gate: without a name "${refusedEmpty}"; without the attestation "${refusedUnattested}"`);
    await page.getByTestId('enrollment-attest').check();
    // Like a person, start while looking straight at the camera with a closed mouth (the recording loops through all poses).
    await waitForHookState(page, 'a straight, neutral face on the camera', (st) => {
      const m = st?.r5?.matrixPose;
      if (!st?.faceVisible || !m || st.mar >= 0.08 || st.isSmiling) return false;
      // A recording with several straight-ahead segments: start on the one meant as the frontal shot.
      if (args.startPose) return Math.abs(m.yaw - args.startPose.yaw) < 2 && Math.abs(m.pitch - args.startPose.pitch) < 2;
      return Math.abs(m.yaw) < 10 && Math.abs(m.pitch) < 6;
    }, 120000);
    await page.getByTestId('enrollment-start').click();
    await page.getByTestId('enrollment-capture').waitFor({ timeout: 5000 });

    // Capture: the dialog takes each shot itself once its checks hold. A step that never passes is
    // logged as refused and the next missing one is selected, as a person would by clicking its tile.
    const skipped = new Set<string>();
    let current: string | null = null;
    let since = Date.now();
    let tally = new StepTally();
    for (;;) {
      const s = await snapshot();
      if (!s) throw new Error('the enrollment dialog is not publishing its state (is this build older than the bridge?)');
      if (s.phase === 'review') break;
      if (s.stepId !== current) {
        if (current && s.shots.some((x) => x.stepId === current)) {
          took.push({ stepId: current, waitedMs: Date.now() - since });
          console.log(`  ${current}: taken after ${((Date.now() - since) / 1000).toFixed(1)} s`);
        }
        current = s.stepId;
        since = Date.now();
        tally = new StepTally();
      }
      tally.push(s.checks, s.hint, s.live);
      const timedOut = !!current && Date.now() - since > args.stepTimeoutMs;
      if (current && (timedOut || skipped.has(current))) {
        const refusal = tally.refusal(current, Date.now() - since);
        if (timedOut) refusals.push(refusal);
        skipped.add(current);
        if (timedOut) console.log(`  ${current}: NOT taken in ${(refusal.waitedMs / 1000).toFixed(0)} s; ${refusal.hints[0] ? `"${refusal.hints[0].hint}" on ${(refusal.hints[0].share * 100).toFixed(0)}% of frames` : 'no hint'}; max mouth aperture ${refusal.maxMar.toFixed(2)}, max smile ${refusal.maxSmile.toFixed(2)}`);
        const nextStep = ENROLLMENT_STEPS.find((st) => !skipped.has(st.id) && !s.shots.some((x) => x.stepId === st.id));
        if (!nextStep) break;
        await page.getByTestId('enrollment-capture').getByRole('button', { name: nextStep.label, exact: false }).first().click();
      }
      await sleep(100);
    }

    // Review and save (only reachable with all shots).
    final = (await snapshot())!;
    if (final.phase === 'review') {
      await page.getByTestId('enrollment-review').getByRole('button', { name: args.category === 'men' ? 'Man' : 'Woman', exact: true }).click();
      await page.getByTestId('enrollment-save').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 10000 && (final = (await snapshot())!).phase !== 'saved') await sleep(100);
      saved = final.phase === 'saved';
      if (!saved) console.warn(`  save did not complete: ${final.error ?? 'no error shown'}`);
    } else {
      const saveVisible = await page.getByTestId('enrollment-save').isVisible().catch(() => false);
      console.log(`  the set is incomplete (${final.shots.length} of ${steps.length}); the save button is ${saveVisible ? 'VISIBLE (unexpected)' : 'not offered'}`);
      if (saveVisible) throw new Error('the dialog offers saving an incomplete reference set');
    }
    }

    if (!final.shots.some((x) => x.stepId === 'frontal')) throw new Error('no frontal shot was taken; nothing to export');
    const exported = buildEnrollmentExport({
      steps,
      shots: final.shots,
      refusals,
      saved,
      name: args.name,
      category: args.category,
      camera: args.live ? 'live' : 'fake-device',
      cameraFile: args.live ? null : path.basename(args.video),
      createdAt: new Date().toISOString(),
    });
    fs.mkdirSync(args.out, { recursive: true });
    for (const shot of final.shots) fs.writeFileSync(path.join(args.out, shotFileName(shot.stepId, shot.dataUrl)), shotBytes(shot.dataUrl));
    fs.writeFileSync(path.join(args.out, 'enrollment.json'), JSON.stringify({ ...exported, took, pageErrors }, null, 2));
    console.log(`${exported.complete ? 'complete' : 'INCOMPLETE'} enrollment: ${exported.shots.length} of ${steps.length} shots, saved by the dialog: ${saved}; exported review-only to ${path.relative(process.cwd(), args.out)}`);
    for (const s of exported.shots) {
      const p = s.matrixPose ?? s.pose;
      console.log(`  ${s.stepId.padEnd(11)} yaw ${p.yaw.toFixed(1).padStart(6)}  pitch ${p.pitch.toFixed(1).padStart(6)}  mouth ${s.expression.mar.toFixed(2)}  smile ${s.expression.smile.toFixed(2)}  sharpness ${s.quality.sharpness.toFixed(1)}  luma ${s.quality.meanLuma.toFixed(0)}  clipped ${(s.quality.clippedShare * 100).toFixed(1)}%`);
    }
    if (pageErrors.length) console.warn(`page errors: ${pageErrors.join(' | ')}`);
  } finally {
    await browser?.close().catch(() => undefined);
    server?.child.kill();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

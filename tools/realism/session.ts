/**
 * Shared Playwright session helpers for the realism tools: start `vite preview` on the production
 * build, launch a GPU-enabled Chrome, sign into the demo and wait on `window.__personaLiveRealism`.
 */
import { spawn, ChildProcess, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, Browser, Page } from 'playwright';
import type { RealismDebugState } from '../../src/realism/debug.ts';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
export const REVIEW_DIR = path.join(ROOT, 'realism-review');

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SystemLoad {
  processes: number | null;
  chromeProcesses: number | null;
  cpuPercent: number | null;
  /** GPU utilisation in percent: nvidia-smi when present, else the Windows GPU engine counters. */
  gpuPercent: number | null;
  gpuSource: string;
  at: string;
}

function run(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }).toString();
  } catch {
    return null;
  }
}

/** Process count, CPU and GPU load at this moment (Windows; nulls where a probe is unavailable). Report headers carry it (R4 item 3). */
export function systemLoad(): SystemLoad {
  const tasks = run('tasklist /FO CSV /NH');
  const lines = tasks ? tasks.split(/\r?\n/).filter((l) => l.trim()) : [];
  const processes = tasks ? lines.length : null;
  const chromeProcesses = tasks ? lines.filter((l) => /^"chrome\.exe"/i.test(l)).length : null;
  // CPU: wmic is gone on recent Windows builds; CIM works everywhere.
  const cpuRaw = run('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"');
  const cpuPercent = cpuRaw && /\d/.test(cpuRaw) ? Math.round(Number(cpuRaw.trim())) : null;
  // GPU: the Windows 3D-engine counters cover every adapter (the browser may run on the integrated
  // GPU while nvidia-smi reports the discrete one idle); nvidia-smi is reported alongside when present.
  let gpuPercent: number | null = null;
  let gpuSource = 'none';
  const ctr = run('powershell -NoProfile -Command "(Get-Counter \'\\GPU Engine(*engtype_3D)\\Utilization Percentage\').CounterSamples | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum"');
  if (ctr && /\d/.test(ctr)) {
    gpuPercent = Math.round(Number(ctr.trim().replace(',', '.')) * 10) / 10;
    gpuSource = 'GPU Engine 3D counters (all adapters)';
  }
  const smi = run('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits');
  if (smi && /\d/.test(smi)) {
    const nv = Number(smi.trim().split(/\r?\n/)[0]);
    if (gpuPercent === null) {
      gpuPercent = nv;
      gpuSource = 'nvidia-smi';
    } else gpuSource += `, nvidia-smi ${nv}%`;
  }
  return { processes, chromeProcesses, cpuPercent, gpuPercent, gpuSource, at: new Date().toISOString() };
}

export function describeLoad(l: SystemLoad): string {
  return `processes ${l.processes ?? '?'} (chrome ${l.chromeProcesses ?? '?'}), cpu ${l.cpuPercent ?? '?'}%, gpu ${l.gpuPercent ?? '?'}% (${l.gpuSource})`;
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

export async function startPreview(): Promise<{ url: string; child: ChildProcess }> {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html not found. Run `npm run build` first (the tools use the production build).');
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

export interface BrowserOptions {
  browser: string;
  software: boolean;
  headed: boolean;
}

export async function launchBrowser(opts: BrowserOptions): Promise<Browser> {
  const chromeArgs = [
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
  ];
  if (opts.software) chromeArgs.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const channels = opts.browser === 'chromium' ? [undefined] : [opts.browser, undefined];
  let lastError: unknown = null;
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: !opts.headed, args: chromeArgs });
    } catch (err) {
      lastError = err;
      console.warn(`Could not launch ${channel ?? 'bundled chromium'}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }
  throw new Error(`No browser could be launched. Install Chrome, or run \`npx playwright install chromium\`. Last error: ${lastError}`);
}

export async function hookState(page: Page): Promise<RealismDebugState | null> {
  return page.evaluate(() => (window.__personaLiveRealism ? window.__personaLiveRealism.state() : null));
}

export async function waitForHookState(
  page: Page,
  label: string,
  predicate: (s: RealismDebugState | null) => boolean,
  timeoutMs: number
): Promise<RealismDebugState | null> {
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

/** Opens the built app with the realism surface on, signs into the demo and shows the AI output. */
export async function driveAppShell(page: Page, url: string, flagString: string, settingsString = '') {
  const query = new URLSearchParams({ realism: '1' });
  if (flagString) query.set('rf', flagString);
  if (settingsString) query.set('rs', settingsString);
  await page.goto(`${url}?${query.toString()}`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /demo administrator|Sign In as Admin/i }).click({ timeout: 30000 });
  await page.getByRole('button', { name: 'AI Output Only' }).click({ timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__personaLiveRealism), null, { timeout: 30000 });
}

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const projectRoot = import.meta.dirname ?? process.cwd();

/** package.json is the single source of truth for the user-visible app version. */
const APP_VERSION = (JSON.parse(fs.readFileSync(path.resolve(projectRoot, 'package.json'), 'utf8')) as { version: string }).version;

/** Public base path. GitHub Pages serves the app at /<repo>/, so the deploy workflow sets VITE_BASE=/PersonaLive/. */
const BASE_PATH = process.env.VITE_BASE || '/';
const BUILD_ID = process.env.GITHUB_SHA?.slice(0, 12) || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

/**
 * Serves the MediaPipe Tasks Vision WASM runtime from node_modules at /mediapipe/wasm
 * during development and copies it into dist/ for production. This keeps the face
 * tracking runtime fully local (no CDN dependency) so the desktop app works offline.
 */
function mediapipeWasm(): Plugin {
  const wasmDir = path.resolve(projectRoot, 'node_modules/@mediapipe/tasks-vision/wasm');
  const contentType = (file: string) => (file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');

  return {
    name: 'personalive-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe/wasm', (req, res, next) => {
        const name = path.basename((req.url ?? '').split('?')[0]);
        const file = path.join(wasmDir, name);
        if (!name || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', contentType(file));
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      if (!fs.existsSync(wasmDir)) return;
      for (const file of fs.readdirSync(wasmDir)) {
        this.emitFile({
          type: 'asset',
          fileName: `mediapipe/wasm/${file}`,
          source: fs.readFileSync(path.join(wasmDir, file)),
        });
      }
    },
  };
}

/**
 * Local personas: photos of consenting people live in the gitignored `references/` folder with a
 * `personas.json` manifest (see references/README.md). This plugin injects the manifest as
 * `__PL_LOCAL_PERSONAS__`, serves the listed files under /references/ in the dev server and copies
 * them into dist/references/ for local production and desktop builds. CI never has the folder, and
 * PERSONALIVE_LOCAL_PERSONAS=0 or GITHUB_ACTIONS skip it explicitly, so the Pages build ships only
 * the sample personas.
 */
interface LocalPersonaFile {
  id: string;
  name: string;
  role?: string;
  category: string;
  file: string;
  consent: Record<string, unknown>;
}

function readLocalPersonas(): { dir: string; entries: LocalPersonaFile[] } {
  const dir = path.resolve(projectRoot, 'references');
  const manifest = path.join(dir, 'personas.json');
  if (process.env.PERSONALIVE_LOCAL_PERSONAS === '0' || process.env.GITHUB_ACTIONS === 'true' || !fs.existsSync(manifest)) {
    return { dir, entries: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { personas?: LocalPersonaFile[] };
  const entries = (parsed.personas ?? []).filter((p) => {
    const ok = typeof p.file === 'string' && !p.file.includes('..') && fs.existsSync(path.join(dir, p.file));
    if (!ok) console.warn(`[local-personas] skipping ${p.id ?? '?'}: ${p.file} not found in ${dir}`);
    return ok;
  });
  return { dir, entries };
}

function localPersonas(): Plugin {
  const { dir, entries } = readLocalPersonas();
  const served = new Map(entries.map((p) => [path.basename(p.file), path.join(dir, p.file)]));
  const mime = (file: string) =>
    file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return {
    name: 'personalive-local-personas',
    config() {
      const manifest = entries.map((p) => ({ ...p, file: `references/${path.basename(p.file)}` }));
      return { define: { __PL_LOCAL_PERSONAS__: JSON.stringify(manifest) } };
    },
    configureServer(server) {
      server.middlewares.use('/references', (req, res, next) => {
        const name = path.basename(decodeURIComponent((req.url ?? '').split('?')[0]));
        const file = served.get(name);
        if (!file) return next();
        res.setHeader('Content-Type', mime(file));
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [name, file] of served) {
        this.emitFile({ type: 'asset', fileName: `references/${name}`, source: fs.readFileSync(file) });
      }
    },
  };
}

/**
 * Stamps the service worker with a per-build id. A byte-different sw.js makes browsers install
 * the new worker, which is what triggers the in-app "Update Ready — Restart" prompt after a deploy.
 */
function stampServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'personalive-stamp-sw',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const file = path.resolve(projectRoot, outDir, 'sw.js');
      if (!fs.existsSync(file)) return;
      const src = fs.readFileSync(file, 'utf8').replace(/__BUILD_ID__/g, BUILD_ID);
      fs.writeFileSync(file, src);
    },
  };
}

export default defineConfig(({ mode }) => {
  // The realism review path (activating a local persona whose consent is still pending) is compiled
  // in only for vite dev and `npm run build:review`; tools/check-prod-bundle.cjs fails any other build that carries it.
  const reviewBuild = mode === 'development' || process.env.PERSONALIVE_REVIEW === '1';
  return {
    base: BASE_PATH,
    define: { __PL_BUILD_ID__: JSON.stringify(BUILD_ID), __PL_APP_VERSION__: JSON.stringify(APP_VERSION), __PL_REVIEW_BUILD__: JSON.stringify(reviewBuild) },
    plugins: [react(), tailwindcss(), mediapipeWasm(), localPersonas(), stampServiceWorker()],
    // The segmentation worker (R4) is a classic IIFE worker: MediaPipe loads its WASM glue with importScripts.
    worker: { format: 'iife' as const },
    resolve: {
      alias: {
        '@': projectRoot,
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      // Vite's host check is only relaxed for the AI Studio proxy (which also sets DISABLE_HMR);
      // everywhere else the default (localhost + IP addresses) keeps DNS-rebinding protection on.
      allowedHosts: process.env.DISABLE_HMR === 'true' ? (true as const) : undefined,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

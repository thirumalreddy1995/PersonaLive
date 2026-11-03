import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const projectRoot = import.meta.dirname ?? process.cwd();

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

export default defineConfig(() => {
  return {
    base: BASE_PATH,
    define: { __PL_BUILD_ID__: JSON.stringify(BUILD_ID) },
    plugins: [react(), tailwindcss(), mediapipeWasm(), stampServiceWorker()],
    resolve: {
      alias: {
        '@': projectRoot,
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

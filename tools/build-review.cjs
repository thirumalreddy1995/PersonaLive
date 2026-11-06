#!/usr/bin/env node
/**
 * `npm run build:review [-- --outDir dist-xyz]`: a local build with the realism review path
 * compiled in (PERSONALIVE_REVIEW=1). Such a build can activate a local persona whose consent
 * record is still pending, for the realism review only, and must never be shipped.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--outDir');
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'dist';
const env = { ...process.env, PERSONALIVE_REVIEW: '1' };
const vite = path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
const build = spawnSync(process.execPath, [vite, 'build', ...args], { stdio: 'inherit', env });
if (build.status !== 0) process.exit(build.status ?? 1);
const check = spawnSync(process.execPath, [path.join(__dirname, 'check-prod-bundle.cjs'), outDir], { stdio: 'inherit', env });
process.exit(check.status ?? 1);

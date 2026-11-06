#!/usr/bin/env node
/**
 * Build-time guard (R4 item 2): a production build must not contain the review-only code path
 * that activates a persona whose consent record is still pending. The path is compiled in only
 * when `__PL_REVIEW_BUILD__` is true (vite dev, or `npm run build:review`), and it carries the
 * marker string below; this script fails the build if the marker survives into a bundle that was
 * not built for review.
 *
 *   node tools/check-prod-bundle.cjs [outDir]   (default dist)
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'PENDING_CONSENT_BYPASS';
const outDir = path.resolve(process.cwd(), process.argv[2] || 'dist');
const review = process.env.PERSONALIVE_REVIEW === '1';

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) walk(file, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(file);
  }
  return out;
}

if (!fs.existsSync(outDir)) {
  console.error(`check-prod-bundle: ${outDir} does not exist`);
  process.exit(1);
}
const hits = walk(outDir).filter((f) => fs.readFileSync(f, 'utf8').includes(MARKER));
if (review) {
  if (!hits.length) {
    console.error(`check-prod-bundle: review build requested but no bundle in ${outDir} carries the review path`);
    process.exit(1);
  }
  console.log(`check-prod-bundle: review build (${hits.length} bundle(s) carry the pending-consent review path; never ship this build)`);
  process.exit(0);
}
if (hits.length) {
  console.error(`check-prod-bundle: FAIL — the pending-consent review path is reachable in a production build:\n  ${hits.map((f) => path.relative(outDir, f)).join('\n  ')}`);
  process.exit(1);
}
console.log('check-prod-bundle: ok (no review-only consent path in the production bundle)');

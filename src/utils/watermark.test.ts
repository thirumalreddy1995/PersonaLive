import test from 'node:test';
import assert from 'node:assert/strict';
import { WATERMARK_MIN_FONT_PX, WATERMARK_MIN_HEIGHT_RATIO, WATERMARK_TEXT, watermarkMetrics } from './watermark.ts';

test('watermark text is at least 3% of the frame height at every output resolution', () => {
  for (const [w, h] of [
    [1920, 1080],
    [1280, 720],
    [960, 540],
  ]) {
    const m = watermarkMetrics(w, h);
    assert.ok(m.fontPx >= h * WATERMARK_MIN_HEIGHT_RATIO - 0.5, `${h}p: ${m.fontPx}px`);
    assert.ok(m.badgeH > m.fontPx, 'badge taller than text');
    assert.ok(m.margin + m.badgeH < h / 4, 'badge stays in the corner');
  }
});

test('watermark never drops below the 14 px floor on tiny frames', () => {
  const m = watermarkMetrics(320, 180);
  assert.equal(m.fontPx, WATERMARK_MIN_FONT_PX);
});

test('watermark text names the output as AI-transformed and carries no provenance claim', () => {
  assert.match(WATERMARK_TEXT, /AI-TRANSFORMED/);
  assert.doesNotMatch(WATERMARK_TEXT, /C2PA/i);
});

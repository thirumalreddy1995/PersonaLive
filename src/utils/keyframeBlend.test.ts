import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYFRAME_FADE_MS, KeyframeCrossfader, KeyframeTextureCache } from './keyframeBlend.ts';

test('switching keyframes uploads nothing: every source is uploaded exactly once', () => {
  const sources = ['frontal', 'yaw-left', 'yaw-right', 'pitch-up', 'pitch-down', 'open', 'smile'].map((label) => ({ label }));
  const uploaded: string[] = [];
  const cache = new KeyframeTextureCache((s: { label: string }) => {
    uploaded.push(s.label);
    return { texture: s.label };
  });
  // Persona load: one upload per keyframe.
  cache.warm(sources);
  assert.equal(cache.uploads, sources.length);
  assert.equal(cache.size, sources.length);

  // A long session of switches, the way the engine drives the renderer: the fader picks the pair,
  // the cache hands out the textures.
  const fader = new KeyframeCrossfader();
  const before = cache.uploads;
  let t = 0;
  for (let i = 0; i < 500; i++, t += 33) {
    const target = sources[(i >> 3) % sources.length];
    const fade = fader.update(target.label, t);
    const a = cache.get(sources.find((s) => s.label === fade.primary)!);
    assert.equal(a.texture, fade.primary);
    if (fade.secondary) cache.get(sources.find((s) => s.label === fade.secondary)!);
  }
  assert.equal(cache.uploads, before, 'no upload on any switch');
  assert.deepEqual(uploaded, sources.map((s) => s.label));

  // Without warming, a source is uploaded on first use only.
  const lazy = new KeyframeTextureCache((s: { label: string }) => s.label);
  lazy.get(sources[0]);
  lazy.get(sources[1]);
  lazy.get(sources[0]);
  lazy.get(sources[1]);
  assert.equal(lazy.uploads, 2);
  assert.equal(lazy.has(sources[2]), false);
});

test('KeyframeTextureCache.clear releases the resources unless the context is gone', () => {
  const destroyed: string[] = [];
  const cache = new KeyframeTextureCache(
    (s: { id: string }) => s.id,
    (r) => destroyed.push(r)
  );
  const a = { id: 'a' }, b = { id: 'b' };
  cache.get(a);
  cache.get(b);
  cache.clear();
  assert.deepEqual(destroyed.sort(), ['a', 'b']);
  assert.equal(cache.size, 0);
  assert.equal(cache.uploads, 0);
  cache.get(a);
  cache.clear(false);
  assert.equal(destroyed.length, 2, 'a lost context deletes nothing');
});

test('KeyframeCrossfader fades the old keyframe out over 150 ms without a step', () => {
  assert.equal(KEYFRAME_FADE_MS, 150);
  const f = new KeyframeCrossfader();
  // The first keyframe shows at once.
  assert.deepEqual(f.update('A', 0), { primary: 'A', secondary: null, secondaryWeight: 0 });
  assert.deepEqual(f.update('A', 500), { primary: 'A', secondary: null, secondaryWeight: 0 });
  // Switch: the frame of the switch still shows the old keyframe in full.
  const s0 = f.update('B', 533);
  assert.deepEqual(s0, { primary: 'B', secondary: 'A', secondaryWeight: 1 });
  // The mix moves monotonically and by small steps at 60 fps.
  let prev = 1;
  let maxStep = 0;
  for (let t = 533 + 16; t < 533 + 150; t += 16) {
    const s = f.update('B', t);
    assert.equal(s.primary, 'B');
    assert.equal(s.secondary, 'A');
    assert.ok(s.secondaryWeight <= prev);
    maxStep = Math.max(maxStep, prev - s.secondaryWeight);
    prev = s.secondaryWeight;
  }
  assert.ok(maxStep < 0.2, `largest per-frame change ${maxStep}`);
  assert.ok(prev < 0.05 && prev > 0, `just before the end ${prev}`);
  assert.deepEqual(f.update('B', 533 + 150), { primary: 'B', secondary: null, secondaryWeight: 0 });
});

test('KeyframeCrossfader reverses a fade when the bank switches back, and fades from the dominant keyframe to a third', () => {
  const f = new KeyframeCrossfader(150);
  f.update('A', 0);
  f.update('B', 100);
  const mid = f.update('B', 150); // a third of the way: A still dominant
  assert.ok(mid.secondaryWeight > 0.5);
  // Back to A: A becomes the primary again with the same picture on screen (weights swap).
  const back = f.update('A', 150);
  assert.equal(back.primary, 'A');
  assert.equal(back.secondary, 'B');
  assert.ok(Math.abs(back.secondaryWeight - (1 - mid.secondaryWeight)) < 1e-9);
  // It then finishes in the remaining time, not a full 150 ms.
  assert.equal(f.update('A', 150 + 51).secondary, null);

  // A third keyframe during a fade: from the dominant one.
  const g = new KeyframeCrossfader(150);
  g.update('A', 0);
  g.update('B', 100);
  g.update('B', 130); // 20%: A dominant
  assert.deepEqual(g.update('C', 130), { primary: 'C', secondary: 'A', secondaryWeight: 1 });
  const h = new KeyframeCrossfader(150);
  h.update('A', 0);
  h.update('B', 100);
  h.update('B', 220); // 80%: B dominant
  assert.deepEqual(h.update('C', 220), { primary: 'C', secondary: 'B', secondaryWeight: 1 });

  // reset forgets everything; a zero duration switches at once.
  h.reset();
  assert.deepEqual(h.update('Z', 0), { primary: 'Z', secondary: null, secondaryWeight: 0 });
  const instant = new KeyframeCrossfader(0);
  instant.update('A', 0);
  assert.deepEqual(instant.update('B', 10), { primary: 'B', secondary: null, secondaryWeight: 0 });
});

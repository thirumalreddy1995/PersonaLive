import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameProfiler, RingBuffer, mean, percentile } from './profiler.ts';

test('RingBuffer keeps the most recent values in order', () => {
  const ring = new RingBuffer(3);
  for (const v of [1, 2, 3, 4, 5]) ring.push(v);
  assert.deepEqual(ring.values(), [3, 4, 5]);
  assert.equal(ring.length, 3);
  ring.clear();
  assert.deepEqual(ring.values(), []);
});

test('percentile and mean handle empty and small lists', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(mean([]), 0);
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(mean([1, 2, 3]), 2);
});

test('FrameProfiler reports FPS, frame percentiles and per-stage averages from a fake clock', () => {
  let t = 0;
  const profiler = new FrameProfiler(100, () => t);
  for (let i = 0; i < 10; i++) {
    const start = t;
    profiler.begin('track');
    t += 4;
    profiler.end('track');
    profiler.begin('warp');
    t += i === 4 ? 20 : 6;
    profiler.end('warp');
    profiler.frame(t - start, t);
    t += 33.33 - (t - start);
  }
  const s = profiler.summary();
  assert.equal(s.frames, 10);
  assert.ok(Math.abs(s.fps - 30) < 0.5, `fps ${s.fps}`);
  assert.equal(s.frameP50Ms, 10);
  assert.equal(s.frameP95Ms, 24);
  assert.equal(s.stages.track.avgMs, 4);
  assert.equal(s.stages.warp.p95Ms, 20);
  assert.equal(s.stages.warp.samples, 10);
});

test('FrameProfiler ignores end() without begin() and resets cleanly', () => {
  const profiler = new FrameProfiler(10, () => 0);
  profiler.end('nothing');
  assert.deepEqual(profiler.summary().stages, {});
  profiler.frame(5, 100);
  profiler.reset();
  assert.equal(profiler.summary().frames, 0);
});

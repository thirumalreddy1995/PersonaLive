import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameGate, FramePacer, PACING_STALL_MS, pacingMode, type PacedTick, type PacedVideo } from './framePacing.ts';

/** A fake browser: animation frames and video frames are fired by hand. */
function fakeEnv() {
  let next = 1;
  const raf = new Map<number, (now: number) => void>();
  const vfc = new Map<number, (now: number, m: { mediaTime: number }) => void>();
  return {
    env: {
      requestAnimationFrame: (cb: (now: number) => void) => {
        raf.set(next, cb);
        return next++;
      },
      cancelAnimationFrame: (h: number) => {
        raf.delete(h);
      },
    },
    video: (currentTime = 0): PacedVideo & { currentTime: number } => ({
      currentTime,
      requestVideoFrameCallback: (cb) => {
        vfc.set(next, cb);
        return next++;
      },
      cancelVideoFrameCallback: (h) => {
        vfc.delete(h);
      },
    }),
    /** Runs every pending animation-frame callback once. */
    animationFrame: (now: number) => {
      const pending = [...raf.entries()];
      raf.clear();
      for (const [, cb] of pending) cb(now);
    },
    videoFrame: (now: number, mediaTime: number) => {
      const pending = [...vfc.entries()];
      vfc.clear();
      for (const [, cb] of pending) cb(now, { mediaTime });
    },
    pending: () => ({ raf: raf.size, vfc: vfc.size }),
  };
}

test('pacingMode: video frames only with the flag on and the API present', () => {
  const f = fakeEnv();
  assert.equal(pacingMode(true, f.video()), 'video-frame');
  assert.equal(pacingMode(false, f.video()), 'animation-frame');
  assert.equal(pacingMode(true, { currentTime: 0 }), 'animation-frame');
  assert.equal(pacingMode(true, null), 'animation-frame');
});

test('FrameGate reports a frame once', () => {
  const g = new FrameGate();
  assert.equal(g.isNew(0.033), true);
  assert.equal(g.isNew(0.033), false);
  assert.equal(g.isNew(0.066), true);
  assert.equal(g.isNew(null), true, 'no media time: always new');
  assert.equal(g.isNew(NaN), true);
  g.reset();
  assert.equal(g.isNew(0.066), true);
});

test('flag off: plain requestAnimationFrame, every tick is a frame', () => {
  const f = fakeEnv();
  const pacer = new FramePacer(f.env);
  const ticks: PacedTick[] = [];
  const video = f.video();
  const loop = (_now: number, info: PacedTick) => {
    ticks.push(info);
    pacer.schedule(video, false, loop);
  };
  pacer.schedule(video, false, loop);
  for (let i = 0; i < 6; i++) f.animationFrame(i * 16.7);
  assert.equal(ticks.length, 6);
  assert.ok(ticks.every((t) => t.mode === 'animation-frame' && t.newFrame && !t.stalled));
  assert.equal(f.pending().vfc, 0, 'requestVideoFrameCallback is never used with the flag off');
});

test('flag on: each camera frame is processed exactly once at a 60 Hz display', () => {
  const f = fakeEnv();
  const pacer = new FramePacer(f.env);
  const ticks: PacedTick[] = [];
  const video = f.video();
  const loop = (_now: number, info: PacedTick) => {
    ticks.push(info);
    pacer.schedule(video, true, loop);
  };
  pacer.schedule(video, true, loop);
  // One second: 60 display refreshes, 30 camera frames (every second refresh).
  for (let i = 0; i < 60; i++) {
    const now = i * (1000 / 60);
    if (i % 2 === 0) f.videoFrame(now, i / 60);
    f.animationFrame(now);
  }
  // The loop ticks on every refresh, but only the 30 ticks that carry a camera frame are processed.
  assert.equal(ticks.length, 60);
  const processed = ticks.filter((t) => t.newFrame);
  assert.equal(processed.length, 30);
  assert.ok(processed.every((t) => t.mode === 'video-frame' && !t.stalled));
  assert.ok(ticks.filter((t) => !t.newFrame).every((t) => !t.stalled), 'the other 30 are skipped, not watchdog ticks');
  assert.deepEqual(processed.slice(0, 3).map((t) => t.mediaTime), [0, 2 / 60, 4 / 60]);
  assert.equal(pacer.framesOverwritten, 0);
  // Exactly one of each is pending between ticks: no pile-up of callbacks.
  assert.deepEqual(f.pending(), { raf: 1, vfc: 1 });
});

test('flag on: the watchdog ticks when the video stops delivering frames, and video frames take over again', () => {
  const f = fakeEnv();
  const pacer = new FramePacer(f.env);
  const ticks: Array<PacedTick & { now: number }> = [];
  const video = f.video();
  const loop = (now: number, info: PacedTick) => {
    ticks.push({ ...info, now });
    pacer.schedule(video, true, loop);
  };
  pacer.schedule(video, true, loop);
  f.videoFrame(0, 0);
  // The clip is paused: only animation frames for a second.
  for (let now = 16; now <= 1000; now += 16) f.animationFrame(now);
  const stalled = ticks.filter((t) => t.stalled);
  assert.ok(stalled.length >= 3 && stalled.length <= 4, `${stalled.length} watchdog ticks in 1 s`);
  assert.ok(stalled.every((t) => t.mode === 'animation-frame' && !t.newFrame));
  for (let i = 1; i < stalled.length; i++) assert.ok(stalled[i].now - stalled[i - 1].now >= PACING_STALL_MS);
  // Playback resumes: the frame is processed on the next animation frame.
  f.videoFrame(1010, 0.033);
  f.animationFrame(1016);
  const last = ticks[ticks.length - 1];
  assert.equal(last.mode, 'video-frame');
  assert.equal(last.newFrame, true);
});

test('flag on without requestVideoFrameCallback: animation frames with a changed-frame check', () => {
  const f = fakeEnv();
  const pacer = new FramePacer(f.env);
  const ticks: PacedTick[] = [];
  const video: PacedVideo = { currentTime: 0 };
  const loop = (_now: number, info: PacedTick) => {
    ticks.push(info);
    pacer.schedule(video, true, loop);
  };
  pacer.schedule(video, true, loop);
  // 60 refreshes, the video advances every second one.
  for (let i = 0; i < 60; i++) {
    video.currentTime = Math.floor(i / 2) / 30;
    f.animationFrame(i * (1000 / 60));
  }
  assert.equal(ticks.length, 60, 'the loop keeps running');
  assert.equal(ticks.filter((t) => t.newFrame).length, 30, 'but only changed frames are processed');
  assert.equal(ticks.filter((t) => t.stalled).length, 0);
  // A frozen source: no new frame, a stalled tick once the interval has passed.
  const before = ticks.length;
  for (let now = 1000; now <= 1600; now += 16.7) f.animationFrame(now);
  const frozen = ticks.slice(before);
  assert.equal(frozen.filter((t) => t.newFrame).length, 0);
  assert.ok(frozen.some((t) => t.stalled));
  // No video at all (demo image): every tick is a frame.
  const g = fakeEnv();
  const p2 = new FramePacer(g.env);
  let n = 0;
  const loop2 = (_now: number, info: PacedTick) => {
    if (info.newFrame) n++;
    p2.schedule(null, true, loop2);
  };
  p2.schedule(null, true, loop2);
  for (let i = 0; i < 5; i++) g.animationFrame(i * 16);
  assert.equal(n, 5);
});

test('cancel stops the loop and a stale callback does nothing', () => {
  const f = fakeEnv();
  const pacer = new FramePacer(f.env);
  let n = 0;
  const video = f.video();
  pacer.schedule(video, true, () => n++);
  pacer.cancel();
  assert.deepEqual(f.pending(), { raf: 0, vfc: 0 });
  f.videoFrame(0, 0);
  f.animationFrame(300);
  assert.equal(n, 0);
  // Rescheduling replaces the pending request instead of stacking a second one.
  pacer.schedule(video, true, () => n++);
  pacer.schedule(video, true, () => n++);
  assert.deepEqual(f.pending(), { raf: 1, vfc: 1 });
  f.videoFrame(10, 0.033);
  assert.equal(n, 0, 'the video callback only marks the frame');
  f.animationFrame(16);
  assert.equal(n, 1);
});

test('flag on: a loop slower than the camera processes a frame on every tick instead of every other frame', () => {
  const f = fakeEnv();
  const pacer = new FramePacer(f.env);
  const ticks: PacedTick[] = [];
  const video = f.video();
  // The loop is rescheduled only after the frame's work, which here spans two refreshes (about 33 ms).
  let resume: (() => void) | null = null;
  const loop = (_now: number, info: PacedTick) => {
    ticks.push(info);
    resume = () => pacer.schedule(video, true, loop);
  };
  pacer.schedule(video, true, loop);
  // One second: 60 refreshes, a camera frame on every second one; the loop is free again on every second refresh.
  for (let i = 0; i < 60; i++) {
    const now = i * (1000 / 60);
    if (i % 2 === 0) f.videoFrame(now, i / 60);
    f.animationFrame(now);
    if (i % 2 === 1 && resume) {
      const r: () => void = resume;
      resume = null;
      r();
    }
  }
  const processed = ticks.filter((t) => t.newFrame);
  assert.ok(processed.length >= 29, `${processed.length} frames processed in 1 s (the R5 pacer managed 15)`);
  assert.equal(ticks.filter((t) => t.stalled).length, 0);
});

test('flag on: the listener re-arms before the frame is processed, and counts frames it had to overwrite', () => {
  const f = fakeEnv();
  const pacer = new FramePacer(f.env);
  const ticks: PacedTick[] = [];
  const video = f.video();
  pacer.schedule(video, true, (_now, info) => ticks.push(info));
  // Three camera frames arrive before the loop runs once.
  f.videoFrame(0, 0);
  assert.equal(f.pending().vfc, 1, 're-armed inside the callback');
  f.videoFrame(33, 0.033);
  f.videoFrame(66, 0.066);
  f.animationFrame(70);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].mediaTime, 0.066, 'the newest frame is the one processed');
  assert.equal(pacer.framesOverwritten, 2);
  // Flag off: the listener is released.
  pacer.schedule(video, false, () => undefined);
  assert.equal(f.pending().vfc, 0);
});

/**
 * Frame pacing (R5 §3, flag videoFramePacing).
 *
 * The loop used to run on requestAnimationFrame: at a 60 Hz display with a 30 fps camera every
 * camera frame was tracked and rendered twice. With the flag on the loop is driven by the video
 * element's requestVideoFrameCallback, which fires once per presented frame; where that API is
 * missing it stays on requestAnimationFrame and skips ticks whose video frame has not changed.
 * A watchdog keeps the loop alive when no video frame arrives (paused clip, stopped camera), so
 * the standby screen and the watermark keep being drawn. Pure: the browser entry points are
 * injected, so the scheduling is unit-tested with fakes.
 */

export type PacingMode = 'video-frame' | 'animation-frame';

/** Without a new video frame for this long, a tick runs anyway. */
export const PACING_STALL_MS = 250;

export interface PacedVideo {
  requestVideoFrameCallback?: (cb: (now: number, metadata: { mediaTime: number; presentedFrames?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  currentTime: number;
}

export interface PacingEnv {
  requestAnimationFrame: (cb: (now: number) => void) => number;
  cancelAnimationFrame: (handle: number) => void;
}

export interface PacedTick {
  /** What woke the loop. */
  mode: PacingMode;
  /** True when this tick carries a video frame that has not been processed yet (or there is no video to compare). */
  newFrame: boolean;
  /** True when the watchdog fired because no video frame arrived in time. */
  stalled: boolean;
  /** Media time of the frame (seconds) when known. */
  mediaTime: number | null;
}

/** Which mechanism drives the loop for this source. */
export function pacingMode(flagOn: boolean, video: PacedVideo | null): PacingMode {
  return flagOn && !!video && typeof video.requestVideoFrameCallback === 'function' ? 'video-frame' : 'animation-frame';
}

/**
 * Changed-frame check for the requestAnimationFrame fallback: a tick is new when the video's
 * media time moved since the last processed tick. Without a media time (demo image, no video)
 * every tick is new.
 */
export class FrameGate {
  private last: number | null = null;

  isNew(mediaTime: number | null): boolean {
    if (mediaTime === null || !Number.isFinite(mediaTime)) return true;
    if (this.last !== null && mediaTime === this.last) return false;
    this.last = mediaTime;
    return true;
  }

  reset(): void {
    this.last = null;
  }
}

/** Schedules one loop tick at a time through requestVideoFrameCallback or requestAnimationFrame. */
export class FramePacer {
  private rafHandle: number | null = null;
  private vfcHandle: number | null = null;
  private vfcVideo: PacedVideo | null = null;
  private gate = new FrameGate();
  private lastTick: number | null = null;
  /** Bumped on every schedule/cancel so a stale callback (the loser of the race) does nothing. */
  private generation = 0;

  constructor(private readonly env: PacingEnv) {}

  /** Cancels whatever is pending. */
  cancel(): void {
    this.generation++;
    if (this.rafHandle !== null) this.env.cancelAnimationFrame(this.rafHandle);
    if (this.vfcHandle !== null && this.vfcVideo?.cancelVideoFrameCallback) this.vfcVideo.cancelVideoFrameCallback(this.vfcHandle);
    this.rafHandle = null;
    this.vfcHandle = null;
    this.vfcVideo = null;
  }

  /** Forgets the last processed frame (new source). */
  reset(): void {
    this.gate.reset();
    this.lastTick = null;
  }

  /**
   * Schedules the next tick. With `flagOn` false this is plain requestAnimationFrame and every
   * tick is a new frame (the pre-R5 behaviour). `tick` is called exactly once per schedule.
   */
  schedule(video: PacedVideo | null, flagOn: boolean, tick: (now: number, info: PacedTick) => void): void {
    this.cancel();
    const gen = this.generation;
    const fire = (now: number, info: PacedTick) => {
      if (gen !== this.generation) return;
      this.cancel();
      // Only a processed tick (a new frame, or a watchdog tick) restarts the stall interval.
      if (info.newFrame || info.stalled) this.lastTick = now;
      tick(now, info);
    };

    if (!flagOn) {
      this.rafHandle = this.env.requestAnimationFrame((now) => fire(now, { mode: 'animation-frame', newFrame: true, stalled: false, mediaTime: null }));
      return;
    }

    if (pacingMode(true, video) === 'video-frame' && video) {
      this.vfcVideo = video;
      this.vfcHandle = video.requestVideoFrameCallback!((now, metadata) => {
        this.gate.isNew(metadata.mediaTime);
        fire(now, { mode: 'video-frame', newFrame: true, stalled: false, mediaTime: metadata.mediaTime });
      });
      // Watchdog: keep polling on animation frames and tick if the video stays silent.
      const watch = (now: number) => {
        if (gen !== this.generation) return;
        const since = this.lastTick === null ? Infinity : now - this.lastTick;
        if (since >= PACING_STALL_MS) fire(now, { mode: 'animation-frame', newFrame: false, stalled: true, mediaTime: null });
        else this.rafHandle = this.env.requestAnimationFrame(watch);
      };
      this.rafHandle = this.env.requestAnimationFrame(watch);
      return;
    }

    // Fallback: animation frames with a changed-frame check.
    this.rafHandle = this.env.requestAnimationFrame((now) => {
      const mediaTime = video ? video.currentTime : null;
      const isNew = this.gate.isNew(mediaTime);
      const since = this.lastTick === null ? Infinity : now - this.lastTick;
      // An unchanged frame is skipped, but not forever: a paused source still gets a tick per stall interval.
      const stalled = !isNew && since >= PACING_STALL_MS;
      fire(now, { mode: 'animation-frame', newFrame: isNew, stalled, mediaTime });
    });
  }
}

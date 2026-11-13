/**
 * Frame pacing (R5 §3, flag videoFramePacing; reworked in R6).
 *
 * The loop runs on requestAnimationFrame: at a 60 Hz display with a 30 fps camera a fast machine
 * tracks and renders every camera frame twice. With the flag on, the video element's
 * requestVideoFrameCallback only marks "a new frame was presented": the callback re-arms itself
 * at once and does no work, and the loop, still on requestAnimationFrame, processes a tick only
 * when that mark is set. (R5 ran the frame inside the video callback and re-armed it afterwards;
 * with a 20-30 ms frame that missed every other video frame and halved the rate.) Where the API
 * is missing the loop skips ticks whose media time has not changed. A watchdog tick runs when no
 * video frame arrives (paused clip, stopped camera), so the standby screen and the watermark keep
 * being drawn. Pure: the browser entry points are injected, so the scheduling is unit-tested with fakes.
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
  /** How the tick learned about its frame: 'video-frame' for a frame announced by requestVideoFrameCallback, otherwise 'animation-frame'. */
  mode: PacingMode;
  /** True when this tick carries a video frame that has not been processed yet (or there is no video to compare). */
  newFrame: boolean;
  /** True when the watchdog fired because no video frame arrived in time. */
  stalled: boolean;
  /** Media time of the frame (seconds) when known. */
  mediaTime: number | null;
}

/** Which mechanism tells the loop about new frames for this source. */
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

/** Schedules one loop tick at a time on requestAnimationFrame; with the flag on, a tick is a frame only when the video announced one. */
export class FramePacer {
  private rafHandle: number | null = null;
  private gate = new FrameGate();
  private lastTick: number | null = null;
  /** Bumped on every schedule/cancel so a stale callback does nothing. */
  private generation = 0;
  // The persistent video-frame listener: it re-arms itself and only records that a frame arrived.
  private listenVideo: PacedVideo | null = null;
  private listenHandle: number | null = null;
  private listenGeneration = 0;
  private hasNewFrame = false;
  private newFrameMediaTime: number | null = null;
  private overwritten = 0;

  constructor(private readonly env: PacingEnv) {}

  /** Stops the loop: cancels the pending tick and the video-frame listener. */
  cancel(): void {
    this.cancelTick();
    this.stopListening();
  }

  /** Forgets the last processed frame (new source). */
  reset(): void {
    this.gate.reset();
    this.lastTick = null;
    this.hasNewFrame = false;
    this.newFrameMediaTime = null;
    this.overwritten = 0;
  }

  /** Camera frames that were replaced by a newer one before the loop got to them (the loop was slower than the camera). */
  get framesOverwritten(): number {
    return this.overwritten;
  }

  private cancelTick(): void {
    this.generation++;
    if (this.rafHandle !== null) this.env.cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  private stopListening(): void {
    this.listenGeneration++;
    if (this.listenHandle !== null && this.listenVideo?.cancelVideoFrameCallback) this.listenVideo.cancelVideoFrameCallback(this.listenHandle);
    this.listenHandle = null;
    this.listenVideo = null;
    this.hasNewFrame = false;
  }

  private listen(video: PacedVideo): void {
    if (this.listenVideo === video && this.listenHandle !== null) return;
    this.stopListening();
    this.listenVideo = video;
    const gen = this.listenGeneration;
    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (gen !== this.listenGeneration) return;
      // Re-arm first: the next frame is never missed because this one is still being worked on.
      this.listenHandle = video.requestVideoFrameCallback!(onFrame);
      if (this.hasNewFrame) this.overwritten++;
      this.hasNewFrame = true;
      this.newFrameMediaTime = metadata.mediaTime;
    };
    this.listenHandle = video.requestVideoFrameCallback!(onFrame);
  }

  /**
   * Schedules the next tick on the next animation frame. With `flagOn` false every tick is a new
   * frame (the pre-R5 behaviour). `tick` is called exactly once per schedule; a tick with neither
   * `newFrame` nor `stalled` is one the caller skips.
   */
  schedule(video: PacedVideo | null, flagOn: boolean, tick: (now: number, info: PacedTick) => void): void {
    this.cancelTick();
    const gen = this.generation;
    const fire = (now: number, info: PacedTick) => {
      if (gen !== this.generation) return;
      this.rafHandle = null;
      // Only a processed tick (a new frame, or a watchdog tick) restarts the stall interval.
      if (info.newFrame || info.stalled) this.lastTick = now;
      tick(now, info);
    };

    if (!flagOn) {
      this.stopListening();
      this.rafHandle = this.env.requestAnimationFrame((now) => fire(now, { mode: 'animation-frame', newFrame: true, stalled: false, mediaTime: null }));
      return;
    }

    if (pacingMode(true, video) === 'video-frame' && video) {
      this.listen(video);
      this.rafHandle = this.env.requestAnimationFrame((now) => {
        if (gen !== this.generation) return;
        if (this.hasNewFrame) {
          this.hasNewFrame = false;
          fire(now, { mode: 'video-frame', newFrame: true, stalled: false, mediaTime: this.newFrameMediaTime });
          return;
        }
        // No frame announced: skip, but not forever (a paused source still gets a tick per stall interval).
        const since = this.lastTick === null ? Infinity : now - this.lastTick;
        fire(now, { mode: 'animation-frame', newFrame: false, stalled: since >= PACING_STALL_MS, mediaTime: null });
      });
      return;
    }

    // Fallback: animation frames with a changed-frame check.
    this.stopListening();
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

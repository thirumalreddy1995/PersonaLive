/**
 * Resting-mouth calibration (R3 item 1). The "keep my real mouth" lip fade used fixed aperture
 * thresholds (fade from MAR 0.02 to 0.10); a wearer whose closed mouth already measures 0.08–0.14
 * never sees the persona's lips. This learns the wearer's own resting aperture from the first
 * frontal seconds (a low percentile over a ~2 s window) and keeps recalibrating while the head is
 * frontal, like the rigid-forehead shape offset, so the fade thresholds sit relative to it.
 * Pure: no DOM, unit-tested.
 */

/** Window over which one resting-aperture estimate is taken. */
export const REST_MOUTH_WINDOW_MS = 2000;
/** Percentile of the window's MAR samples that counts as "resting". */
export const REST_MOUTH_PERCENTILE = 0.1;
/** |yaw| and |pitch| (degrees) within which samples are collected. */
export const REST_MOUTH_FRONTAL_DEG = 12;
/** A lower estimate replaces the rest value at once; a higher one moves it by this share per window. */
export const REST_MOUTH_RISE_BLEND = 0.1;

/** Fixed lip-fade thresholds used until the rest aperture is known (R1). */
export const LIP_FADE_START = 0.02;
export const LIP_FADE_END = 0.1;
/** With a known rest aperture the fade starts this far above it ... */
export const LIP_FADE_REST_MARGIN = 0.015;
/** ... and completes this far above the start (the R1 fade width). */
export const LIP_FADE_WIDTH = LIP_FADE_END - LIP_FADE_START;

export interface LipFadeWindow {
  start: number;
  end: number;
}

/** Lip-fade thresholds for a (possibly unknown) resting aperture. */
export function lipFadeWindow(rest: number | null): LipFadeWindow {
  if (rest === null) return { start: LIP_FADE_START, end: LIP_FADE_END };
  const start = rest + LIP_FADE_REST_MARGIN;
  return { start, end: start + LIP_FADE_WIDTH };
}

export class RestMouthCalibrator {
  /** The learned resting aperture, or null until the first frontal window completes. */
  rest: number | null = null;
  /** Windows that have completed (for the debug state). */
  windows = 0;
  private samples: Array<{ t: number; mar: number }> = [];

  /** Feeds one frame; samples outside the frontal band are ignored. */
  push(mar: number, timestamp: number, yawDeg: number, pitchDeg: number) {
    if (Math.abs(yawDeg) >= REST_MOUTH_FRONTAL_DEG || Math.abs(pitchDeg) >= REST_MOUTH_FRONTAL_DEG) return;
    if (!Number.isFinite(mar) || !Number.isFinite(timestamp)) return;
    // A gap in frontal frames (head turned away) restarts the window.
    const last = this.samples[this.samples.length - 1];
    if (last && timestamp - last.t > REST_MOUTH_WINDOW_MS) this.samples = [];
    this.samples.push({ t: timestamp, mar });
    if (timestamp - this.samples[0].t < REST_MOUTH_WINDOW_MS || this.samples.length < 10) return;
    const sorted = this.samples.map((s) => s.mar).sort((a, b) => a - b);
    const p = sorted[Math.min(sorted.length - 1, Math.floor(REST_MOUTH_PERCENTILE * (sorted.length - 1)))];
    this.rest = this.rest === null || p < this.rest ? p : this.rest + (p - this.rest) * REST_MOUTH_RISE_BLEND;
    this.windows++;
    this.samples = [];
  }

  reset() {
    this.rest = null;
    this.windows = 0;
    this.samples = [];
  }
}

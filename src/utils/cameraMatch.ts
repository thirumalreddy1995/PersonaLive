/**
 * Camera-matched sharpness and noise (R2 §4): the control loop that drives the shader's mip LOD
 * bias (blur), unsharp amount (sharpen) and noise sigma so the persona's face-region sharpness
 * and sensor noise converge on the wearer's, as measured by the asynchronous readbacks.
 * Pure, so it is unit-tested with synthetic statistics.
 */
import type { FaceStats } from './meshWarpRenderer.ts';

export interface CameraMatchState {
  lodBias: number;
  sharpen: number;
  noiseSigma: number;
  /** Last measured values (for the debug panel and the capture report). */
  driverLaplacian: number | null;
  outputLaplacian: number | null;
  driverNoise: number | null;
  outputNoise: number | null;
  updates: number;
  /** Smoothed log sharpness ratio (output / driver) the controls follow. */
  errEma: number;
  /** Steady mode (R3): slow EMAs of the log Laplacian variances the error is taken from. */
  driverLogEma?: number | null;
  outputLogEma?: number | null;
}

export interface CameraMatchStepOptions {
  /** Slow EMA on both estimates plus a dead band, so the controls track the camera's steady softness (R3 item 3). */
  steady?: boolean;
  /** Record the measurement but move nothing: the head is moving fast and the frame is motion-blurred. */
  hold?: boolean;
}

/** Steady mode: share of each new measurement that enters the estimate (one update per 15 frames). */
export const STEADY_ALPHA = 0.12;
/** Steady mode: |log ratio| below which the controls stay put. */
/** Frames between camera-match readbacks once warm. */
export const CAMERA_MATCH_EVERY = 15;
/** After a persona or source change the first updates run on consecutive frames (R3b warm start). */
export const CAMERA_MATCH_WARM_UPDATES = 5;

/** True when a readback should be issued this frame: every frame while warm updates remain, then every `every` frames. */
export function cameraMatchDue(frameIndex: number, warmLeft: number, every = CAMERA_MATCH_EVERY): boolean {
  return warmLeft > 0 || frameIndex % every === 0;
}

export const STEADY_DEADBAND = 0.1;

export const CAMERA_MATCH_LIMITS = {
  lodBias: [0, 4] as const,
  sharpen: [0, 1.5] as const,
  noiseSigma: [0, 0.08] as const,
};

export function initialCameraMatch(): CameraMatchState {
  return { lodBias: 0, sharpen: 0, noiseSigma: 0, driverLaplacian: null, outputLaplacian: null, driverNoise: null, outputNoise: null, updates: 0, errEma: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * One control step. `gain` scales how far each step moves (0.35 converges within ~10 updates,
 * i.e. ~5 s at one update per 15 frames, without overshooting on a log-ratio error).
 */
export function stepCameraMatch(state: CameraMatchState, driver: FaceStats, output: FaceStats, gain = 0.35, opts: CameraMatchStepOptions = {}): CameraMatchState {
  const next = { ...state, driverLaplacian: driver.laplacianVariance, outputLaplacian: output.laplacianVariance, driverNoise: driver.noiseMad, outputNoise: output.noiseMad, updates: state.updates + 1 };
  if (driver.samples < 64 || output.samples < 64) return next;
  if (opts.hold) return next;
  const eps = 1e-3;
  // Sharpness: positive error = output sharper than the camera → blur (LOD bias); negative → sharpen.
  // The raw log ratio jumps with motion blur on head turns, so it is smoothed before it drives
  // anything, and only one of the two opposing controls moves away from zero at a time.
  let err: number;
  if (opts.steady) {
    const dLog = Math.log(driver.laplacianVariance + eps);
    const oLog = Math.log(output.laplacianVariance + eps);
    const d = state.driverLogEma ?? null;
    const o = state.outputLogEma ?? null;
    next.driverLogEma = d === null ? dLog : d + (dLog - d) * STEADY_ALPHA;
    next.outputLogEma = o === null ? oLog : o + (oLog - o) * STEADY_ALPHA;
    err = next.outputLogEma - next.driverLogEma;
    next.errEma = err;
    if (Math.abs(err) < STEADY_DEADBAND) return next;
  } else {
    const raw = Math.log((output.laplacianVariance + eps) / (driver.laplacianVariance + eps));
    err = state.updates === 0 ? raw : state.errEma + (raw - state.errEma) * 0.5;
    next.errEma = err;
  }
  if (err > 0) {
    if (state.sharpen > 0) next.sharpen = clamp(state.sharpen - gain * err, ...CAMERA_MATCH_LIMITS.sharpen);
    else next.lodBias = clamp(state.lodBias + gain * err, ...CAMERA_MATCH_LIMITS.lodBias);
  } else {
    if (state.lodBias > 0) next.lodBias = clamp(state.lodBias + gain * err, ...CAMERA_MATCH_LIMITS.lodBias);
    else next.sharpen = clamp(state.sharpen - gain * err * 0.5, ...CAMERA_MATCH_LIMITS.sharpen);
  }
  // Noise: match the camera's high-pass sigma (0..255 → 0..1 units).
  const noiseErr = (driver.noiseMad - output.noiseMad) / 255;
  next.noiseSigma = clamp(state.noiseSigma + gain * noiseErr, ...CAMERA_MATCH_LIMITS.noiseSigma);
  return next;
}

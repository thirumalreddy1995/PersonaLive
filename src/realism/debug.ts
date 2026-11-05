/**
 * Dev-only realism debugging surface.
 *
 * - `isRealismDebugEnabled()` gates the debug panel, the video-file source and the window hook:
 *   on in `vite dev`, and on in a production build only when the page URL carries `?realism`
 *   (that is how the headless capture tool drives a built app).
 * - The engine registers a `RealismEngineDebugApi` here; the panel and the window hook read it.
 * - `window.__personaLiveRealism` exposes flags, state and frame captures to Playwright.
 */
import {
  REALISM_FLAG_DEFS,
  RealismFlags,
  describeRealismFlags,
  parseRealismFlagsFromSearch,
  realismFlags,
} from './flags.ts';
import type { ProfileSummary } from './profiler.ts';
import { parseSettingsFromSearch } from './settings.ts';
import type { AuthorizedPersona, HeadPose, PersonaCategory, TransformationSettings } from '../types/index.ts';

export interface RealismDebugState {
  source: string;
  canvasWidth: number;
  canvasHeight: number;
  faceVisible: boolean;
  /** Face oval bounds in output-canvas pixels, or null without a face. */
  faceBox: { x: number; y: number; w: number; h: number } | null;
  mar: number;
  /** Lip-band fade applied on the last frame (0 = persona lips, 1 = wearer's lips). */
  lipFade: number;
  /** Smoothed head pose from the facial transformation matrix when rigidForehead ran (degrees). */
  rigidPose: { yaw: number; pitch: number; roll: number } | null;
  /** Camera-match loop state when cameraMatch ran (null otherwise). */
  cameraMatch: {
    lodBias: number;
    sharpen: number;
    noiseSigma: number;
    driverLaplacian: number | null;
    outputLaplacian: number | null;
    driverNoise: number | null;
    outputNoise: number | null;
    updates: number;
  } | null;
  renderer: 'webgl2' | 'webgl' | 'canvas2d';
  pose: HeadPose;
  isSpeaking: boolean;
  isSmiling: boolean;
  keyframeId: string | null;
  keyframeCount: number;
  personaStatus: string;
  framesRendered: number;
  /** Frames in which OralCavityRenderer drew synthetic teeth. */
  syntheticTeethFrames: number;
  videoTime: number | null;
  videoDuration: number | null;
  videoEnded: boolean;
  profile: ProfileSummary;
  flags: RealismFlags;
}

export interface RealismFrameCapture {
  /** Video time (s) the frame was captured at, or the frame index for non-video sources. */
  t: number;
  frameIndex: number;
  output: HTMLCanvasElement;
  driver: HTMLCanvasElement;
  /** The persona layer with alpha, as composited (null when no persona was drawn). */
  overlay: HTMLCanvasElement | null;
  /** Smoothed driver landmarks in output-canvas pixels (478 × xy). */
  landmarks: Float32Array;
  /** Warp vertex positions actually used (478 × xy). */
  warpPositions: Float32Array;
  /** Landmarks re-detected on the output frame, in output-canvas pixels; null if none found. */
  outputLandmarks: Float32Array | null;
  /** True when the driver was drawn mirrored (webcam/clip); output detection un-mirrors to match. */
  mirror: boolean;
  mar: number;
  pose: HeadPose;
  isSpeaking: boolean;
  isSmiling: boolean;
  syntheticTeeth: boolean;
  keyframeId: string | null;
}

export interface RealismBurstFrame {
  t: number;
  frameIndex: number;
  output: HTMLCanvasElement;
  driver: HTMLCanvasElement;
  landmarks: Float32Array;
}

export interface RealismBurst {
  start: number;
  scale: number;
  frames: RealismBurstFrame[];
}

export type RealismBufferName = 'output' | 'overlay' | 'driver' | 'warp';

export interface RealismEngineDebugApi {
  getState(): RealismDebugState;
  /** Capture full-resolution frames when the video source passes each time (seconds, ascending). */
  scheduleCaptures(times: number[]): void;
  /** Capture `count` consecutive frames from `start` seconds on, downscaled by `scale`. */
  scheduleBurst(start: number, count: number, scale: number): void;
  pending(): { captures: number; burst: number };
  /** Returns captured frames (with output landmarks detected) and clears them. */
  drainCaptures(): Promise<RealismFrameCapture[]>;
  drainBurst(): RealismBurst | null;
  getBuffer(name: RealismBufferName): HTMLCanvasElement | null;
  getVideo(): HTMLVideoElement | null;
  resetPerf(): void;
  /** Runs the landmarker on a still image; returns 478 landmarks in image pixels, or null. */
  detectStill(image: HTMLImageElement | HTMLCanvasElement): Promise<Float32Array | null>;
}

/** What the app lets the debug surface do with its persona and settings state. */
export interface RealismAppHooks {
  addPersona(persona: AuthorizedPersona): void;
  activatePersona(persona: AuthorizedPersona): void;
  setSubjectCategory(category: PersonaCategory): void;
  getSettings(): TransformationSettings;
  updateSettings(patch: Partial<TransformationSettings>): void;
}

let enabledMemo: boolean | null = null;

/**
 * `?rf=` overrides are applied as soon as this module loads (the engine imports it), so flags that
 * act at construction time (webgl2) see them before the first engine is created.
 */
export function applyUrlFlagOverrides() {
  if (typeof location === 'undefined' || !isRealismDebugEnabled()) return;
  const overrides = parseRealismFlagsFromSearch(location.search);
  if (Object.keys(overrides).length) realismFlags.set(overrides);
}

export function isRealismDebugEnabled(): boolean {
  if (enabledMemo !== null) return enabledMemo;
  let on = false;
  try {
    on = Boolean(import.meta.env?.DEV);
    if (!on && typeof location !== 'undefined') on = new URLSearchParams(location.search).has('realism');
  } catch {
    on = false;
  }
  enabledMemo = on;
  return on;
}

// --- Engine registry ------------------------------------------------------------------------------

type EngineListener = (api: RealismEngineDebugApi | null) => void;
let activeEngine: RealismEngineDebugApi | null = null;
const engineListeners = new Set<EngineListener>();

export function setRealismEngine(api: RealismEngineDebugApi | null) {
  activeEngine = api;
  for (const l of engineListeners) l(api);
}

export function getRealismEngine(): RealismEngineDebugApi | null {
  return activeEngine;
}

export function subscribeRealismEngine(listener: EngineListener): () => void {
  engineListeners.add(listener);
  listener(activeEngine);
  return () => engineListeners.delete(listener);
}

// --- Window hook ----------------------------------------------------------------------------------

/** Serialised form of a capture, safe to hand to Playwright. */
export interface SerializedCapture {
  t: number;
  frameIndex: number;
  outputPng: string;
  driverPng: string;
  overlayPng: string | null;
  landmarks: number[];
  warpPositions: number[];
  outputLandmarks: number[] | null;
  mar: number;
  pose: HeadPose;
  isSpeaking: boolean;
  isSmiling: boolean;
  syntheticTeeth: boolean;
  keyframeId: string | null;
}

export interface SerializedBurst {
  start: number;
  scale: number;
  frames: Array<{ t: number; frameIndex: number; outputPng: string; driverPng: string; landmarks: number[] }>;
}

export interface LoadPersonaSpec {
  name: string;
  category: PersonaCategory;
  /** Image as a data URL (PNG/JPEG/WebP). */
  dataUrl: string;
  id?: string;
  role?: string;
}

export interface RealismWindowHook {
  version: 2;
  flags: {
    defs: typeof REALISM_FLAG_DEFS;
    get(): RealismFlags;
    set(patch: Partial<RealismFlags>): string[];
    reset(): string[];
    describe(): string;
  };
  hasEngine(): boolean;
  state(): RealismDebugState | null;
  scheduleCaptures(times: number[]): boolean;
  scheduleBurst(start: number, count: number, scale: number): boolean;
  pending(): { captures: number; burst: number } | null;
  takeCaptures(): Promise<SerializedCapture[]>;
  takeBurst(): SerializedBurst | null;
  resetPerf(): void;
  video(): { currentTime: number; duration: number; paused: boolean; ended: boolean; readyState: number } | null;
  seek(time: number): Promise<boolean>;
  play(): Promise<boolean>;
  pause(): boolean;
  /** Landmarks (image pixels, 478 × xy) of a still image given as a data URL, or null. */
  detectImage(dataUrl: string): Promise<{ width: number; height: number; landmarks: number[] } | null>;
  /** Adds a persona from an image and makes it active (test personas for the review grid). */
  loadPersona(spec: LoadPersonaSpec): Promise<string>;
  /** Transformation settings of the app (the inspector's sliders and switches). */
  settings: { get(): TransformationSettings | null; set(patch: Partial<TransformationSettings>): boolean };
}

declare global {
  interface Window {
    __personaLiveRealism?: RealismWindowHook;
  }
}

function png(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image could not be decoded'));
    img.src = src;
  });
}

let appHooks: RealismAppHooks | null = null;

/**
 * Installs `window.__personaLiveRealism` once and applies `?rf=` flag overrides from the URL.
 * Calling it again only refreshes the app hooks.
 */
export function installRealismWindowHook(app?: RealismAppHooks): RealismWindowHook | null {
  if (typeof window === 'undefined' || !isRealismDebugEnabled()) return null;
  if (app) {
    appHooks = app;
    // `?rs=` settings overrides apply once the app can take them.
    const overrides = parseSettingsFromSearch(location.search);
    if (Object.keys(overrides).length) app.updateSettings(overrides);
  }
  if (window.__personaLiveRealism) return window.__personaLiveRealism;

  const overrides = parseRealismFlagsFromSearch(location.search);
  if (Object.keys(overrides).length) realismFlags.set(overrides);

  const hook: RealismWindowHook = {
    version: 2,
    flags: {
      defs: REALISM_FLAG_DEFS,
      get: () => realismFlags.get(),
      set: (patch) => realismFlags.set(patch),
      reset: () => realismFlags.reset(),
      describe: () => describeRealismFlags(realismFlags.get()),
    },
    hasEngine: () => activeEngine !== null,
    state: () => activeEngine?.getState() ?? null,
    scheduleCaptures: (times) => {
      if (!activeEngine) return false;
      activeEngine.scheduleCaptures(times);
      return true;
    },
    scheduleBurst: (start, count, scale) => {
      if (!activeEngine) return false;
      activeEngine.scheduleBurst(start, count, scale);
      return true;
    },
    pending: () => activeEngine?.pending() ?? null,
    takeCaptures: async () => {
      if (!activeEngine) return [];
      const captures = await activeEngine.drainCaptures();
      return captures.map((c) => ({
        t: c.t,
        frameIndex: c.frameIndex,
        outputPng: png(c.output),
        driverPng: png(c.driver),
        overlayPng: c.overlay ? png(c.overlay) : null,
        landmarks: Array.from(c.landmarks),
        warpPositions: Array.from(c.warpPositions),
        outputLandmarks: c.outputLandmarks ? Array.from(c.outputLandmarks) : null,
        mar: c.mar,
        pose: c.pose,
        isSpeaking: c.isSpeaking,
        isSmiling: c.isSmiling,
        syntheticTeeth: c.syntheticTeeth,
        keyframeId: c.keyframeId,
      }));
    },
    takeBurst: () => {
      const burst = activeEngine?.drainBurst();
      if (!burst) return null;
      return {
        start: burst.start,
        scale: burst.scale,
        frames: burst.frames.map((f) => ({
          t: f.t,
          frameIndex: f.frameIndex,
          outputPng: png(f.output),
          driverPng: png(f.driver),
          landmarks: Array.from(f.landmarks),
        })),
      };
    },
    resetPerf: () => activeEngine?.resetPerf(),
    video: () => {
      const v = activeEngine?.getVideo();
      if (!v) return null;
      return { currentTime: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended, readyState: v.readyState };
    },
    seek: (time) =>
      new Promise((resolve) => {
        const v = activeEngine?.getVideo();
        if (!v) return resolve(false);
        const done = () => {
          v.removeEventListener('seeked', done);
          resolve(true);
        };
        v.addEventListener('seeked', done);
        v.currentTime = time;
      }),
    play: async () => {
      const v = activeEngine?.getVideo();
      if (!v) return false;
      await v.play();
      return true;
    },
    pause: () => {
      const v = activeEngine?.getVideo();
      if (!v) return false;
      v.pause();
      return true;
    },
    detectImage: async (dataUrl) => {
      if (!activeEngine) return null;
      const img = await loadImage(dataUrl);
      const landmarks = await activeEngine.detectStill(img);
      return landmarks ? { width: img.naturalWidth, height: img.naturalHeight, landmarks: Array.from(landmarks) } : null;
    },
    loadPersona: async (spec) => {
      if (!appHooks) throw new Error('the app has not registered its persona hooks');
      const img = await loadImage(spec.dataUrl);
      const id = spec.id ?? `persona-test-${spec.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
      const timestamp = new Date().toISOString();
      const persona: AuthorizedPersona = {
        id,
        name: spec.name,
        role: spec.role ?? 'Review test persona',
        category: spec.category,
        imageUrl: spec.dataUrl,
        createdAt: timestamp.slice(0, 10),
        qualityScore: 0,
        metrics: {
          resolution: `${img.naturalWidth} × ${img.naturalHeight} px`,
          sharpness: 0,
          lighting: 'Acceptable',
          orientation: 'Frontal',
          obstruction: 'None',
          singleFaceVerified: true,
        },
        consent: {
          signerName: 'synthetic test persona (no real person)',
          authorizedUsage: 'Realism review only',
          timestamp,
          signatureHash: 'REVIEW-TEST-PERSONA',
          verified: true,
        },
      };
      appHooks.setSubjectCategory(spec.category);
      appHooks.addPersona(persona);
      appHooks.activatePersona(persona);
      return id;
    },
    settings: {
      get: () => appHooks?.getSettings() ?? null,
      set: (patch) => {
        if (!appHooks) return false;
        appHooks.updateSettings(patch);
        return true;
      },
    },
  };
  window.__personaLiveRealism = hook;
  return hook;
}

applyUrlFlagOverrides();

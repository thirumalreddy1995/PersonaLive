/**
 * Real-time facial transformation engine.
 *
 * Pipeline per frame:
 *   1. Acquire a source frame (live webcam, or the built-in demo subject).
 *   2. Track 478 facial landmarks with MediaPipe Face Landmarker (GPU/WASM).
 *   3. Smooth landmarks with per-coordinate 1-Euro filters (user-tunable).
 *   4. Derive kinematics (EAR, MAR, head pose, gaze) and expression state from blendshapes.
 *   5. Warp the authorized persona portrait onto the live face mesh (GPU piecewise-affine warp)
 *      with edge feathering, lighting adaptation and optional real-eye pass-through.
 *   6. Composite into the selected view mode and stamp the mandatory AI-transformed watermark.
 */
import { AuthorizedPersona, EngineStatus, FacialMetrics, HeadPose, TransformationSettings } from '../types/index.ts';
import { OneEuroFilter } from './faceMath.ts';
import { RigidPoseStabilizer, StabilizerOptions, poseAngles } from './rigidPose.ts';
import { cropUvs, planCrop } from './personaCrop.ts';
import { delightPersona } from './personaDelight.ts';
import { CameraMatchState, initialCameraMatch, stepCameraMatch, CAMERA_MATCH_WARM_UPDATES, cameraMatchDue } from './cameraMatch.ts';
import { RestMouthCalibrator, lipFadeWindow } from './restMouth.ts';
import {
  applyEyelidKinematics,
  eyeFadeWeights,
  lipFadeForMar,
  applyGazeIrisTracking,
  applyPerspectiveForeshortening,
  applySmileBias,
  applySpeechAnatomy,
  buildFaceTopology,
  computeKinematics,
  FaceTopology,
  LandmarkKinematics,
  LM,
  pointBounds,
  smoothingToFilterParams,
  clamp,
} from './faceMesh.ts';
import {
  FaceTracker,
  FACE_LEFT_IRIS,
  FACE_OVAL,
  FACE_RIGHT_IRIS,
  FACE_TESSELLATION,
  TrackedFace,
} from './faceTracker.ts';
import { FacialLightingZones, MeshWarpRenderer, readbackWindow } from './meshWarpRenderer.ts';
import { OralCavityRenderer, extractOralApertureMetrics } from './oralCavityRenderer.ts';
import { MultiReferenceBank } from './multiReferenceBank.ts';
import { CranialBoundaryBlender } from './cranialBoundaryBlender.ts';
import { WATERMARK_TEXT, watermarkMetrics } from './watermark.ts';
import { realismFlags } from '../realism/flags.ts';
import { FrameProfiler } from '../realism/profiler.ts';
import {
  isRealismDebugEnabled,
  RealismBurst,
  RealismBufferName,
  RealismDebugState,
  RealismEngineDebugApi,
  RealismFrameCapture,
  setRealismEngine,
} from '../realism/debug.ts';

export type MetricsCallback = (metrics: FacialMetrics, pose: HeadPose, fps: number, latency: number) => void;
export type StatusCallback = (status: EngineStatus) => void;

const LANDMARK_COUNT = 478;
const RESOLUTIONS: Record<TransformationSettings['outputResolution'], [number, number]> = {
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '540p': [960, 540],
};

/** Output size for a resolution setting, defaulting to 720p for unexpected values. */
function resolveResolution(resolution: TransformationSettings['outputResolution']): [number, number] {
  return RESOLUTIONS[resolution] ?? RESOLUTIONS['720p'];
}

/** Portrait used as the stand-in subject when no webcam is connected. */
export const DEMO_SUBJECT_URL =
  'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=1280&q=80';

interface SourceLayout {
  offsetX: number;
  offsetY: number;
  drawWidth: number;
  drawHeight: number;
  mirror: boolean;
}

/** Rigid-pose stabiliser options from the settings the user or the capture tool can set. */
function rigidOptions(s: TransformationSettings): StabilizerOptions {
  return { poseMinCutoff: s.rigidPoseMinCutoff, poseBeta: s.rigidPoseBeta, learnShape: s.rigidShapeOffset };
}

/** Share of one frame's head displacement the directional motion blur spans (realism flag motionBlur). */
const MOTION_BLUR_EXPOSURE = 0.5;
/** Steady camera match holds its estimate while the head moves faster than this share of face width per frame. */
const CAMERA_MATCH_HOLD_SPEED = 0.015;
const IDENTITY_GAIN: [number, number, number] = [1, 1, 1];

export class RealtimeFacialEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tracker = new FaceTracker();
  private warp: MeshWarpRenderer;
  private topology: FaceTopology;

  // Sources
  private videoElement: HTMLVideoElement | null = null;
  private videoKind: 'webcam' | 'file' = 'webcam';
  private demoImage: HTMLImageElement | null = null;
  private demoFailed = false;
  private demoCanvas: HTMLCanvasElement;
  private demoCtx: CanvasRenderingContext2D;

  // Persona & Identity Bank
  private personaId: string | null = null;
  private personaImage: HTMLImageElement | null = null;
  private personaMean: [number, number, number] = [128, 128, 128];
  private personaPrepareToken = 0;
  private referenceBank = new MultiReferenceBank();
  private currentKeyframeSource: CanvasImageSource | null = null;
  /** Id of the reference keyframe whose UVs are currently uploaded to the warp renderer. */
  private currentKeyframeId: string | null = null;

  // Tracking state
  private filters: OneEuroFilter[] = [];
  private smoothed = new Float32Array(LANDMARK_COUNT * 2);
  private warpPositions = new Float32Array(LANDMARK_COUNT * 2);
  private lastFace: TrackedFace | null = null;
  private faceVisible = false;
  private framesSinceFace = 0;
  private neutralMouthWidth: number | null = null;

  // Lighting adaptation
  private samplerCanvas: HTMLCanvasElement;
  private samplerCtx: CanvasRenderingContext2D;
  /** Transparent copy of the warp output; alpha-only boundary passes run here before compositing. */
  private overlayLayer: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;
  private colorGain: [number, number, number] = [1, 1, 1];
  private zoneLighting: FacialLightingZones = {
    forehead: [1, 1, 1],
    leftCheek: [1, 1, 1],
    rightCheek: [1, 1, 1],
    nose: [1, 1, 1],
    chin: [1, 1, 1],
  };
  private frameIndex = 0;
  /** frameIndex when the debug counters were last reset, so framesRendered is per replay. */
  private frameIndexAtReset = 0;

  // Where the transformed pane sits on the canvas (used to place the mesh overlay)
  private paneTransform = { x: 0, y: 0, scale: 1 };

  // Loop & settings
  private isRunning = false;
  private disposed = false;
  private animationFrameId: number | null = null;
  private settings: TransformationSettings;
  private splitPosition = 50;

  // Telemetry
  private frameCount = 0;
  private lastFpsCalcTime = performance.now();
  private currentFps = 0;
  private latencyHistory: number[] = [];

  // Status
  private status: EngineStatus = {
    model: 'idle',
    modelProgress: 0,
    modelMessage: 'Face tracking not started',
    backend: '-',
    renderer: 'webgl',
    source: 'none',
    faceDetected: false,
    persona: 'none',
  };
  private lastStatusJson = '';

  private onMetricsUpdate?: MetricsCallback;
  private onStatusUpdate?: StatusCallback;

  // Realism review instrumentation (stage timings always; captures only when the debug hook asks)
  private profiler = new FrameProfiler();
  private flagsUnsubscribe: (() => void) | null = null;
  private lastMetrics: FacialMetrics | null = null;
  private lastPose: HeadPose = { yaw: 0, pitch: 0, roll: 0 };
  private lastMar = 0;
  /** Rigid-pose stabiliser for the upper face (realism flag rigidForehead). */
  private readonly rigid = new RigidPoseStabilizer();
  /** Raw (unsmoothed) tracked landmarks in canvas pixels, fed to the stabiliser. */
  private readonly rawPx = new Float32Array(LANDMARK_COUNT * 2);
  /** Camera-match loop (realism flag cameraMatch). */
  private cameraMatch: CameraMatchState = initialCameraMatch();
  private cameraMatchPending = false;
  /** Blur bias after each loop update, for the review tool's trace (R3 item 3). */
  private cameraMatchTrace: number[] = [];
  /** Warm-start updates still to run on consecutive frames (R3b). */
  private cameraMatchWarm = 0;
  /** How often the 5-zone CPU lighting gain ran (0 with the default flags on a WebGL machine). */
  private lightingGainUpdates = 0;
  /** Max/min of the de-light shading field fitted on the current persona (flag personaDelight). */
  private personaDelightRange: number | null = null;
  /** Resting mouth aperture learned from frontal frames (realism flag restMouth, R3 item 1). */
  private restMouth = new RestMouthCalibrator();
  /** Smoothed screen velocity of the face (canvas px per frame) for motion blur and the steady camera match. */
  private headVelocity = { x: 0, y: 0 };
  private prevHeadCenter: { x: number; y: number } | null = null;
  /** Lip-band fade applied on the last frame (debug panel). */
  private lastLipFade = 0;
  private overlayDrawnThisFrame = false;
  private syntheticTeethThisFrame = false;
  private syntheticTeethFrames = 0;
  private captureTimes: number[] = [];
  private captures: RealismFrameCapture[] = [];
  private burstPlan: { start: number; count: number; scale: number } | null = null;
  private burst: RealismBurst | null = null;

  constructor(canvas: HTMLCanvasElement, settings: TransformationSettings) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not get 2D context from canvas');
    this.ctx = context;
    this.settings = settings;

    const [w, h] = resolveResolution(settings.outputResolution);
    canvas.width = w;
    canvas.height = h;

    this.topology = buildFaceTopology(FACE_TESSELLATION, FACE_OVAL, 468);
    this.warp = new MeshWarpRenderer(w, h, realismFlags.get().webgl2);
    this.warp.setTopology(this.topology);
    this.warp.setEyeFade(eyeFadeWeights(this.topology, settings.eyePassThroughRadius));
    this.rigid.configure(rigidOptions(settings));
    this.status.renderer = this.warp.usesWebGL2 ? 'webgl2' : this.warp.usesWebGL ? 'webgl' : 'canvas2d';

    this.demoCanvas = document.createElement('canvas');
    this.demoCanvas.width = 1280;
    this.demoCanvas.height = 720;
    this.demoCtx = this.demoCanvas.getContext('2d')!;

    this.samplerCanvas = document.createElement('canvas');
    this.samplerCanvas.width = 24;
    this.samplerCanvas.height = 24;
    this.samplerCtx = this.samplerCanvas.getContext('2d', { willReadFrequently: true })!;

    this.overlayLayer = document.createElement('canvas');
    this.overlayLayer.width = w;
    this.overlayLayer.height = h;
    const overlayContext = this.overlayLayer.getContext('2d');
    if (!overlayContext) throw new Error('Could not get 2D context for the overlay layer');
    this.overlayCtx = overlayContext;

    const params = smoothingToFilterParams(settings.temporalSmoothing);
    for (let i = 0; i < LANDMARK_COUNT * 2; i++) {
      this.filters.push(new OneEuroFilter(params.minCutoff, params.beta, 1.0));
    }

    // Flags that change how the persona is prepared take effect by re-preparing it.
    this.flagsUnsubscribe = realismFlags.subscribe((_flags, changed) => {
      if ((changed.includes('syntheticSuite') || changed.includes('personaCrop') || changed.includes('personaDelight')) && this.personaImage) void this.preparePersona();
      if (changed.includes('cameraMatch')) {
        this.cameraMatch = initialCameraMatch();
        this.cameraMatchTrace = [];
      }
    });
    if (isRealismDebugEnabled()) {
      this.profiler.measure = true;
      setRealismEngine(this.createDebugApi());
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------

  public setCallbacks(onMetrics: MetricsCallback, onStatus: StatusCallback) {
    this.onMetricsUpdate = onMetrics;
    this.onStatusUpdate = onStatus;
    this.emitStatus(true);
  }

  /** Loads the tracking runtime + model. Safe to call multiple times. */
  public async init(): Promise<void> {
    if (this.status.model === 'ready' || this.status.model === 'loading') return;
    this.patchStatus({ model: 'loading', modelProgress: 0 });
    try {
      await this.tracker.load((p) => {
        if (!this.disposed) this.patchStatus({ modelProgress: p.progress, modelMessage: p.message });
      });
      if (this.disposed) return;
      this.patchStatus({ model: 'ready', modelProgress: 1, backend: this.tracker.backend, modelMessage: 'Face tracking ready' });
      // Persona may have been selected while the model was still loading.
      if (this.personaImage && this.status.persona !== 'ready') void this.preparePersona();
    } catch (err) {
      if (this.disposed) return;
      console.error('Face tracker failed to load', err);
      this.patchStatus({
        model: 'error',
        modelMessage: err instanceof Error ? err.message : 'Face tracking engine failed to load',
      });
    }
  }

  /**
   * Uses a video element as the driver. `kind` is 'webcam' for a live camera stream or 'file' for a
   * replayable clip (dev-only realism review); both are shown mirrored like a webcam preview.
   */
  public setVideoSource(video: HTMLVideoElement | null, kind: 'webcam' | 'file' = 'webcam') {
    this.videoElement = video;
    this.videoKind = kind;
    this.resetTracking();
    // R3b: a new source gets a neutral camera match that re-measures on the first frames.
    this.cameraMatch = initialCameraMatch();
    this.cameraMatchPending = false;
    this.cameraMatchWarm = CAMERA_MATCH_WARM_UPDATES;
    this.captureTimes = [];
    this.burstPlan = null;
    this.patchStatus({ source: video ? kind : this.demoImage ? 'demo' : 'none' });
  }

  /** Loads the demo subject portrait used when no webcam is active. */
  public loadDemoSubject(url: string = DEMO_SUBJECT_URL) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.disposed) return;
      this.demoImage = img;
      this.demoFailed = false;
      if (!this.videoElement) this.patchStatus({ source: 'demo' });
    };
    img.onerror = () => {
      if (this.disposed) return;
      this.demoFailed = true;
      if (!this.videoElement) this.patchStatus({ source: 'none' });
    };
    img.src = url;
  }

  public setPersona(persona: AuthorizedPersona | null) {
    this.personaPrepareToken++;
    if (!persona) {
      this.personaId = null;
      this.personaImage = null;
      this.currentKeyframeId = null;
      this.warp.clearPersona();
      this.patchStatus({ persona: 'none' });
      return;
    }
    if (persona.id === this.personaId && this.status.persona === 'ready') return;
    this.personaId = persona.id;
    this.patchStatus({ persona: 'preparing' });

    const token = this.personaPrepareToken;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.disposed || token !== this.personaPrepareToken) return;
      this.personaImage = img;
      void this.preparePersona();
    };
    img.onerror = () => {
      if (this.disposed || token !== this.personaPrepareToken) return;
      this.patchStatus({ persona: 'error', personaMessage: 'Could not load the persona photo.' });
    };
    img.src = persona.imageUrl;
  }

  public updateSettings(settings: TransformationSettings) {
    const prev = this.settings;
    this.settings = settings;
    if (prev.temporalSmoothing !== settings.temporalSmoothing) {
      const p = smoothingToFilterParams(settings.temporalSmoothing);
      for (const f of this.filters) f.setParams(p.minCutoff, p.beta);
    }
    if (prev.outputResolution !== settings.outputResolution) {
      const [w, h] = resolveResolution(settings.outputResolution);
      this.canvas.width = w;
      this.canvas.height = h;
      this.overlayLayer.width = w;
      this.overlayLayer.height = h;
      this.warp.resize(w, h);
      this.resetTracking();
    }
    if (prev.lightingAdaptation && !settings.lightingAdaptation) this.colorGain = [1, 1, 1];
    if (prev.eyePassThroughRadius !== settings.eyePassThroughRadius) {
      this.warp.setEyeFade(eyeFadeWeights(this.topology, settings.eyePassThroughRadius));
    }
    if (prev.personaTextureSize !== settings.personaTextureSize && this.personaImage && realismFlags.get().personaCrop) {
      void this.preparePersona();
    }
    if (
      prev.rigidPoseMinCutoff !== settings.rigidPoseMinCutoff ||
      prev.rigidPoseBeta !== settings.rigidPoseBeta ||
      prev.rigidShapeOffset !== settings.rigidShapeOffset
    ) {
      this.rigid.configure(rigidOptions(settings));
    }
  }

  public setSplitPosition(position: number) {
    this.splitPosition = position;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastFpsCalcTime = performance.now();
    this.frameCount = 0;
    this.loop();
  }

  public stop() {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  public dispose() {
    this.disposed = true;
    this.personaPrepareToken++;
    this.stop();
    this.flagsUnsubscribe?.();
    this.flagsUnsubscribe = null;
    if (isRealismDebugEnabled()) setRealismEngine(null);
    this.tracker.dispose();
    this.warp.dispose();
  }

  public getStatus(): EngineStatus {
    return this.status;
  }

  // ---------------------------------------------------------------------------------------------
  // Persona preparation
  // ---------------------------------------------------------------------------------------------

  private async preparePersona() {
    const img = this.personaImage;
    if (!img || !this.tracker.ready) return;
    const token = this.personaPrepareToken;
    try {
      const { faces } = await this.tracker.detectImage(img);
      if (this.disposed || token !== this.personaPrepareToken) return;
      if (faces.length === 0) {
        this.warp.clearPersona();
        this.patchStatus({
          persona: 'no-face',
          personaMessage: 'No face was found in this persona photo. Use a clear, front-facing portrait.',
        });
        return;
      }
      const face = faces[0];
      // R2 §2: crop to the face oval × 1.6, cap the long edge, recompute UVs (flag personaCrop).
      let texture: HTMLImageElement | HTMLCanvasElement = img;
      let uv = face.landmarks;
      if (realismFlags.get().personaCrop) {
        const plan = planCrop(face.landmarks, img.naturalWidth, img.naturalHeight, this.settings.personaTextureSize);
        const crop = document.createElement('canvas');
        crop.width = plan.width;
        crop.height = plan.height;
        const cctx = crop.getContext('2d')!;
        cctx.imageSmoothingEnabled = true;
        cctx.imageSmoothingQuality = 'high';
        cctx.drawImage(img, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
        texture = crop;
        uv = cropUvs(face.landmarks, img.naturalWidth, img.naturalHeight, plan);
      }
      // R3b (flag personaDelight): divide the photo's smooth shading field out of the skin.
      this.personaDelightRange = null;
      if (realismFlags.get().personaDelight) {
        const lit = document.createElement('canvas');
        lit.width = texture instanceof HTMLImageElement ? texture.naturalWidth : texture.width;
        lit.height = texture instanceof HTMLImageElement ? texture.naturalHeight : texture.height;
        const lctx = lit.getContext('2d', { willReadFrequently: true })!;
        lctx.drawImage(texture, 0, 0, lit.width, lit.height);
        const pixels = lctx.getImageData(0, 0, lit.width, lit.height);
        const pts = new Float32Array(468 * 2);
        for (let i = 0; i < 468; i++) {
          pts[i * 2] = uv[i * 2] * lit.width;
          pts[i * 2 + 1] = uv[i * 2 + 1] * lit.height;
        }
        const res = delightPersona(pixels.data, lit.width, lit.height, pts);
        if (res) {
          lctx.putImageData(pixels, 0, 0);
          texture = lit;
          this.personaDelightRange = res.range;
        }
      }
      this.warp.setPersona(texture, uv);
      this.currentKeyframeSource = texture;
      this.currentKeyframeId = null;
      this.cameraMatch = initialCameraMatch();
      this.cameraMatchTrace = [];
      this.cameraMatchPending = false;
      this.cameraMatchWarm = CAMERA_MATCH_WARM_UPDATES;
      this.personaMean = this.sampleMeanColor(img, face.landmarks, img.naturalWidth, img.naturalHeight, false);

      // Synthesize calibrated multi-angle, multi-expression identity suite for Person A.
      // With the syntheticSuite flag off the bank stays empty and the warp uses the one real photo.
      this.referenceBank.clear();
      if (realismFlags.get().syntheticSuite) {
        const suite = MultiReferenceBank.synthesizeSuiteFromMaster(img, face.landmarks, this.personaMean);
        for (const kf of suite) {
          this.referenceBank.addKeyframe(kf);
        }
      }

      this.patchStatus({
        persona: 'ready',
        personaMessage: faces.length > 1 ? 'Multiple faces detected — using the most prominent one.' : undefined,
      });
    } catch (err) {
      if (this.disposed || token !== this.personaPrepareToken) return;
      console.error('Persona analysis failed', err);
      this.patchStatus({
        persona: 'error',
        personaMessage:
          'Persona photo could not be analysed. If this is a web image, its host may block cross-origin access.',
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------------------------

  private loop = () => {
    if (!this.isRunning) return;
    const frameStart = performance.now();
    try {
      this.renderFrame(frameStart);
    } catch (err) {
      console.error('Render frame failed', err);
    }
    const frameEnd = performance.now();
    this.profiler.frame(frameEnd - frameStart, frameEnd);

    this.latencyHistory.push(frameEnd - frameStart);
    if (this.latencyHistory.length > 30) this.latencyHistory.shift();

    this.frameCount++;
    if (frameEnd - this.lastFpsCalcTime >= 500) {
      this.currentFps = (this.frameCount * 1000) / (frameEnd - this.lastFpsCalcTime);
      this.frameCount = 0;
      this.lastFpsCalcTime = frameEnd;
    }
    this.animationFrameId = requestAnimationFrame(this.loop);
  };

  private getSource(): { source: HTMLVideoElement | HTMLCanvasElement; width: number; height: number; mirror: boolean } | null {
    const v = this.videoElement;
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      return { source: v, width: v.videoWidth, height: v.videoHeight, mirror: true };
    }
    if (this.demoImage) {
      this.drawDemoSubject(performance.now() / 1000);
      return { source: this.demoCanvas, width: this.demoCanvas.width, height: this.demoCanvas.height, mirror: false };
    }
    return null;
  }

  /** Renders the demo portrait with gentle head motion so tracking + warping are visibly live. */
  private drawDemoSubject(t: number) {
    const ctx = this.demoCtx;
    const img = this.demoImage!;
    const W = this.demoCanvas.width;
    const H = this.demoCanvas.height;
    const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight) * (1.06 + Math.sin(t * 0.45) * 0.03);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.save();
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2 + Math.sin(t * 0.6) * W * 0.02, H / 2 + Math.cos(t * 0.5) * H * 0.015);
    ctx.rotate(Math.sin(t * 0.35) * 0.025);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  public renderFrame(timestamp: number) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (W === 0 || H === 0) return;
    const ctx = this.ctx;
    const settings = this.settings;
    this.frameIndex++;

    const src = this.getSource();
    const layout: SourceLayout | null = src ? coverLayout(src.width, src.height, W, H, src.mirror) : null;
    const profiler = this.profiler;
    this.overlayDrawnThisFrame = false;
    this.syntheticTeethThisFrame = false;

    // --- 1. Track ---------------------------------------------------------------------------
    profiler.begin('track');
    let tracked: TrackedFace | null = null;
    if (src && this.tracker.ready) {
      tracked = this.tracker.detectVideo(src.source, timestamp);
    }
    profiler.end('track');
    if (tracked && layout) {
      this.ingestLandmarks(tracked.landmarks, layout, timestamp, tracked.transform);
      this.lastFace = tracked;
      this.faceVisible = true;
      this.framesSinceFace = 0;
    } else {
      this.framesSinceFace++;
      if (this.framesSinceFace > 12) {
        this.faceVisible = false;
        this.lastFace = null;
        this.resetFilters();
      }
    }
    if (this.status.faceDetected !== this.faceVisible) this.patchStatus({ faceDetected: this.faceVisible });

    // --- 2. Kinematics & metrics -------------------------------------------------------------
    // Derived once per frame and shared by the metrics and the persona overlay.
    profiler.begin('kinematics');
    const kinematics = this.faceVisible && this.lastFace ? computeKinematics(this.smoothed, this.neutralMouthWidth) : null;
    const { metrics, pose } = this.computeMetrics(kinematics);
    profiler.end('kinematics');
    this.lastMetrics = metrics;
    this.lastPose = pose;
    this.lastMar = kinematics?.mar ?? 0;
    if (kinematics && realismFlags.get().restMouth) this.restMouth.push(kinematics.mar, timestamp, kinematics.yaw, kinematics.pitch);

    // --- 3. Compose base frame --------------------------------------------------------------
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const drawBase = (x: number, y: number, w: number, h: number) => {
      if (src && layout) this.drawSource(ctx, src.source, layout, x, y, w, h);
      else this.drawStandby(ctx, x, y, w, h);
    };

    const overlayReady = !!(kinematics && this.faceVisible && this.lastFace && this.warp.hasPersona && this.status.persona === 'ready');
    if (overlayReady && kinematics && src && layout) {
      profiler.begin('warp');
      this.renderPersonaOverlay(layout, src.source, src.width, src.height, kinematics);
      profiler.end('warp');
      profiler.begin('overlay');
      this.composeOverlayLayer();
      profiler.end('overlay');
      this.overlayDrawnThisFrame = true;
    }
    const drawOverlay = (x: number, y: number, w: number, h: number) => {
      if (!overlayReady) return;
      ctx.drawImage(this.overlayLayer, 0, 0, W, H, x, y, w, h);
      profiler.begin('post');
      this.drawRealisticPostPass(ctx, x, y, w, h, metrics);
      profiler.end('post');
    };
    profiler.begin('composite');

    const splitPx = Math.max(20, Math.min(W - 20, (this.splitPosition / 100) * W));

    if (settings.viewMode === 'split') {
      drawBase(0, 0, W, H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitPx, 0, W - splitPx, H);
      ctx.clip();
      drawOverlay(0, 0, W, H);
      ctx.restore();
      this.drawSplitHandle(ctx, splitPx, W, H);
    } else if (settings.viewMode === 'side-by-side') {
      // Each pane shows the full frame scaled to fit half the canvas (same scale for base + overlay).
      const gap = 4;
      const paneW = (W - gap) / 2;
      const scale = Math.min(paneW / W, 1);
      const pw = W * scale;
      const ph = H * scale;
      const py = (H - ph) / 2;
      drawBase(0, py, pw, ph);
      drawBase(paneW + gap, py, pw, ph);
      drawOverlay(paneW + gap, py, pw, ph);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(paneW, 0, gap, H);
      this.drawLabel(ctx, 'LIVE CAMERA', 16, py + 16, '#94a3b8');
      this.drawLabel(ctx, '● AI TRANSFORMED', paneW + gap + 16, py + 16, '#38bdf8');
      this.paneTransform = { x: paneW + gap, y: py, scale };
    } else if (settings.viewMode === 'transformed-only') {
      drawBase(0, 0, W, H);
      drawOverlay(0, 0, W, H);
    } else if (settings.viewMode === 'pip') {
      drawBase(0, 0, W, H);
      drawOverlay(0, 0, W, H);
      const pipW = W * 0.26;
      const pipH = H * 0.26;
      const pipX = W - pipW - 20;
      const pipY = H - pipH - 56;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(pipX - 2, pipY - 2, pipW + 4, pipH + 4);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.strokeRect(pipX - 2, pipY - 2, pipW + 4, pipH + 4);
      ctx.beginPath();
      ctx.rect(pipX, pipY, pipW, pipH);
      ctx.clip();
      drawBase(pipX, pipY, pipW, pipH);
      ctx.restore();
      this.drawLabel(ctx, 'ORIGINAL', pipX + 8, pipY + 8, '#94a3b8');
    }
    if (settings.viewMode !== 'side-by-side') this.paneTransform = { x: 0, y: 0, scale: 1 };
    profiler.end('composite');

    // --- 4. Overlays --------------------------------------------------------------------------
    if (settings.showLandmarkOverlay && this.faceVisible) {
      const t = this.paneTransform;
      this.drawLandmarkMesh(ctx, t.x, t.y, t.scale);
      this.drawHeadPoseTripod(ctx, 40, H - 40, pose);
    }

    // Guardrail: the watermark is unconditional and always the last thing drawn.
    profiler.begin('watermark');
    this.drawMandatoryWatermark(ctx, W, H);
    profiler.end('watermark');

    if (this.syntheticTeethThisFrame) this.syntheticTeethFrames++;
    if (src && layout && (this.captureTimes.length || this.burstPlan)) this.handleCaptures(src, layout);

    // --- 5. Telemetry ---------------------------------------------------------------------------
    const avgLatency = this.latencyHistory.length
      ? this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length
      : 0;
    this.onMetricsUpdate?.(metrics, pose, Math.round(this.currentFps * 10) / 10, Math.round(avgLatency * 10) / 10);
  }

  // ---------------------------------------------------------------------------------------------
  // Tracking helpers
  // ---------------------------------------------------------------------------------------------

  private ingestLandmarks(normalized: Float32Array, layout: SourceLayout, timestamp: number, transform: number[] | null = null) {
    const n = Math.min(LANDMARK_COUNT, normalized.length / 2);
    for (let i = 0; i < n; i++) {
      let x = layout.offsetX + normalized[i * 2] * layout.drawWidth;
      const y = layout.offsetY + normalized[i * 2 + 1] * layout.drawHeight;
      if (layout.mirror) x = this.canvas.width - x;
      this.rawPx[i * 2] = x;
      this.rawPx[i * 2 + 1] = y;
      this.smoothed[i * 2] = this.filters[i * 2].filter(x, timestamp);
      this.smoothed[i * 2 + 1] = this.filters[i * 2 + 1].filter(y, timestamp);
    }
    // Rigid-pose forehead: the upper face follows the smoothed head pose instead of jittery points.
    if (realismFlags.get().rigidForehead && transform) {
      if (this.rigid.update(transform, this.rawPx, timestamp, layout.mirror)) this.rigid.apply(this.smoothed, timestamp);
    }
  }

  private resetFilters() {
    for (const f of this.filters) f.reset();
  }

  private resetTracking() {
    this.resetFilters();
    this.rigid.reset();
    this.restMouth.reset();
    this.prevHeadCenter = null;
    this.headVelocity = { x: 0, y: 0 };
    this.lastFace = null;
    this.faceVisible = false;
    this.framesSinceFace = 0;
    this.neutralMouthWidth = null;
    this.colorGain = [1, 1, 1];
    this.zoneLighting = {
      forehead: [1, 1, 1],
      leftCheek: [1, 1, 1],
      rightCheek: [1, 1, 1],
      nose: [1, 1, 1],
      chin: [1, 1, 1],
    };
    if (this.status.faceDetected) this.patchStatus({ faceDetected: false });
  }

  private computeMetrics(k: LandmarkKinematics | null): { metrics: FacialMetrics; pose: HeadPose } {
    const s = this.settings;
    if (!k || !this.faceVisible || !this.lastFace) {
      return {
        metrics: {
          eyeAspectRatioLeft: 0,
          eyeAspectRatioRight: 0,
          mouthAspectRatio: 0,
          mouthWidthRatio: 1,
          eyebrowElevation: 0,
          isBlinking: false,
          isSmiling: false,
          isSpeaking: false,
          gazeX: 0,
          gazeY: 0,
        },
        pose: { yaw: 0, pitch: 0, roll: 0 },
      };
    }
    const bs = this.lastFace.blendshapes;
    const mouthWidth = Math.hypot(
      this.smoothed[LM.MOUTH.cornerLeft * 2] - this.smoothed[LM.MOUTH.cornerRight * 2],
      this.smoothed[LM.MOUTH.cornerLeft * 2 + 1] - this.smoothed[LM.MOUTH.cornerRight * 2 + 1]
    );
    // Learn the neutral mouth width while the mouth is relaxed.
    if (k.mar < 0.05 && (bs.mouthSmileLeft ?? 0) < 0.2) {
      this.neutralMouthWidth = this.neutralMouthWidth === null ? mouthWidth : this.neutralMouthWidth * 0.98 + mouthWidth * 0.02;
    }

    const smileScore = ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2 + s.manualSmileBias * 0.6;
    const blinkScore = ((bs.eyeBlinkLeft ?? 0) + (bs.eyeBlinkRight ?? 0)) / 2;
    const speakingThreshold = 0.11 / Math.max(0.5, s.lipSyncSensitivity);
    const mar = k.mar * s.expressionGain;

    return {
      metrics: {
        eyeAspectRatioLeft: round3(k.earLeft),
        eyeAspectRatioRight: round3(k.earRight),
        mouthAspectRatio: round3(mar),
        mouthWidthRatio: round3(k.mouthWidthRatio),
        eyebrowElevation: round3(clamp(bs.browInnerUp ?? 0, 0, 1)),
        isBlinking: blinkScore > 0.5 || (k.earLeft + k.earRight) / 2 < 0.16,
        isSmiling: smileScore > 0.42,
        isSpeaking: mar > speakingThreshold,
        gazeX: round3(k.gazeX),
        gazeY: round3(k.gazeY),
      },
      pose: { yaw: k.yaw, pitch: k.pitch, roll: k.roll },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Persona overlay
  // ---------------------------------------------------------------------------------------------

  private renderPersonaOverlay(
    layout: SourceLayout,
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
    k: LandmarkKinematics
  ) {
    const s = this.settings;
    this.warpPositions.set(this.smoothed);

    // 1. Natural smile warmth bias
    if (s.manualSmileBias) {
      applySmileBias(this.warpPositions, s.manualSmileBias, k.faceWidth);
    }

    const flags = realismFlags.get();

    // 2. Anatomical speech constraints: stabilizes upper lip and mustache structure
    if (flags.speechAnatomy) applySpeechAnatomy(this.warpPositions, k.mar, k.faceHeight);

    // 3. 3D perspective foreshortening & multi-angle head pose compensation
    if (flags.perspectiveForeshortening) {
      applyPerspectiveForeshortening(
        this.warpPositions,
        k.yaw,
        k.pitch,
        k.faceWidth,
        k.faceHeight,
        k.center
      );
    }

    // 4. Eyelid kinematic blinking: folds persona's real eyelid skin down smoothly when blinking
    const bs = this.lastFace?.blendshapes ?? {};
    if (flags.eyelidKinematics) {
      applyEyelidKinematics(
        this.warpPositions,
        k.earLeft,
        k.earRight,
        bs.eyeBlinkLeft ?? 0,
        bs.eyeBlinkRight ?? 0
      );
    }

    // 5. Neural gaze tracking: translates iris landmarks according to real-time gaze
    if (s.eyeGazeSync) {
      applyGazeIrisTracking(this.warpPositions, k.gazeX, k.gazeY, k.faceWidth);
    }

    // 6. Multi-Conditioning Identity Bank Querying: aligns reference perspective & expression
    if (this.referenceBank.getKeyframes().length > 0) {
      const smileScore = ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2 + s.manualSmileBias * 0.6;
      const queryResult = this.referenceBank.query({
        yaw: k.yaw,
        pitch: k.pitch,
        roll: k.roll,
        mar: k.mar,
        smile: smileScore,
        browElevation: bs.browInnerUp ?? 0,
      });

      // UVs only change when the bank picks a different keyframe; skip the per-frame GPU upload otherwise.
      if (queryResult.primary.id !== this.currentKeyframeId) {
        this.warp.updateUVs(queryResult.primary.landmarks);
        this.currentKeyframeId = queryResult.primary.id;
      }
      if (queryResult.primary.source !== this.currentKeyframeSource) {
        this.warp.updateTexture(queryResult.primary.source);
        this.currentKeyframeSource = queryResult.primary.source;
      }
    }

    // R3 (flag relight): the shader relights from the real frame; the CPU zone gains stay off.
    const relightOn = flags.relight && s.lightingAdaptation && this.warp.supportsRelight;
    if (s.lightingAdaptation && !relightOn && this.frameIndex % 5 === 0) {
      this.updateLightingGain(layout, source, srcW, srcH);
    }

    // Head velocity (nose and cheeks), smoothed over ~2 frames.
    const hc = {
      x: (this.smoothed[LM.NOSE_TIP * 2] + this.smoothed[LM.LEFT_CHEEK * 2] + this.smoothed[LM.RIGHT_CHEEK * 2]) / 3,
      y: (this.smoothed[LM.NOSE_TIP * 2 + 1] + this.smoothed[LM.LEFT_CHEEK * 2 + 1] + this.smoothed[LM.RIGHT_CHEEK * 2 + 1]) / 3,
    };
    if (this.prevHeadCenter) {
      this.headVelocity.x += (hc.x - this.prevHeadCenter.x - this.headVelocity.x) * 0.5;
      this.headVelocity.y += (hc.y - this.prevHeadCenter.y - this.headVelocity.y) * 0.5;
    }
    this.prevHeadCenter = hc;
    const headSpeed = Math.hypot(this.headVelocity.x, this.headVelocity.y);

    const bounds = pointBounds(this.warpPositions.subarray(0, 468 * 2));
    const strength = clamp(s.blendStrength / 100, 0, 1);
    const drawPersonaEyes = !s.eyeGazeSync || (k.earLeft < 0.18 && k.earRight < 0.18);
    // "Keep my real mouth": fade the persona lip band as the mouth opens (R1 §2); with restMouth
    // (R3 item 1) the thresholds sit above the wearer's learned resting aperture.
    const fadeWindow = lipFadeWindow(flags.restMouth ? this.restMouth.rest : null);
    const lipFade = flags.realMouth && s.keepRealMouth ? lipFadeForMar(k.mar, 0, fadeWindow.start, fadeWindow.end) : 0;
    // Eye pass-through ring: only while the wearer's real eyes are showing (R1 §6).
    const eyeFade = flags.eyePassThrough && !drawPersonaEyes ? 1 : 0;
    // Closed-lip mask (R2): persona lips end at the wearer's lip contour while the mouth is closed.
    const closedLipMask = flags.closedLipMask && s.keepRealMouth ? 1 : 0;
    this.lastLipFade = lipFade;

    const cameraMatchOn = flags.cameraMatch && this.warp.supportsReadback;
    this.warp.pollReadbacks();
    this.warp.render({
      positions: this.warpPositions,
      opacity: Math.pow(strength, 0.55),
      colorGain: relightOn ? IDENTITY_GAIN : this.colorGain,
      zoneLighting: relightOn ? undefined : this.zoneLighting,
      faceBounds: [bounds.minX, bounds.minY, bounds.width, bounds.height],
      drawPersonaEyes,
      lipFade,
      eyeFade,
      closedLipMask,
      shader: { unsharp: flags.shaderUnsharp, subsurface: flags.shaderSubsurface, sebum: flags.shaderSebum },
      cameraMatch: cameraMatchOn
        ? { lodBias: this.cameraMatch.lodBias, sharpen: this.cameraMatch.sharpen, noiseSigma: this.cameraMatch.noiseSigma, frame: this.frameIndex }
        : undefined,
      relight: relightOn
        ? {
            source: source as TexImageSource,
            srcMap: [layout.offsetX, layout.offsetY, layout.drawWidth, layout.drawHeight],
            mirror: layout.mirror,
            faceWidthPx: k.faceWidth,
            toneMatch: clamp(s.skinToneMatch, 0, 1),
            radiusShare: clamp(s.relightRadius, 0.02, 0.2),
            globalTone: flags.relightGlobalTone,
            shadowGuard: flags.relightShadowGuard,
          }
        : undefined,
      motionBlurPx: flags.motionBlur ? [this.headVelocity.x * MOTION_BLUR_EXPOSURE, -this.headVelocity.y * MOTION_BLUR_EXPOSURE] : undefined,
      softHoles: flags.softHoles,
    });

    // R2 §4: every 15 frames read the wearer's and the persona's face-region statistics back
    // asynchronously and step the control loop when both have arrived.
    if (cameraMatchOn && !this.cameraMatchPending && cameraMatchDue(this.frameIndex, this.cameraMatchWarm)) {
      this.cameraMatchPending = true;
      const faceRect: [number, number, number, number] = [bounds.minX, bounds.minY, bounds.width, bounds.height];
      // The same face box in normalized source coordinates (un-mirrored).
      let sx0 = (bounds.minX - layout.offsetX) / layout.drawWidth;
      let sx1 = (bounds.minX + bounds.width - layout.offsetX) / layout.drawWidth;
      if (layout.mirror) {
        const m0 = 1 - sx1;
        const m1 = 1 - sx0;
        sx0 = m0;
        sx1 = m1;
      }
      const sy0 = (bounds.minY - layout.offsetY) / layout.drawHeight;
      const sy1 = (bounds.minY + bounds.height - layout.offsetY) / layout.drawHeight;
      const srcRect: [number, number, number, number] = [clamp(sx0, 0, 1), clamp(sy0, 0, 1), clamp(sx1 - sx0, 0.01, 1), clamp(sy1 - sy0, 0.01, 1)];
      const token = this.personaPrepareToken;
      const steady = flags.steadyCameraMatch;
      const hold = steady && headSpeed > CAMERA_MATCH_HOLD_SPEED * k.faceWidth;
      // Both readbacks sample the same square window of display pixels at 1:1, so the loop sees
      // the single-pixel band the camera blur removes (the band the review metric measures).
      const win = readbackWindow(bounds.width, bounds.height);
      const output = this.warp.readFaceStats(faceRect);
      const driver = this.warp.readSourceFaceStats(source as TexImageSource, srcRect, [win / layout.drawWidth, win / layout.drawHeight]);
      void Promise.all([driver, output]).then(([d, o]) => {
        this.cameraMatchPending = false;
        if (this.disposed || token !== this.personaPrepareToken || !d || !o) return;
        this.cameraMatch = stepCameraMatch(this.cameraMatch, d, o, 0.35, { steady, hold });
        if (this.cameraMatchWarm > 0) this.cameraMatchWarm--;
        if (this.cameraMatchTrace.length >= 1024) this.cameraMatchTrace.shift();
        this.cameraMatchTrace.push(this.cameraMatch.lodBias);
      });
    }
  }

  /**
   * Copies the warp output onto the transparent overlay layer and runs the alpha-only boundary
   * passes there. `destination-out` on this layer erases persona alpha so the driver's hairline
   * shows through after compositing; on the opaque output canvas it would only darken pixels.
   */
  private composeOverlayLayer() {
    const octx = this.overlayCtx;
    const W = this.overlayLayer.width;
    const H = this.overlayLayer.height;
    octx.clearRect(0, 0, W, H);
    octx.drawImage(this.warp.canvas, 0, 0, W, H);
    const flags = realismFlags.get();
    if (flags.foreheadHarmonize) CranialBoundaryBlender.harmonizeForeheadBoundary(octx, this.warpPositions);
    if (flags.hairlineSoften) CranialBoundaryBlender.softenHairlineEdges(octx, this.warpPositions);
  }

  /** Estimates the wearer's facial skin tone across 5 spatial zones and derives lighting gains. */
  private updateLightingGain(layout: SourceLayout, source: CanvasImageSource, srcW: number, srcH: number) {
    this.lightingGainUpdates++;
    const n = 468;
    const srcPts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let x = this.smoothed[i * 2];
      if (layout.mirror) x = this.canvas.width - x;
      srcPts[i * 2] = ((x - layout.offsetX) / layout.drawWidth) * srcW;
      srcPts[i * 2 + 1] = ((this.smoothed[i * 2 + 1] - layout.offsetY) / layout.drawHeight) * srcH;
    }

    const b = pointBounds(srcPts.subarray(0, 468 * 2));
    const size = 24;
    const sctx = this.samplerCtx;
    try {
      sctx.clearRect(0, 0, size, size);
      sctx.drawImage(source, b.minX, b.minY, Math.max(1, b.width), Math.max(1, b.height), 0, 0, size, size);
      const data = sctx.getImageData(0, 0, size, size).data;

      const samplePatch = (cx: number, cy: number, rad: number): [number, number, number] => {
        let pr = 0;
        let pg = 0;
        let pb = 0;
        let pcount = 0;
        for (let py = Math.max(0, cy - rad); py <= Math.min(size - 1, cy + rad); py++) {
          for (let px = Math.max(0, cx - rad); px <= Math.min(size - 1, cx + rad); px++) {
            const idx = (py * size + px) * 4;
            pr += data[idx];
            pg += data[idx + 1];
            pb += data[idx + 2];
            pcount++;
          }
        }
        return pcount ? [pr / pcount, pg / pcount, pb / pcount] : [128, 128, 128];
      };

      const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const computeGain = (sampleRGB: [number, number, number]): [number, number, number] => {
        const lumRatio = clamp(Math.pow((lum(sampleRGB) + 6) / (lum(this.personaMean) + 6), 0.75), 0.55, 1.6);
        const out: [number, number, number] = [1, 1, 1];
        for (let c = 0; c < 3; c++) {
          const chroma = (sampleRGB[c] + 6) / (lum(sampleRGB) + 6) / ((this.personaMean[c] + 6) / (lum(this.personaMean) + 6));
          out[c] = clamp(lumRatio * Math.pow(chroma, 0.45), 0.5, 1.8);
        }
        return out;
      };

      const blendGain = (curr: [number, number, number], target: [number, number, number]) => {
        curr[0] = curr[0] * 0.85 + target[0] * 0.15;
        curr[1] = curr[1] * 0.85 + target[1] * 0.15;
        curr[2] = curr[2] * 0.85 + target[2] * 0.15;
      };

      // Sample directly from driver's tracked anatomical landmarks
      const sampleLandmark = (idx: number): [number, number, number] => {
        const lx = srcPts[idx * 2];
        const ly = srcPts[idx * 2 + 1];
        const nx = Math.round(clamp(((lx - b.minX) / Math.max(1, b.width)) * size, 1, size - 2));
        const ny = Math.round(clamp(((ly - b.minY) / Math.max(1, b.height)) * size, 1, size - 2));
        return samplePatch(nx, ny, 1);
      };

      const userForehead = sampleLandmark(LM.FOREHEAD);
      const userLeftCheek = sampleLandmark(LM.LEFT_CHEEK);
      const userRightCheek = sampleLandmark(LM.RIGHT_CHEEK);
      const userNose = sampleLandmark(LM.NOSE_BRIDGE);
      // Chin tip: landmark 152 is safely located at the inferior mandibular apex, never inside the mouth
      const userChin = sampleLandmark(LM.CHIN);

      blendGain(this.zoneLighting.forehead, computeGain(userForehead));
      blendGain(this.zoneLighting.leftCheek, computeGain(userLeftCheek));
      blendGain(this.zoneLighting.rightCheek, computeGain(userRightCheek));
      blendGain(this.zoneLighting.nose, computeGain(userNose));
      blendGain(this.zoneLighting.chin, computeGain(userChin));

      const centralMean = computeGain(userNose);
      blendGain(this.colorGain, centralMean);
    } catch {
      // Keep existing gain on read error
    }
  }

  /**
   * Mean RGB of the central face region (cheeks/nose/forehead) of `image`, where `points` are
   * landmark pixel positions inside that image.
   */
  private sampleMeanColor(
    image: CanvasImageSource,
    points: Float32Array,
    imageWidth: number,
    imageHeight: number,
    alreadyPixelSpace: boolean
  ): [number, number, number] {
    const pts = alreadyPixelSpace ? points : scalePoints(points, imageWidth, imageHeight);
    const b = pointBounds(pts.subarray(0, 468 * 2));
    const size = 24;
    const sctx = this.samplerCtx;
    try {
      sctx.clearRect(0, 0, size, size);
      sctx.drawImage(image, b.minX, b.minY, Math.max(1, b.width), Math.max(1, b.height), 0, 0, size, size);
      const data = sctx.getImageData(0, 0, size, size).data;
      let r = 0;
      let g = 0;
      let bl = 0;
      let count = 0;
      const cx = size / 2;
      const cy = size * 0.52;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // Inner ellipse only: skips hair, background and the mesh border.
          const dx = (x + 0.5 - cx) / (size * 0.28);
          const dy = (y + 0.5 - cy) / (size * 0.36);
          if (dx * dx + dy * dy > 1) continue;
          const i = (y * size + x) * 4;
          r += data[i];
          g += data[i + 1];
          bl += data[i + 2];
          count++;
        }
      }
      if (!count) return [128, 128, 128];
      return [r / count, g / count, bl / count];
    } catch {
      return [128, 128, 128];
    }
  }

  /**
   * Advanced graphics post-pass: renders photorealistic intra-oral cavity (maxillary/mandibular
   * teeth, gums, tongue articulation, pharyngeal depth) and natural corneal specular catchlights.
   */
  private drawRealisticPostPass(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    metrics: FacialMetrics
  ) {
    if (!this.faceVisible || this.status.persona !== 'ready') return;
    const sx = w / this.canvas.width;
    const sy = h / this.canvas.height;
    const pts = this.warpPositions;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sx, sy);

    // Forehead/hairline harmonization runs on the transparent overlay layer (composeOverlayLayer).

    const flags = realismFlags.get();

    // 1. Anatomical Intra-Oral Dental & Depth Synthesis Engine
    const apertureMetrics = flags.oralCavity ? extractOralApertureMetrics(pts) : null;
    if (apertureMetrics) {
      const teeth = OralCavityRenderer.renderOralCavity(ctx, pts, {
        metrics: apertureMetrics,
        lightingGain: this.colorGain,
        isSpeaking: metrics.isSpeaking,
        isSmiling: metrics.isSmiling,
      });
      if (teeth) this.syntheticTeethThisFrame = true;
    }

    // 2. Corneal specular catchlights (natural moisture & vitality in eyes)
    if (flags.catchlights && !metrics.isBlinking && pts.length >= 478 * 2) {
      const leftIrisX = pts[LM.LEFT_IRIS_CENTER * 2];
      const leftIrisY = pts[LM.LEFT_IRIS_CENTER * 2 + 1];
      const rightIrisX = pts[LM.RIGHT_IRIS_CENTER * 2];
      const rightIrisY = pts[LM.RIGHT_IRIS_CENTER * 2 + 1];

      // Subtle corneal catchlight positioned at upper-right pupil (matching typical key light)
      const glintSize = 2.0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
      ctx.shadowBlur = 2;

      ctx.beginPath();
      ctx.arc(leftIrisX + 1.2, leftIrisY - 1.2, glintSize, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(rightIrisX + 1.2, rightIrisY - 1.2, glintSize, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawSource(
    ctx: CanvasRenderingContext2D,
    source: CanvasImageSource,
    layout: SourceLayout,
    x: number,
    y: number,
    w: number,
    h: number
  ) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sx = w / W;
    const sy = h / H;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sx, sy);
    if (layout.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, layout.offsetX, layout.offsetY, layout.drawWidth, layout.drawHeight);
    ctx.restore();
  }

  /** Shown when neither webcam nor demo subject is available. */
  private drawStandby(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    const grad = ctx.createRadialGradient(x + w / 2, y + h / 2, 20, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, '#1e293b');
    grad.addColorStop(1, '#090d16');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.save();
    ctx.strokeStyle = 'rgba(56,189,248,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.min(w, h) * 0.2, Math.min(w, h) * 0.27, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(148,163,184,0.9)';
    ctx.font = `500 ${Math.round(Math.min(w, h) * 0.035)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.demoFailed ? 'Demo subject unavailable — turn on your webcam' : 'Waiting for a video source…', x + w / 2, y + h * 0.82);
  }

  private drawSplitHandle(ctx: CanvasRenderingContext2D, splitPx: number, W: number, H: number) {
    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(splitPx, 0);
    ctx.lineTo(splitPx, H);
    ctx.stroke();

    ctx.fillStyle = '#0284c7';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.roundRect(splitPx - 14, H / 2 - 28, 28, 56, 14);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#bae6fd';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('◀ ▶', splitPx, H / 2);
    ctx.restore();

    this.drawLabel(ctx, 'LIVE CAMERA', 16, 16, '#94a3b8');
    this.drawLabel(ctx, '● AI TRANSFORMED', Math.max(splitPx + 16, W - 180), 16, '#38bdf8');
  }

  private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
    ctx.save();
    ctx.font = 'bold 12px Inter, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 20;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, 26, 6);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 10, y + 13);
    ctx.restore();
  }

  /** Draws the live 478-point tessellation (and iris rings) from the tracked landmarks. */
  private drawLandmarkMesh(ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, scale: number) {
    const p = this.smoothed;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const { start, end } of FACE_TESSELLATION) {
      ctx.moveTo(p[start * 2], p[start * 2 + 1]);
      ctx.lineTo(p[end * 2], p[end * 2 + 1]);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(74, 222, 128, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const { start, end } of [...FACE_LEFT_IRIS, ...FACE_RIGHT_IRIS]) {
      ctx.moveTo(p[start * 2], p[start * 2 + 1]);
      ctx.lineTo(p[end * 2], p[end * 2 + 1]);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(186, 230, 253, 0.9)';
    for (let i = 0; i < 468; i++) ctx.fillRect(p[i * 2] - 0.75, p[i * 2 + 1] - 0.75, 1.5, 1.5);
    ctx.restore();
  }

  private drawHeadPoseTripod(ctx: CanvasRenderingContext2D, originX: number, originY: number, pose: HeadPose) {
    ctx.save();
    ctx.translate(originX, originY);
    const length = 24;
    const rollRad = (pose.roll * Math.PI) / 180;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-24, -28, 120, 56, 6);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(rollRad) * length, Math.sin(rollRad) * length);
    ctx.stroke();

    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-Math.sin(rollRad) * length, Math.cos(rollRad) * length);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Inter, monospace, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Y: ${pose.yaw > 0 ? '+' : ''}${pose.yaw.toFixed(1)}°`, 36, -12);
    ctx.fillText(`P: ${pose.pitch > 0 ? '+' : ''}${pose.pitch.toFixed(1)}°`, 36, 0);
    ctx.fillText(`R: ${pose.roll > 0 ? '+' : ''}${pose.roll.toFixed(1)}°`, 36, 12);
    ctx.restore();
  }

  /**
   * Mandatory AI-transformed watermark. Drawn on every output frame in every view mode, after
   * everything else, and sized from the frame height so it survives a video-call downscale to 360p.
   */
  private drawMandatoryWatermark(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const m = watermarkMetrics(w, h);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.font = m.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(WATERMARK_TEXT).width;
    const badgeW = m.padX * 2 + m.dot * 2 + m.gap + textW;
    const x = w - badgeW - m.margin;
    const y = h - m.badgeH - m.margin;
    const cy = y + m.badgeH / 2;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = Math.max(1.5, m.fontPx * 0.1);
    ctx.beginPath();
    ctx.roundRect(x, y, badgeW, m.badgeH, m.fontPx * 0.4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(x + m.padX + m.dot, cy, m.dot, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f8fafc';
    ctx.fillText(WATERMARK_TEXT, x + m.padX + m.dot * 2 + m.gap, cy);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // Realism review instrumentation (dev-only; see src/realism/debug.ts)
  // ---------------------------------------------------------------------------------------------

  /** Current position on the capture timeline: video seconds for a clip, frame index otherwise. */
  private captureClock(): number {
    return this.videoKind === 'file' && this.videoElement ? this.videoElement.currentTime : this.frameIndex;
  }

  private handleCaptures(src: NonNullable<ReturnType<RealtimeFacialEngine['getSource']>>, layout: SourceLayout) {
    const t = this.captureClock();
    while (this.captureTimes.length && t >= this.captureTimes[0]) {
      const target = this.captureTimes.shift()!;
      const snap = this.snapshot(1, src, layout);
      this.captures.push({
        t: target,
        frameIndex: this.frameIndex,
        output: snap.output,
        driver: snap.driver,
        overlay: this.overlayDrawnThisFrame ? snap.overlay : null,
        landmarks: snap.landmarks,
        warpPositions: Float32Array.from(this.warpPositions),
        outputLandmarks: null,
        mirror: layout.mirror,
        mar: this.lastMar,
        pose: { ...this.lastPose },
        isSpeaking: this.lastMetrics?.isSpeaking ?? false,
        isSmiling: this.lastMetrics?.isSmiling ?? false,
        syntheticTeeth: this.syntheticTeethThisFrame,
        keyframeId: this.currentKeyframeId,
      });
    }
    const plan = this.burstPlan;
    if (plan && t >= plan.start) {
      if (!this.burst) this.burst = { start: plan.start, scale: plan.scale, frames: [] };
      const snap = this.snapshot(plan.scale, src, layout);
      this.burst.frames.push({ t, frameIndex: this.frameIndex, output: snap.output, driver: snap.driver, landmarks: snap.landmarks });
      if (this.burst.frames.length >= plan.count) this.burstPlan = null;
    }
  }

  /** Copies the output, the driver frame (as composited, mirrored) and the persona layer at `scale`. */
  private snapshot(scale: number, src: NonNullable<ReturnType<RealtimeFacialEngine['getSource']>>, layout: SourceLayout) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const make = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    const output = make();
    output.getContext('2d')!.drawImage(this.canvas, 0, 0, w, h);
    const driver = make();
    const dctx = driver.getContext('2d')!;
    dctx.fillStyle = '#0b1220';
    dctx.fillRect(0, 0, w, h);
    this.drawSource(dctx, src.source, layout, 0, 0, w, h);
    const overlay = make();
    overlay.getContext('2d')!.drawImage(this.overlayLayer, 0, 0, w, h);
    const landmarks = new Float32Array(this.smoothed.length);
    for (let i = 0; i < landmarks.length; i++) landmarks[i] = this.smoothed[i] * scale;
    return { output, driver, overlay, landmarks };
  }

  private createDebugApi(): RealismEngineDebugApi {
    return {
      getState: (): RealismDebugState => {
        const v = this.videoKind === 'file' ? this.videoElement : null;
        const b = this.faceVisible ? pointBounds(this.smoothed.subarray(0, 468 * 2)) : null;
        return {
          source: this.status.source,
          canvasWidth: this.canvas.width,
          canvasHeight: this.canvas.height,
          faceVisible: this.faceVisible,
          faceBox: b ? { x: b.minX, y: b.minY, w: b.width, h: b.height } : null,
          mar: this.lastMar,
          lipFade: this.lastLipFade,
          rigidPose: this.rigid.lastPose ? poseAngles(this.rigid.lastPose.q) : null,
          cameraMatch: realismFlags.get().cameraMatch ? { ...this.cameraMatch } : null,
          cameraMatchTrace: [...this.cameraMatchTrace],
          restMar: this.restMouth.rest,
          lightingGainUpdates: this.lightingGainUpdates,
          personaDelightRange: this.personaDelightRange,
          renderer: this.status.renderer,
          pose: { ...this.lastPose },
          isSpeaking: this.lastMetrics?.isSpeaking ?? false,
          isSmiling: this.lastMetrics?.isSmiling ?? false,
          keyframeId: this.currentKeyframeId,
          keyframeCount: this.referenceBank.getKeyframes().length,
          personaStatus: this.status.persona,
          framesRendered: this.frameIndex - this.frameIndexAtReset,
          syntheticTeethFrames: this.syntheticTeethFrames,
          videoTime: v ? v.currentTime : null,
          videoDuration: v && Number.isFinite(v.duration) ? v.duration : null,
          videoEnded: v ? v.ended : false,
          profile: this.profiler.summary(),
          flags: realismFlags.get(),
        };
      },
      scheduleCaptures: (times) => {
        this.captureTimes = [...times].sort((a, b) => a - b);
      },
      scheduleBurst: (start, count, scale) => {
        this.burst = null;
        this.burstPlan = { start, count: Math.max(1, Math.floor(count)), scale: clamp(scale, 0.05, 1) };
      },
      pending: () => ({ captures: this.captureTimes.length, burst: this.burstPlan ? this.burstPlan.count - (this.burst?.frames.length ?? 0) : 0 }),
      drainCaptures: async () => {
        const out = this.captures;
        this.captures = [];
        for (const c of out) {
          try {
            // The driver is drawn mirrored, which swaps the landmarker's left/right indices. Detecting
            // on an un-mirrored copy and flipping x back keeps index i on the same feature as the driver's.
            let target = c.output;
            if (c.mirror) {
              target = document.createElement('canvas');
              target.width = c.output.width;
              target.height = c.output.height;
              const tctx = target.getContext('2d')!;
              tctx.translate(target.width, 0);
              tctx.scale(-1, 1);
              tctx.drawImage(c.output, 0, 0);
            }
            const { faces } = await this.tracker.detectImage(target);
            const face = faces[0];
            if (face) {
              const px = new Float32Array(face.landmarks.length);
              for (let i = 0; i < face.landmarks.length; i += 2) {
                const x = face.landmarks[i] * c.output.width;
                px[i] = c.mirror ? c.output.width - x : x;
                px[i + 1] = face.landmarks[i + 1] * c.output.height;
              }
              c.outputLandmarks = px;
            }
          } catch (err) {
            console.warn('Output landmark detection failed for a captured frame', err);
          }
        }
        return out;
      },
      drainBurst: () => {
        const b = this.burst;
        this.burst = null;
        this.burstPlan = null;
        return b;
      },
      getBuffer: (name: RealismBufferName) => {
        switch (name) {
          case 'output':
            return this.canvas;
          case 'overlay':
            return this.overlayLayer;
          case 'warp':
            return this.warp.canvas;
          case 'driver':
            return this.videoElement ? null : this.demoCanvas;
        }
      },
      getVideo: () => this.videoElement,
      resetPerf: () => {
        this.profiler.reset();
        this.syntheticTeethFrames = 0;
        this.frameIndexAtReset = this.frameIndex;
      },
      detectStill: async (image) => {
        if (!this.tracker.ready) return null;
        const w = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
        const h = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
        const { faces } = await this.tracker.detectImage(image);
        const face = faces[0];
        if (!face) return null;
        const px = new Float32Array(face.landmarks.length);
        for (let i = 0; i < face.landmarks.length; i += 2) {
          px[i] = face.landmarks[i] * w;
          px[i + 1] = face.landmarks[i + 1] * h;
        }
        return px;
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------------------------

  private patchStatus(patch: Partial<EngineStatus>) {
    this.status = { ...this.status, ...patch };
    this.emitStatus();
  }

  private emitStatus(force = false) {
    const json = JSON.stringify(this.status);
    if (!force && json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    this.onStatusUpdate?.(this.status);
  }
}

// -----------------------------------------------------------------------------------------------
// Module helpers
// -----------------------------------------------------------------------------------------------

function coverLayout(srcW: number, srcH: number, dstW: number, dstH: number, mirror: boolean): SourceLayout {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const drawWidth = srcW * scale;
  const drawHeight = srcH * scale;
  return {
    offsetX: (dstW - drawWidth) / 2,
    offsetY: (dstH - drawHeight) / 2,
    drawWidth,
    drawHeight,
    mirror,
  };
}

function scalePoints(points: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 2) {
    out[i] = points[i] * w;
    out[i + 1] = points[i + 1] * h;
  }
  return out;
}

function round3(v: number) {
  return Math.round(v * 1000) / 1000;
}

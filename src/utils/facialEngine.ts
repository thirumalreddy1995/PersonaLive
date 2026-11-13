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
import { AuthorizedPersona, EngineStatus, FacialMetrics, HeadPose, PersonaReference, TransformationSettings } from '../types/index.ts';
import { OneEuroFilter } from './faceMath.ts';
import { RigidPoseStabilizer, StabilizerOptions, poseAngles } from './rigidPose.ts';
import { cropUvs, planCrop } from './personaCrop.ts';
import { delightPersona } from './personaDelight.ts';
import { TONE_BUDGET_DEFAULT, normalizePhotoLighting, type LightingAssessment } from './photoLighting.ts';
import { AUTO_RADIUS_EVERY, AutoRadiusState, ILLUM_CHEEKS, ILLUM_RADIUS_MAX, ILLUM_RADIUS_MIN, initialAutoRadius, measureShading, shadingPatches, stepAutoRadius } from './autoRadius.ts';
import { lumaAtScale, symmetricDelightGains, vertexBandLuma } from './faceSymmetry.ts';
import { FaceSegmenter } from './segmenter.ts';
import { NormRect, PackedMasks, emptyMasks, faceCropRect, insidePolygon, sampleMask, stableCrop } from './segmentation.ts';
import {
  EXT_COLUMNS,
  EXT_MID_START,
  EXT_VERTEX_COUNT,
  HairlineCalibrator,
  STRETCH_MAX,
  STRETCH_MIN,
  TRACKED_POINT_COUNT,
  copyColumnWeights,
  extendForehead,
  extendTopology,
  fillAmbiguousRatios,
  foreheadFrame,
  foreheadPolygon,
  isHairlineFrontal,
  measureHairlineRatios,
  padPoints,
  smoothHairlineRatios,
  stretchClamp,
} from './foreheadExtension.ts';
import { dilateMask, inpaintMasked } from './inpaint.ts';
import { foreshortenWeights } from './foreshorten.ts';
import { KeyframeCrossfader } from './keyframeBlend.ts';
import { driverPoseFromMatrix } from './headPose.ts';
import { FramePacer, pacingMode, type PacedTick, type PacedVideo } from './framePacing.ts';
import { useSingleGlComposite } from './compositePath.ts';
import type { EnrollmentFrame } from './enrollmentSource.ts';
import { FACE_OVAL_RING } from './personaDelight.ts';
import { READBACK_SIZE } from './meshWarpRenderer.ts';
import { CameraMatchState, initialCameraMatch, stepCameraMatch, CAMERA_MATCH_WARM_UPDATES, cameraMatchDue, cameraMatchDueSettled } from './cameraMatch.ts';
import { RestMouthCalibrator, lipFadeWindow } from './restMouth.ts';
import { resolveLook } from './look.ts';
import {
  LidClosure,
  NeutralShapeCalibrator,
  PROPORTION_MAX_SHIFT,
  PitchBaseline,
  STABLE_POINTS,
  applyJawExtension,
  applyProportions,
  beardDepths,
  fitAffine,
  hasBeard,
  jawPlan,
  jawPoseScale,
  jawSideScale,
  silhouetteWeights,
  smoothstep,
  lidPassThroughWeights,
  normalizeShape,
  proportionOffsets,
  proportionWeights,
  upperLidBands,
  type JawPlan,
} from './identityShape.ts';
import {
  applyEyelidKinematics,
  eyeFadeWeights,
  lipFadeForMar,
  applyGazeIrisTracking,
  applyPerspectiveForeshortening,
  applySmileBias,
  applySpeechAnatomy,
  boundaryFeatherWeights,
  buildFaceTopology,
  featherBandWeights,
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
import { ILLUMINATION_RADIUS_SHARE, JAW_BEARD_FEATHER, MeshWarpRenderer, SKIN_TINT_MAX, pairedFaceStats, readbackWindow, type FaceStats } from './meshWarpRenderer.ts';
import { OralCavityRenderer, extractOralApertureMetrics } from './oralCavityRenderer.ts';
import { MultiReferenceBank, type ReferenceKeyframe } from './multiReferenceBank.ts';
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
/** R4b: the forehead extension grows in (and out) over this long once the hairline calibration lands. */
const FOREHEAD_RAMP_MS = 500;
/** R4b: time constant with which the rings move to a new hairline after a recalibration. */
const FOREHEAD_SETTLE_MS = 250;
/** R4b: alpha of persona pixels that were hair on the forehead and were filled from the surrounding skin. */
const FRINGE_FILL_ALPHA = 217;
const NO_EXTENSION: ReadonlyArray<number> = new Array(EXT_COLUMNS).fill(1);

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
  /** The tracked points followed by the R4b forehead-extension vertices (unused without the flag). */
  private warpPositions = new Float32Array(EXT_VERTEX_COUNT * 2);
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
  private frameIndex = 0;
  // R6b identity (flags personaProportions, jawExtension, lidPassThrough).
  /** The wearer's neutral shape in the eye frame, learned from frontal relaxed frames. */
  private neutralShape = new NeutralShapeCalibrator();
  /** The persona photo's landmarks in the eye frame. */
  private personaShapeNorm: Float32Array | null = null;
  private proportionW: { topology: FaceTopology; realEyes: boolean; w: Float32Array } | null = null;
  private proportionOff = new Float32Array(468 * 2);
  private wearerNeutral = new Float32Array(468 * 2);
  private shapeScratch = new Float32Array(468 * 2);
  /** Proportions fade in over ~1 s once the neutral shape is known. */
  private proportionRamp = 0;
  private jawPlanCache: JawPlan | null = null;
  /** Pushed jaw UVs → the persona's own UVs, so the foreshortening fade measures the real geometry. */
  private jawUvBase = new WeakMap<Float32Array, Float32Array>();
  /** R6b (flag seamFade): per UV set (persona photo or keyframe), the side-of-face silhouette weights. */
  private seamWeights = new WeakMap<Float32Array, Float32Array>();
  private seamScratch: Float32Array | null = null;
  /** The head-turn factor (0..1, 0.1 steps) the jaw feather and bands were last uploaded for. */
  private jawTurnApplied = 1;
  /** Beard depth below each lower-jaw point of the persona photo (IOD units); null = no beard or flag off. */
  private jawDepths: Float32Array | null = null;
  private lidClosure = new LidClosure();
  /** R6b: the wearer's level head pitch, for the chin-down lid cue. */
  private pitchBaseline = new PitchBaseline();
  private lastHeadDown: number | null = null;
  private lidBands: { topology: FaceTopology; radius: number; base: Float32Array; bands: { left: Float32Array; right: Float32Array }; weights: Float32Array } | null = null;
  private lidLast: [number, number] = [-1, -1];
  /** frameIndex when the debug counters were last reset, so framesRendered is per replay. */
  private frameIndexAtReset = 0;

  // Where the transformed pane sits on the canvas (used to place the mesh overlay)
  private paneTransform = { x: 0, y: 0, scale: 1 };

  // Loop & settings
  private isRunning = false;
  private disposed = false;
  /** R5 §3: schedules the loop on video frames (flag videoFramePacing) or animation frames. */
  private pacer = new FramePacer({
    requestAnimationFrame: (cb) => requestAnimationFrame(cb),
    cancelAnimationFrame: (h) => cancelAnimationFrame(h),
  });
  /** Ticks skipped because the video frame had not changed (videoFramePacing fallback). */
  private framesSkipped = 0;
  private lastPacing: PacedTick | null = null;
  /** R5 §1: enrollment shots of the active persona and the cross-fade between the bank's keyframes. */
  private personaRefs: PersonaReference[] = [];
  private realKeyframes = false;
  private keyFader = new KeyframeCrossfader();
  private keyUv = new Map<string, Float32Array>();
  private keyframeMix = 0;
  private keyframeSecondaryId: string | null = null;
  /** R5 §5: head pose from MediaPipe's transformation matrix, in the driver convention (null without a matrix). */
  private matrixPose: HeadPose | null = null;
  /** R5 §4: true when this frame was composited in the single GL pass (flag singleGlComposite). */
  private singleGlThisFrame = false;
  /** Layout of the last rendered frame (for mapping the face box back to the source, R5 §2). */
  private lastLayout: SourceLayout | null = null;
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
  /** Frame index of the last persona or source change (R6 median mode waits for the output to settle). */
  private cameraMatchChangeFrame = 0;
  /** Max/min of the de-light shading field fitted on the current persona (flag personaDelight). */
  private personaDelightRange: number | null = null;
  /** R6b (flag photoLighting): the persona photo's lighting measured at load. */
  private personaLighting: LightingAssessment | null = null;
  /** R3c auto-radius loop state (flag autoRadius) and its per-update trace. */
  private autoRadius: AutoRadiusState = initialAutoRadius();
  /** R6b (flag photoLighting): the illumination relight's per-persona radius loop (same readbacks). */
  private illumRadius: AutoRadiusState = initialAutoRadius(ILLUM_RADIUS_MAX);
  private illumLoopActive = false;
  private autoRadiusPending = false;
  private autoRadiusTrace: number[] = [];
  /** Last loop measurement, for the review tool's cross-check against the offline metric. */
  private autoRadiusLast: Record<string, number | boolean | null> | null = null;
  /** R3c symmetric de-light: per-vertex persona luma at the DELIGHT_SCALES and the radius the gains were built for. */
  private delightBands: Float32Array[] | null = null;
  private delightRadius = -1;
  /** R4 segmentation: the segmenter, its EMA masks, whether they changed since the last upload and whether they drive this frame. */
  private segmenter = new FaceSegmenter();
  private masks: PackedMasks = emptyMasks();
  private masksDirty = false;
  private segActive = false;
  private segUpdates = 0;
  /** Current segmentation crop (normalised source coordinates), kept stable with hysteresis. */
  private segCrop: NormRect | null = null;
  /** R4 §4 per-vertex foreshortening weights (reused buffer). */
  private foreshorten: Float32Array | null = null;
  /** Share of the persona's face oval that was inpainted at load (flag personaInpaint). */
  private personaInpaintShare: number | null = null;
  /** R4b forehead extension (flag foreheadExtension): the base and the extended topology, and whether the extended one is in use. */
  private baseTopology: FaceTopology;
  private extTopology: FaceTopology | null = null;
  private foreheadOn = false;
  /** The wearer's hairline, calibrated once from the hair mask while frontal. */
  private hairline = new HairlineCalibrator();
  private hairlineSegSeen = -1;
  /** 0..1: how far the extension has grown in. */
  private foreheadStrength = 0;
  private foreheadClock: number | null = null;
  /** Wearer-side ratios after the stretch guard; null until both hairlines are known. */
  private foreheadWearer: number[] | null = null;
  /** The ratios the rings are drawn at this frame (they ease toward foreheadWearer after a recalibration). */
  private foreheadShown: number[] | null = null;
  private foreheadClamped = 0;
  /** The persona's hairline ratios (measured at load, ambiguous columns filled), and the raw measurement. */
  private personaRatios: number[] | null = null;
  private personaRatiosMeasured: Array<number | null> | null = null;
  /** The persona UVs padded for the extension, and the texture size they refer to. */
  private personaUvExt: Float32Array | null = null;
  private personaTexSize = { width: 1, height: 1 };
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

    this.baseTopology = buildFaceTopology(FACE_TESSELLATION, FACE_OVAL, 468);
    this.topology = this.baseTopology;
    this.warp = new MeshWarpRenderer(w, h, realismFlags.get().webgl2);
    this.applyForeheadTopology();
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
      if (
        (changed.includes('syntheticSuite') ||
          changed.includes('personaCrop') ||
          changed.includes('personaDelight') ||
          changed.includes('symmetricDelight') ||
          changed.includes('personaInpaint') ||
          // R5: real keyframes are loaded with the persona, and their stored pose depends on the pose source.
          changed.includes('keyframeCrossfade') ||
          changed.includes('matrixHeadPose') ||
          // R6b: the beard depth, the jaw UVs and the seam weights are measured with the persona.
          changed.includes('jawExtension') ||
          changed.includes('seamFade') ||
          // R6b: the photo's lighting is measured and normalised with the persona.
          changed.includes('photoLighting')) &&
        this.personaImage
      )
        void this.preparePersona();
      if (changed.includes('videoFramePacing')) this.pacer.reset();
      if (changed.includes('autoRadius')) {
        this.autoRadius = initialAutoRadius();
        this.autoRadiusTrace = [];
      }
      if (changed.includes('foreheadExtension')) {
        this.applyForeheadTopology();
        if (this.personaImage) void this.preparePersona();
      }
      if (changed.includes('segmentation') || changed.includes('personaInpaint') || changed.includes('foreheadExtension')) this.ensureSegmenter();
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
      // R4: the segmenter loads in the background only when a flag needs it; until it is ready the geometric fallbacks stay on.
      this.ensureSegmenter();
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
    // R6b: a new source may be a different wearer.
    this.neutralShape.reset();
    this.proportionRamp = 0;
    this.lidClosure.reset();
    this.pitchBaseline.reset();
    // R3b: a new source gets a neutral camera match that re-measures on the first frames.
    this.cameraMatch = initialCameraMatch();
    this.cameraMatchPending = false;
    this.cameraMatchWarm = CAMERA_MATCH_WARM_UPDATES;
    this.cameraMatchChangeFrame = this.frameIndex;
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
      this.personaRefs = [];
      this.realKeyframes = false;
      this.referenceBank.clear();
      this.currentKeyframeId = null;
      this.warp.clearPersona();
      this.patchStatus({ persona: 'none' });
      return;
    }
    if (persona.id === this.personaId && this.status.persona === 'ready') return;
    this.personaId = persona.id;
    this.personaRefs = persona.references ?? [];
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
    if (prev.eyePassThroughRadius !== settings.eyePassThroughRadius) {
      this.warp.setEyeFade(eyeFadeWeights(this.topology, settings.eyePassThroughRadius));
    }
    if (resolveLook(prev).boundaryFeather !== resolveLook(settings).boundaryFeather) this.applyBoundaryFeather();
    if (prev.personaTextureSize !== settings.personaTextureSize && this.personaImage && realismFlags.get().personaCrop) {
      void this.preparePersona();
    }
    if (prev.foreheadRecalibrate !== settings.foreheadRecalibrate) this.hairline.recalibrate();
    if (prev.foreheadStretchMin !== settings.foreheadStretchMin || prev.foreheadStretchMax !== settings.foreheadStretchMax) this.applyForeheadMapping();
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
    this.pacer.cancel();
  }

  public dispose() {
    this.disposed = true;
    this.personaPrepareToken++;
    this.stop();
    this.flagsUnsubscribe?.();
    this.flagsUnsubscribe = null;
    if (isRealismDebugEnabled()) setRealismEngine(null);
    this.tracker.dispose();
    this.segmenter.dispose();
    this.warp.dispose();
  }

  public getStatus(): EngineStatus {
    return this.status;
  }

  /**
   * R5 §2: what the guided enrollment reads from the live tracker. Null unless the source is a
   * running webcam: a clip or the demo image is not the person at the camera.
   */
  public getEnrollmentFrame(): EnrollmentFrame | null {
    const v = this.videoElement;
    if (!v || this.videoKind !== 'webcam' || v.readyState < 2 || v.videoWidth === 0) return null;
    // A stopped engine has no live tracking: its last values must not pass a shot check.
    if (!this.isRunning) return null;
    const bs = this.lastFace?.blendshapes ?? {};
    const layout = this.lastLayout;
    let faceBox: [number, number, number, number] | null = null;
    if (this.faceVisible && layout) {
      const fb = pointBounds(this.smoothed.subarray(0, 468 * 2));
      let u0 = (fb.minX - layout.offsetX) / layout.drawWidth;
      let u1 = (fb.minX + fb.width - layout.offsetX) / layout.drawWidth;
      if (layout.mirror) {
        const m0 = 1 - u1;
        u1 = 1 - u0;
        u0 = m0;
      }
      const v0 = (fb.minY - layout.offsetY) / layout.drawHeight;
      const v1 = (fb.minY + fb.height - layout.offsetY) / layout.drawHeight;
      faceBox = [clamp(u0, 0, 1), clamp(v0, 0, 1), clamp(u1 - u0, 0, 1), clamp(v1 - v0, 0, 1)];
    }
    return {
      video: v,
      faceVisible: this.faceVisible,
      pose: { ...this.lastPose },
      matrixPose: this.faceVisible && this.matrixPose ? { ...this.matrixPose } : null,
      mar: this.lastMar,
      smile: ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2,
      browElevation: bs.browInnerUp ?? 0,
      faceBox,
    };
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
      // R4b: whether this persona is prepared for the extended topology.
      const foreheadOn = this.foreheadOn;
      // R2 §2 crop and R3b de-light (shared with the R5 keyframes, see photoTexture).
      const prepared = this.photoTexture(img, face.landmarks);
      let texture: HTMLImageElement | HTMLCanvasElement = prepared.texture;
      let uv = prepared.uv;
      this.personaDelightRange = prepared.delightRange;
      this.personaLighting = prepared.lighting;
      // R4 (flag personaInpaint): segment the photo and inpaint hair and glasses inside the face oval.
      this.personaInpaintShare = null;
      const warnings: string[] = [];
      let personaRatios: number[] | null = null;
      let personaRatiosMeasured: Array<number | null> | null = null;
      const inpaintOn = realismFlags.get().personaInpaint;
      if (inpaintOn || foreheadOn) {
        // R4b (flag foreheadExtension): the same segmentation gives the persona's hairline ratios, and hair on its forehead is filled.
        const res = await this.inpaintPersona(texture, uv, { inpaint: inpaintOn, forehead: foreheadOn });
        if (this.disposed || token !== this.personaPrepareToken) return;
        if (res) texture = res.canvas;
        personaRatios = res?.ratios ?? null;
        personaRatiosMeasured = res?.measured ?? null;
        const share = res?.share ?? null;
        if (inpaintOn) {
          this.personaInpaintShare = share;
          if (share !== null && share > 0.02) warnings.push(`Hair or glasses covered ${(share * 100).toFixed(0)}% of the face skin in this photo and were filled in; for best likeness retake without glasses and with the hair off the face.`);
          if (share === null) warnings.push('The photo could not be checked for hair or glasses over the face (segmenter unavailable).');
        }
        if (foreheadOn && personaRatiosMeasured && personaRatiosMeasured.every((r) => r === null)) {
          warnings.push('No hairline was found in this photo (hair over the forehead, a hat, a shaved head or a tight crop), so a typical forehead height is assumed.');
        }
      }
      this.patchStatus({ personaWarnings: warnings });
      // R3c (flag symmetricDelight): per-vertex band luma of the final texture for the mirror split.
      this.delightBands = null;
      this.delightRadius = -1;
      this.warp.setDelight(null);
      if (realismFlags.get().symmetricDelight) {
        const tw = texture instanceof HTMLImageElement ? texture.naturalWidth : texture.width;
        const th = texture instanceof HTMLImageElement ? texture.naturalHeight : texture.height;
        const c = document.createElement('canvas');
        c.width = tw;
        c.height = th;
        const cctx2 = c.getContext('2d', { willReadFrequently: true })!;
        cctx2.drawImage(texture, 0, 0, tw, th);
        const px = cctx2.getImageData(0, 0, tw, th);
        const ub = pointBounds(new Float32Array(uv.subarray(0, 468 * 2)));
        this.delightBands = vertexBandLuma(px.data, tw, th, uv, Math.max(1, ub.width * tw));
      }
      // R6b (flag personaProportions): the persona's feature layout in the eye frame.
      const lmPx = new Float32Array(468 * 2);
      for (let i = 0; i < 468; i++) {
        lmPx[i * 2] = face.landmarks[i * 2] * img.naturalWidth;
        lmPx[i * 2 + 1] = face.landmarks[i * 2 + 1] * img.naturalHeight;
      }
      this.personaShapeNorm = normalizeShape(lmPx);
      this.proportionRamp = 0;
      // R6b (flag jawExtension): how far the beard reaches below the jaw, and the UVs pushed to follow it.
      this.jawDepths = null;
      if (realismFlags.get().jawExtension) {
        const depths = this.measureBeard(texture, uv);
        if (depths && hasBeard(depths)) {
          this.jawDepths = depths;
          uv = this.extendJawUv(uv, texture);
        }
      }
      // The flag flipped while this preparation ran: the one started by the flip prepares for the current topology.
      if (foreheadOn !== this.foreheadOn) return;
      this.personaRatios = personaRatios;
      this.personaRatiosMeasured = personaRatiosMeasured;
      this.personaTexSize = {
        width: texture instanceof HTMLImageElement ? texture.naturalWidth : texture.width,
        height: texture instanceof HTMLImageElement ? texture.naturalHeight : texture.height,
      };
      if (foreheadOn) {
        // Extended topology: the UV set carries the two forehead rings (collapsed until the mapping below places them).
        uv = this.collapsedExtension(uv);
        this.personaUvExt = uv;
      } else {
        this.personaUvExt = null;
      }
      // R6b (flag seamFade): where this photo's side UVs fall off its face skin.
      if (realismFlags.get().seamFade) this.seamWeights.set(uv, this.measureSeam(texture, uv));
      this.warp.setPersona(texture, uv);
      // R6b: the jaw feather follows this persona's beard (or goes back to the plain one).
      this.applyBoundaryFeather();
      if (foreheadOn) this.applyForeheadMapping();
      this.currentKeyframeSource = texture;
      this.currentKeyframeId = null;
      this.cameraMatch = initialCameraMatch();
      this.cameraMatchTrace = [];
      this.cameraMatchPending = false;
      this.cameraMatchWarm = CAMERA_MATCH_WARM_UPDATES;
      this.cameraMatchChangeFrame = this.frameIndex;
      this.autoRadius = initialAutoRadius();
      this.illumRadius = initialAutoRadius(ILLUM_RADIUS_MAX);
      this.autoRadiusPending = false;
      this.autoRadiusTrace = [];
      this.personaMean = this.sampleMeanColor(img, face.landmarks, img.naturalWidth, img.naturalHeight, false);

      // Synthesize calibrated multi-angle, multi-expression identity suite for Person A.
      // With the syntheticSuite flag off the bank stays empty and the warp uses the one real photo.
      this.referenceBank.clear();
      this.realKeyframes = false;
      this.keyFader.reset();
      this.keyUv.clear();
      this.keyframeMix = 0;
      this.keyframeSecondaryId = null;
      this.warp.clearKeyframes();
      if (realismFlags.get().syntheticSuite) {
        const suite = MultiReferenceBank.synthesizeSuiteFromMaster(img, face.landmarks, this.personaMean);
        for (const kf of suite) {
          this.referenceBank.addKeyframe(kf);
        }
      }
      // R5 §1 (flag keyframeCrossfade): the enrollment shots become real keyframes, one GPU texture each.
      if (realismFlags.get().keyframeCrossfade && this.personaRefs.length > 1 && this.warp.supportsKeyframePair) {
        const keyframes = await this.loadReferenceKeyframes(this.personaRefs);
        if (this.disposed || token !== this.personaPrepareToken) return;
        if (keyframes.length > 1) {
          this.referenceBank.clear();
          for (const kf of keyframes) this.referenceBank.addKeyframe(kf);
          this.realKeyframes = true;
          // Every keyframe is uploaded now, so no later switch uploads anything.
          this.warp.setKeyframePair({ image: keyframes[0].source, uv: this.keyframeUv(keyframes[0]) }, null, 0);
          this.warp.warmKeyframes(keyframes.map((k) => k.source));
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

  private loop = (_now?: number, tick?: PacedTick) => {
    if (!this.isRunning) return;
    if (tick) this.lastPacing = tick;
    // R5 §3: with videoFramePacing a tick without a new camera frame is skipped (a stalled source still gets one).
    if (!tick || tick.newFrame || tick.stalled) {
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
    } else {
      this.framesSkipped++;
    }
    const paced = realismFlags.get().videoFramePacing;
    const v = this.videoElement;
    const video = paced && v && v.readyState >= 2 && v.videoWidth > 0 ? (v as unknown as PacedVideo) : null;
    this.pacer.schedule(video, paced, this.loop);
  };

  /**
   * Crops a persona photo to the face (R2 §2, flag personaCrop) and divides its smooth shading
   * out (R3b, flag personaDelight). Used for the persona photo and for every R5 keyframe, so they
   * all go through the same preparation.
   */
  private photoTexture(
    img: HTMLImageElement,
    landmarks: Float32Array
  ): { texture: HTMLImageElement | HTMLCanvasElement; uv: Float32Array; delightRange: number | null; lighting: LightingAssessment | null } {
    let texture: HTMLImageElement | HTMLCanvasElement = img;
    let uv = landmarks;
    let delightRange: number | null = null;
    let lighting: LightingAssessment | null = null;
    if (realismFlags.get().personaCrop) {
      const plan = planCrop(landmarks, img.naturalWidth, img.naturalHeight, this.settings.personaTextureSize);
      const crop = document.createElement('canvas');
      crop.width = plan.width;
      crop.height = plan.height;
      const cctx = crop.getContext('2d')!;
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(img, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
      texture = crop;
      uv = cropUvs(landmarks, img.naturalWidth, img.naturalHeight, plan);
    }
    if (realismFlags.get().photoLighting) {
      // R6b: the photo's side light and coloured fill are measured and divided out with a per-photo
      // strength (an evenly lit photo is left as it is); replaces the R3b de-light below.
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
      lighting = normalizePhotoLighting(pixels.data, lit.width, lit.height, pts);
      if (lighting && lighting.strength >= 0.01) {
        lctx.putImageData(pixels, 0, 0);
        texture = lit;
      }
    } else if (realismFlags.get().personaDelight) {
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
        delightRange = res.range;
      }
    }
    return { texture, uv, delightRange, lighting };
  }

  /**
   * R5 §1: turns the enrollment shots into bank keyframes. Each photo is analysed and prepared
   * like the persona photo; the pose and expression stored with the shot (measured live when it
   * was taken) position it in the bank. A shot whose face cannot be found is skipped.
   */
  private async loadReferenceKeyframes(refs: PersonaReference[]): Promise<ReferenceKeyframe[]> {
    const useMatrix = realismFlags.get().matrixHeadPose;
    const out: ReferenceKeyframe[] = [];
    for (const ref of refs) {
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.crossOrigin = 'anonymous';
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error(`could not load ${ref.label}`));
          el.src = ref.imageUrl;
        });
        const { faces } = await this.tracker.detectImage(img);
        if (this.disposed || faces.length === 0) continue;
        const prepared = this.photoTexture(img, faces[0].landmarks);
        const texture = prepared.texture;
        // R6b (flag jawExtension): every keyframe follows the persona photo's beard depth.
        const uv = this.jawDepths ? this.extendJawUv(prepared.uv, texture) : prepared.uv;
        if (realismFlags.get().seamFade) this.seamWeights.set(uv, this.measureSeam(texture, uv));
        const size = texture instanceof HTMLImageElement ? { width: texture.naturalWidth, height: texture.naturalHeight } : { width: texture.width, height: texture.height };
        out.push({
          id: ref.id,
          label: ref.label,
          pose: useMatrix && ref.matrixPose ? { ...ref.matrixPose } : { ...ref.pose },
          expression: { ...ref.expression },
          landmarks: uv,
          source: texture,
          meanColor: this.personaMean,
          width: size.width,
          height: size.height,
        });
      } catch (err) {
        console.warn('Reference shot skipped', ref.label, err);
      }
    }
    return out;
  }

  /** R6b: the jaw extension plan on the base mesh (indices below 468, valid on the extended topology too). */
  private jawPlanFor(): JawPlan {
    if (!this.jawPlanCache) this.jawPlanCache = jawPlan(this.baseTopology);
    return this.jawPlanCache;
  }

  /** R6b: a pixel sampler over a persona texture and its landmarks in pixels (null when unreadable). */
  private texturePixels(texture: HTMLImageElement | HTMLCanvasElement, uv: Float32Array): { sample: (x: number, y: number) => [number, number, number] | null; pts: Float32Array } | null {
    const w = texture instanceof HTMLImageElement ? texture.naturalWidth : texture.width;
    const h = texture instanceof HTMLImageElement ? texture.naturalHeight : texture.height;
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cctx = c.getContext('2d', { willReadFrequently: true });
    if (!cctx) return null;
    cctx.drawImage(texture, 0, 0, w, h);
    const data = cctx.getImageData(0, 0, w, h).data;
    const pts = new Float32Array(468 * 2);
    for (let i = 0; i < 468; i++) {
      pts[i * 2] = uv[i * 2] * w;
      pts[i * 2 + 1] = uv[i * 2 + 1] * h;
    }
    const sample = (x: number, y: number): [number, number, number] | null => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
      const o = (yi * w + xi) * 4;
      return [data[o], data[o + 1], data[o + 2]];
    };
    return { sample, pts };
  }

  /** R6b (flag jawExtension): beard depths below the jaw of a prepared persona texture, from its UVs. */
  private measureBeard(texture: HTMLImageElement | HTMLCanvasElement, uv: Float32Array): Float32Array | null {
    const px = this.texturePixels(texture, uv);
    return px ? beardDepths(px.sample, px.pts) : null;
  }

  /** R6b (flag seamFade): side-of-face silhouette weights of a prepared texture (all 1 when unreadable). */
  private measureSeam(texture: HTMLImageElement | HTMLCanvasElement, uv: Float32Array): Float32Array {
    const px = this.texturePixels(texture, uv);
    return px ? silhouetteWeights(px.sample, px.pts, this.baseTopology) : new Float32Array(this.baseTopology.vertexCount).fill(1);
  }

  /** R6b (flag jawExtension): a copy of `uv` with the lower face rings pushed out by the beard depth (in the texture's pixels). */
  private extendJawUv(uv: Float32Array, texture: HTMLImageElement | HTMLCanvasElement): Float32Array {
    const depths = this.jawDepths;
    if (!depths) return uv;
    const w = texture instanceof HTMLImageElement ? texture.naturalWidth : texture.width;
    const h = texture instanceof HTMLImageElement ? texture.naturalHeight : texture.height;
    const out = Float32Array.from(uv);
    const px = new Float32Array(468 * 2);
    for (let i = 0; i < 468; i++) {
      px[i * 2] = uv[i * 2] * w;
      px[i * 2 + 1] = uv[i * 2 + 1] * h;
    }
    applyJawExtension(px, this.jawPlanFor(), depths);
    for (let i = 0; i < 468; i++) {
      out[i * 2] = px[i * 2] / w;
      out[i * 2 + 1] = px[i * 2 + 1] / h;
    }
    this.jawUvBase.set(out, uv);
    return out;
  }

  /**
   * R6b (flag personaProportions): learns the wearer's neutral shape from frontal relaxed frames
   * and moves the interior vertices toward the persona's layout, mapped by the current head pose.
   */
  private applyPersonaProportions(k: LandmarkKinematics, lipFade: number, smile: number, pitchDeg: number) {
    const s = this.settings;
    const rest = this.restMouth.rest ?? 0.03;
    const relaxed = Math.abs(k.yaw) < 10 && Math.abs(k.pitch) < 12 && k.earLeft > 0.18 && k.earRight > 0.18 && k.mar < rest + 0.04 && smile < 0.3;
    if (relaxed) {
      const n = normalizeShape(this.smoothed, 468, this.shapeScratch);
      if (n) this.neutralShape.add(n);
    }
    if (!this.neutralShape.ready || !this.personaShapeNorm) {
      this.proportionRamp = 0;
      return;
    }
    const neutral = this.neutralShape.shape(this.wearerNeutral);
    if (!neutral) return;
    const A = fitAffine(neutral, this.warpPositions, STABLE_POINTS);
    if (!A) return;
    proportionOffsets(this.personaShapeNorm, neutral, 468, PROPORTION_MAX_SHIFT, this.proportionOff);
    const realEyes = s.eyeGazeSync;
    if (!this.proportionW || this.proportionW.topology !== this.topology || this.proportionW.realEyes !== realEyes) {
      this.proportionW = { topology: this.topology, realEyes, w: proportionWeights(this.topology, realEyes) };
    }
    this.proportionRamp = Math.min(1, this.proportionRamp + 1 / 30);
    // The persona's frontal layout applies near frontal. On a turn or a tilt the bank's turned or
    // tilted shot already carries the persona's geometry for that pose, and the frontal offsets
    // (mapped by one affine) tore the far side of the jaw and the lower lip.
    const [sr, sl] = jawSideScale(this.smoothed);
    const pose = Math.min(sr, sl) * (1 - smoothstep(8, 20, Math.abs(pitchDeg)));
    applyProportions(this.warpPositions, this.proportionOff, this.proportionW.w, this.topology.lipWeights, lipFade, [A[0], A[1], A[2], A[3]], clamp(s.featureBlend ?? 0.8, 0, 1) * this.proportionRamp * pose);
  }

  /**
   * R6b (flag lidPassThrough): widens the eye pass-through over the upper lid as each lid lowers.
   * Uploads new weights only when a lid moved noticeably; restores the plain ring when off.
   */
  private updateLidPassThrough(on: boolean, k: LandmarkKinematics, bs: Record<string, number>, headDown: number) {
    const radius = this.settings.eyePassThroughRadius;
    if (!on) {
      if (this.lidLast[0] >= 0) {
        this.warp.setEyeFade(eyeFadeWeights(this.topology, radius));
        this.lidLast = [-1, -1];
      }
      return;
    }
    const [cl, cr] = this.lidClosure.update(
      k.earLeft,
      k.earRight,
      k.gazeY,
      [bs.eyeBlinkLeft ?? 0, bs.eyeBlinkRight ?? 0],
      [bs.eyeLookDownLeft ?? 0, bs.eyeLookDownRight ?? 0],
      headDown
    );
    if (!this.lidBands || this.lidBands.topology !== this.topology || this.lidBands.radius !== radius) {
      this.lidBands = {
        topology: this.topology,
        radius,
        base: eyeFadeWeights(this.topology, radius),
        bands: upperLidBands(this.topology, radius),
        weights: new Float32Array(this.topology.vertexCount),
      };
      this.lidLast = [-1, -1];
    }
    if (this.lidLast[0] < 0 || Math.abs(cl - this.lidLast[0]) > 0.03 || Math.abs(cr - this.lidLast[1]) > 0.03) {
      lidPassThroughWeights(this.lidBands.base, this.lidBands.bands, cl, cr, this.lidBands.weights);
      this.warp.setEyeFade(this.lidBands.weights);
      this.lidLast = [cl, cr];
    }
  }

  /** A keyframe's UVs for the current topology; the same array every frame (its identity marks a change for the renderer). */
  private keyframeUv(kf: ReferenceKeyframe): Float32Array {
    const key = `${kf.id}:${this.foreheadOn ? 'ext' : 'base'}`;
    const cached = this.keyUv.get(key);
    if (cached) return cached;
    // On the extended topology (R4b) a keyframe has no forehead rings: they stay collapsed.
    const uv = this.foreheadOn ? this.collapsedExtension(kf.landmarks) : kf.landmarks;
    this.keyUv.set(key, uv);
    return uv;
  }

  /**
   * R6 (settings cameraBlend / boundaryFeather): the scaled boundary feather for the current
   * topology; 1 keeps the topology's own. R6b (flag jawExtension): where the persona has a beard
   * below the jaw, the jaw rings take a much narrower feather, so the beard is opaque over the
   * wearer's jaw and fades only at its own outer edge.
   */
  private applyBoundaryFeather(turn = this.jawTurnApplied) {
    this.jawTurnApplied = turn;
    const width = resolveLook(this.settings).boundaryFeather;
    const depths = realismFlags.get().jawExtension ? this.jawDepths : null;
    if (width === 1 && (!depths || turn <= 0)) {
      this.warp.setBoundaryFeather(null);
      this.warp.setFeatherBands(null);
      return;
    }
    const w = boundaryFeatherWeights(this.topology, width);
    let bands: Float32Array | null = null;
    if (depths && turn > 0) {
      const narrow = boundaryFeatherWeights(this.topology, JAW_BEARD_FEATHER);
      bands = featherBandWeights(this.topology);
      const plan = this.jawPlanFor();
      for (let k = 0; k < plan.vertex.length; k++) {
        const v = plan.vertex[k];
        const d = depths[plan.oval[k]] ?? 0;
        if (d > 0.05) {
          // Both blend back to the plain feather as the head turns (the push itself is gone by then).
          w[v] = Math.max(w[v], narrow[v] * Math.min(1, d / 0.2) * turn);
          // Outer band: the masks keep the pushed beard on the wearer's face skin (not the background, neck or a hand).
          bands[v * 2] *= 1 - turn;
        }
      }
    }
    this.warp.setBoundaryFeather(w);
    this.warp.setFeatherBands(bands);
  }

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
    this.lastLayout = layout;
    this.overlayDrawnThisFrame = false;
    this.syntheticTeethThisFrame = false;

    // --- 1. Track ---------------------------------------------------------------------------
    profiler.begin('track');
    let tracked: TrackedFace | null = null;
    if (src && this.tracker.ready) {
      tracked = this.tracker.detectVideo(src.source, timestamp);
    }
    profiler.end('track');
    // R4 §1: segment the source every N frames into the EMA masks.
    const segFlags = realismFlags.get();
    const segEvery = Math.max(1, Math.round(settings.segmentEvery ?? 2));
    if (segFlags.segmentation && src && layout && this.segmenter.idle && this.frameIndex % segEvery === 0) {
      profiler.begin('segment');
      // Face crop (R4): the face gets the model's full 256 × 256 instead of ~100 px of a full frame.
      let crop: NormRect = [0, 0, 1, 1];
      if (this.faceVisible) {
        const fb = pointBounds(this.smoothed.subarray(0, 468 * 2));
        let u0 = (fb.minX - layout.offsetX) / layout.drawWidth;
        let u1 = (fb.minX + fb.width - layout.offsetX) / layout.drawWidth;
        if (layout.mirror) {
          const m0 = 1 - u1;
          u1 = 1 - u0;
          u0 = m0;
        }
        const v0 = (fb.minY - layout.offsetY) / layout.drawHeight;
        const v1 = (fb.minY + fb.height - layout.offsetY) / layout.drawHeight;
        this.segCrop = stableCrop(this.segCrop, faceCropRect([u0, v0, u1 - u0, v1 - v0], src.width / src.height));
        crop = this.segCrop;
      } else {
        this.segCrop = null;
      }
      this.segmenter.submitVideo(src.source, timestamp, crop, src.width, src.height);
      profiler.end('segment');
    }
    this.segActive = segFlags.segmentation && this.segmenter.ready && this.masks.updates > 0;
    if (tracked && layout) {
      this.matrixPose = driverPoseFromMatrix(tracked.transform, layout.mirror);
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
    const drawBase = (x: number, y: number, w: number, h: number) => {
      if (src && layout) this.drawSource(ctx, src.source, layout, x, y, w, h);
      else this.drawStandby(ctx, x, y, w, h);
    };

    const overlayReady = !!(kinematics && this.faceVisible && this.lastFace && this.warp.hasPersona && this.status.persona === 'ready');
    let singleGl = false;
    if (overlayReady && kinematics && src && layout) {
      profiler.begin('warp');
      this.renderPersonaOverlay(layout, src.source, kinematics, timestamp);
      profiler.end('warp');
      profiler.begin('overlay');
      // R5 §4 (flag singleGlComposite): the camera frame goes under the persona inside the WebGL canvas.
      singleGl = useSingleGlComposite({
        flag: realismFlags.get().singleGlComposite,
        viewMode: settings.viewMode,
        overlayReady: true,
        webgl: this.warp.supportsBaseComposite,
        overlayPasses: this.overlayNeeds2dPasses(),
      });
      if (singleGl) {
        // The review tool still gets the persona layer on its own, on the frames it captures.
        if (this.captureDueNow()) {
          this.overlayCtx.clearRect(0, 0, this.overlayLayer.width, this.overlayLayer.height);
          this.overlayCtx.drawImage(this.warp.canvas, 0, 0, this.overlayLayer.width, this.overlayLayer.height);
        }
        singleGl = this.warp.compositeBase({
          source: src.source as TexImageSource,
          srcMap: [layout.offsetX, layout.offsetY, layout.drawWidth, layout.drawHeight],
          mirror: layout.mirror,
          background: [0x0b / 255, 0x12 / 255, 0x20 / 255],
        });
      }
      if (!singleGl) this.composeOverlayLayer();
      profiler.end('overlay');
      this.overlayDrawnThisFrame = true;
    }
    this.singleGlThisFrame = singleGl;
    if (!singleGl) {
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, 0, W, H);
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
      if (singleGl) {
        // One copy of the finished frame; the 2D post pass (off by default) still draws on top.
        ctx.drawImage(this.warp.canvas, 0, 0, W, H);
        profiler.begin('post');
        this.drawRealisticPostPass(ctx, 0, 0, W, H, metrics);
        profiler.end('post');
      } else {
        drawBase(0, 0, W, H);
        drawOverlay(0, 0, W, H);
      }
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
    this.hairline.reset();
    this.hairlineSegSeen = -1;
    this.foreheadStrength = 0;
    this.foreheadClock = null;
    this.foreheadWearer = null;
    this.foreheadShown = null;
    this.prevHeadCenter = null;
    this.headVelocity = { x: 0, y: 0 };
    this.lastFace = null;
    this.faceVisible = false;
    this.framesSinceFace = 0;
    this.neutralMouthWidth = null;
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
    k: LandmarkKinematics,
    timestamp: number
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
      // R5 §5 (flag matrixHeadPose): select by the pose from MediaPipe's transformation matrix when it is there.
      const mp = flags.matrixHeadPose ? this.matrixPose : null;
      const queryResult = this.referenceBank.query({
        yaw: mp ? mp.yaw : k.yaw,
        pitch: mp ? mp.pitch : k.pitch,
        roll: mp ? mp.roll : k.roll,
        mar: k.mar,
        smile: smileScore,
        browElevation: bs.browInnerUp ?? 0,
      });

      if (this.realKeyframes && flags.keyframeCrossfade) {
        // R5 §1: both keyframes are already on the GPU; a switch changes the bound pair and the mix, nothing is uploaded.
        const fade = this.keyFader.update(queryResult.primary.id, timestamp);
        const all = this.referenceBank.getKeyframes();
        const a = all.find((kf) => kf.id === fade.primary) ?? queryResult.primary;
        const b = fade.secondary ? all.find((kf) => kf.id === fade.secondary) ?? null : null;
        this.warp.setKeyframePair({ image: a.source, uv: this.keyframeUv(a) }, b ? { image: b.source, uv: this.keyframeUv(b) } : null, fade.secondaryWeight);
        this.currentKeyframeId = a.id;
        this.currentKeyframeSource = a.source;
        this.keyframeSecondaryId = b ? b.id : null;
        this.keyframeMix = b ? fade.secondaryWeight : 0;
      } else if (queryResult.primary.id !== this.currentKeyframeId) {
        // UVs only change when the bank picks a different keyframe; skip the per-frame GPU upload otherwise.
        // On the extended topology (R4b) a bank keyframe has no forehead rings: they stay collapsed.
        this.warp.updateUVs(this.foreheadOn ? this.collapsedExtension(queryResult.primary.landmarks) : queryResult.primary.landmarks);
        this.currentKeyframeId = queryResult.primary.id;
      }
      if (!(this.realKeyframes && flags.keyframeCrossfade) && queryResult.primary.source !== this.currentKeyframeSource) {
        this.warp.updateTexture(queryResult.primary.source);
        this.currentKeyframeSource = queryResult.primary.source;
      }
    }

    // R3 (flag relight): the shader relights the persona from the real frame. Without it (lighting
    // adaptation off, the flag off for diagnostics, or a GPU whose relight programs did not compile)
    // the persona keeps its photo's own lighting; the R0 5-zone CPU gain was removed in R6.
    const relightOn = flags.relight && s.lightingAdaptation && this.warp.supportsRelight;

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

    // "Keep my real mouth": fade the persona lip band as the mouth opens (R1 §2); with restMouth
    // (R3 item 1) the thresholds sit above the wearer's learned resting aperture.
    const fadeWindow = lipFadeWindow(flags.restMouth ? this.restMouth.rest : null);
    let lipFade = flags.realMouth && s.keepRealMouth ? lipFadeForMar(k.mar, resolveLook(s).lipFadeFloor, fadeWindow.start, fadeWindow.end) : 0;
    // R6b (flag lidPassThrough): the pose decides what passes through. Looking up past the
    // enrollment's chin-up shot (about 15°) the persona's lips would be stretched and lit beyond any
    // photo, so the real lips show; chin down raises the eyelid pass-through (see updateLidPassThrough).
    const pitchDeg = flags.matrixHeadPose && this.matrixPose ? this.matrixPose.pitch : k.pitch;
    if (flags.lidPassThrough && flags.realMouth && s.keepRealMouth) lipFade = Math.max(lipFade, smoothstep(12, 28, -pitchDeg));
    // R4 §4: foreshortening from the tracked mesh against the persona's own (un-pushed) UVs, before
    // the R6b proportion and jaw changes, which squash some triangles on purpose and must not fade them.
    const fsUv = this.warp.personaUvs ? this.jawUvBase.get(this.warp.personaUvs) ?? this.warp.personaUvs : null;
    const foreshorten =
      flags.foreshortenFade && fsUv
        ? (this.foreshorten = copyColumnWeights(foreshortenWeights(this.warpPositions, fsUv, this.baseTopology.triangles, this.topology.vertexCount, this.foreshorten ?? undefined)))
        : undefined;
    // R6b (flag seamFade): the side-of-face silhouette weights of the photo in use multiply in.
    const seam = flags.seamFade && this.warp.personaUvs ? this.seamWeights.get(this.warp.personaUvs) : undefined;
    let vertexFade = foreshorten;
    if (seam) {
      const n = this.topology.vertexCount;
      if (!this.seamScratch || this.seamScratch.length !== n) this.seamScratch = new Float32Array(n);
      for (let v = 0; v < n; v++) this.seamScratch[v] = (foreshorten ? foreshorten[v] : 1) * (v < seam.length ? seam[v] : 1);
      vertexFade = this.seamScratch;
    }
    // R6b: the persona's interior proportions, then its beard below the jaw line (before the bounds and the forehead rings).
    if (flags.personaProportions) {
      const smile = ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2;
      this.applyPersonaProportions(k, lipFade, smile, pitchDeg);
    }
    if (flags.jawExtension && this.jawDepths) {
      // Tilts (roll, strong pitch) fade the push like turns: there the masks' jaw/neck line is irregular and cut it hard.
      const rollDeg = flags.matrixHeadPose && this.matrixPose ? this.matrixPose.roll : k.roll;
      const tilt = jawPoseScale(rollDeg, pitchDeg);
      applyJawExtension(this.warpPositions, this.jawPlanFor(), this.jawDepths, undefined, tilt);
      // The jaw's narrow feather and face-skin band follow the turn and tilt in 0.1 steps (a re-upload of two small buffers).
      const [sr, sl] = jawSideScale(this.smoothed);
      const turn = Math.round(Math.min(sr, sl) * tilt * 10) / 10;
      if (turn !== this.jawTurnApplied) this.applyBoundaryFeather(turn);
    }

    const bounds = pointBounds(this.warpPositions.subarray(0, 468 * 2));
    const strength = clamp(s.blendStrength / 100, 0, 1);
    // R6b (flag lidPassThrough): the real eyes stay through blinks and look-downs, with the lid band
    // widened over the closing lid; otherwise nearly closed eyes switch to the persona's (R1 §6),
    // whose open-eye lid and crease then showed as pale arcs.
    const drawPersonaEyes = !s.eyeGazeSync || (!flags.lidPassThrough && k.earLeft < 0.18 && k.earRight < 0.18);
    // Eye pass-through ring: only while the wearer's real eyes are showing (R1 §6).
    const eyeFade = flags.eyePassThrough && !drawPersonaEyes ? 1 : 0;
    // R6b: the ring widens over the upper lid as the lid lowers, and with the chin down from the wearer's own level pose.
    const yawDeg = flags.matrixHeadPose && this.matrixPose ? this.matrixPose.yaw : k.yaw;
    this.pitchBaseline.update(pitchDeg, yawDeg);
    this.lastHeadDown = this.pitchBaseline.headDown(pitchDeg);
    this.updateLidPassThrough(flags.lidPassThrough && eyeFade > 0, k, bs, this.lastHeadDown);
    // Closed-lip mask (R2): persona lips end at the wearer's lip contour while the mouth is closed.
    const closedLipMask = flags.closedLipMask && s.keepRealMouth ? 1 : 0;
    this.lastLipFade = lipFade;

    const cameraMatchOn = flags.cameraMatch && this.warp.supportsReadback;
    this.warp.pollReadbacks();
    // R3c: the relight radius comes from the auto loop (flag autoRadius) or the setting; R6b's
    // illumination-only relighting uses its own large-scale radius.
    const illumination = flags.relightIllumination && relightOn;
    // R6b (flag photoLighting): under the illumination relight the radius follows its own loop
    // (10% down to 3.5% while the output's cheek tone or side shading is out of line).
    this.illumLoopActive = illumination && flags.photoLighting && s.illuminationRadius === undefined;
    const radiusShare = illumination
      ? s.illuminationRadius !== undefined
        ? clamp(s.illuminationRadius, 0.02, 0.2)
        : this.illumLoopActive
          ? this.illumRadius.radius
          : ILLUMINATION_RADIUS_SHARE
      : flags.autoRadius && relightOn
        ? this.autoRadius.radius
        : clamp(s.relightRadius, 0.02, 0.2);
    if (relightOn && flags.symmetricDelight && this.delightBands && Math.abs(radiusShare - this.delightRadius) > 0.001) {
      this.warp.setDelight(symmetricDelightGains(this.delightBands[0], lumaAtScale(this.delightBands, radiusShare)));
      this.delightRadius = radiusShare;
    }
    // R4b: place the forehead rings from the calibrated hairline (after every other vertex adjustment).
    const forehead = this.foreheadOn ? this.updateForehead(layout, k, timestamp) : undefined;
    this.warp.render({
      positions: this.warpPositions,
      opacity: Math.pow(strength, 0.55),
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
            // R6b (flag photoLighting): a colour cast in the persona photo raises its hue match.
            toneMatch: clamp(Math.max(s.skinToneMatch, flags.photoLighting ? this.personaLighting?.cast ?? 0 : 0), 0, 1),
            toneBudget: illumination ? Math.max(0, s.toneBudget ?? TONE_BUDGET_DEFAULT) : 0,
            radiusShare,
            globalTone: flags.relightGlobalTone && !illumination,
            shadowGuard: flags.relightShadowGuard,
            illumination,
            specular: illumination,
            hairDetail: illumination ? 0.75 : 0,
            // R4b: hair leaves the driver low pass only as far as the extension is in, so an inactive extension renders as R4.
            excludeHair: this.foreheadOn && this.segActive ? this.foreheadStrength : 0,
          }
        : undefined,
      motionBlurPx: flags.motionBlur ? [this.headVelocity.x * MOTION_BLUR_EXPOSURE, -this.headVelocity.y * MOTION_BLUR_EXPOSURE] : undefined,
      softHoles: flags.softHoles,
      segmentation: this.segActive
        ? { masks: this.masks, dirty: this.masksDirty, srcMap: [layout.offsetX, layout.offsetY, layout.drawWidth, layout.drawHeight], mirror: layout.mirror, strength: clamp(s.segmentationStrength ?? 1, 0, 1) }
        : undefined,
      twoBand: flags.twoBandBlend && relightOn,
      forehead,
      skinTint: flags.skinTint && illumination ? clamp(s.skinTintStrength ?? SKIN_TINT_MAX, 0, SKIN_TINT_MAX) : undefined,
      // R4b: the weights come from the base triangles only; the extension rings copy their column (see copyColumnWeights).
      foreshorten: vertexFade,
      softFaceEdge: flags.jawExtension && !!this.jawDepths,
      handGuard: flags.jawExtension,
    });
    this.masksDirty = false;

    // R3c: the auto-radius readbacks sit between the camera-match ones.
    const loopOn = (flags.autoRadius && relightOn && !illumination) || this.illumLoopActive;
    if (loopOn && this.warp.supportsReadback && !this.autoRadiusPending && this.frameIndex % AUTO_RADIUS_EVERY === 7) {
      this.stepAutoRadiusLoop(layout, source, k, bounds, flags.steadyCameraMatch && headSpeed > CAMERA_MATCH_HOLD_SPEED * k.faceWidth, this.illumLoopActive);
    }

    // R2 §4: every 15 frames read the wearer's and the persona's face-region statistics back
    // asynchronously and step the control loop when both have arrived.
    const cameraMatchNow = flags.cameraMatchMedian
      ? cameraMatchDueSettled(this.frameIndex, this.frameIndex - this.cameraMatchChangeFrame)
      : cameraMatchDue(this.frameIndex, this.cameraMatchWarm);
    if (cameraMatchOn && !this.cameraMatchPending && cameraMatchNow) {
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
      const srcWindow: [number, number] = [win / layout.drawWidth, win / layout.drawHeight];
      // Output first: both readbacks go through the same source texture.
      const stats: Promise<[FaceStats | null, FaceStats | null]> = flags.cameraMatchSameMask
        ? Promise.all([this.warp.readFacePixels(faceRect, true), this.warp.readSourcePixels(source as TexImageSource, srcRect, srcWindow)]).then(([op, dp]) => {
            if (!op || !dp) return [null, null];
            const p = pairedFaceStats(op, dp, READBACK_SIZE, READBACK_SIZE, { mirror: layout.mirror });
            return [p.driver, p.output];
          })
        : (() => {
            const output = this.warp.readFaceStats(faceRect);
            const driver = this.warp.readSourceFaceStats(source as TexImageSource, srcRect, srcWindow);
            return Promise.all([driver, output]);
          })();
      void stats.then(([d, o]) => {
        this.cameraMatchPending = false;
        if (this.disposed || token !== this.personaPrepareToken || !d || !o) return;
        this.cameraMatch = stepCameraMatch(this.cameraMatch, d, o, 0.35, {
          steady,
          hold,
          median: realismFlags.get().cameraMatchMedian,
          sharpnessTarget: this.settings.cameraMatchSharpness ?? 1,
          noiseTarget: this.settings.cameraMatchNoise ?? 1,
        });
        if (this.cameraMatchWarm > 0) this.cameraMatchWarm--;
        if (this.cameraMatchTrace.length >= 1024) this.cameraMatchTrace.shift();
        this.cameraMatchTrace.push(this.cameraMatch.lodBias);
      });
    }
  }

  /**
   * R4 persona inpaint: masks hair and accessories (from the segmenter) inside the slightly dilated
   * face oval of the persona texture and fills them from the surrounding skin. Returns the new
   * texture canvas and the share of the oval that was replaced, or null when the segmenter is off.
   */
  /** Starts the segmentation worker once a flag that needs it is on (and the tracker has loaded). */
  private ensureSegmenter() {
    const f = realismFlags.get();
    if (!(f.segmentation || f.personaInpaint || f.foreheadExtension) || this.status.model !== 'ready') return;
    void this.segmenter.load(this.settings.segmentCpu ? 'CPU' : 'GPU', this.masks, () => {
      this.masksDirty = true;
      this.segUpdates++;
    });
  }

  /**
   * R4b: selects the base or the extended topology for the current flags. The extension needs the
   * shader (segmentation masks, hairline feather), so the Canvas 2D fallback keeps the base mesh.
   */
  private applyForeheadTopology() {
    const on = realismFlags.get().foreheadExtension && this.warp.usesWebGL;
    if (on && !this.extTopology) this.extTopology = extendTopology(this.baseTopology);
    const topology = on ? this.extTopology! : this.baseTopology;
    const changed = topology !== this.topology || on !== this.foreheadOn;
    this.foreheadOn = on;
    this.topology = topology;
    this.foreshorten = null;
    this.foreheadStrength = 0;
    this.foreheadClock = null;
    // No mapping until the persona has been prepared for this topology.
    this.foreheadWearer = null;
    this.foreheadShown = null;
    this.warp.setTopology(topology);
    this.warp.setEyeFade(eyeFadeWeights(topology, this.settings.eyePassThroughRadius));
    this.applyBoundaryFeather();
    // The UV set must cover every vertex the topology indexes until the persona is prepared again.
    const uvs = this.warp.personaUvs;
    if (changed && on && uvs && uvs.length < EXT_VERTEX_COUNT * 2) this.warp.updateUVs(this.collapsedExtension(uvs));
    this.personaUvExt = null;
  }

  /** A UV or position set padded for the extended topology with the forehead rings collapsed onto the oval. */
  private collapsedExtension(points: Float32Array): Float32Array {
    const out = padPoints(points);
    extendForehead(out, NO_EXTENSION, 0);
    return out;
  }

  /**
   * R4b §3: maps the persona's brow-to-hairline span onto the wearer's. Runs when either hairline
   * changes (persona load, wearer calibration) or the stretch-guard limits do: the guard gives the
   * wearer-side ratios used every frame and the persona-side ratios the extension UVs are placed from.
   */
  private applyForeheadMapping() {
    const uv = this.personaUvExt;
    if (!this.foreheadOn || !uv) return;
    const persona = this.personaRatios;
    const wearer = this.hairline.ratios;
    let personaSide: ArrayLike<number> = persona ?? NO_EXTENSION;
    this.foreheadWearer = null;
    this.foreheadClamped = 0;
    if (persona && wearer) {
      const c = stretchClamp(wearer, persona, clamp(this.settings.foreheadStretchMin ?? STRETCH_MIN, 0.3, 1), clamp(this.settings.foreheadStretchMax ?? STRETCH_MAX, 1, 3));
      this.foreheadWearer = c.wearer;
      this.foreheadClamped = c.clamped;
      personaSide = c.persona;
    }
    extendForehead(uv, personaSide, 1, this.personaTexSize.height / Math.max(1, this.personaTexSize.width));
    for (let i = EXT_MID_START * 2; i < EXT_VERTEX_COUNT * 2; i++) uv[i] = clamp(uv[i], 0, 1);
    this.warp.updateUVs(uv);
  }

  /**
   * R4b §1, per frame: feeds the hairline calibration (a mask measurement only when the masks
   * changed and the face is frontal), grows the extension in once both hairlines are known, and
   * writes the two forehead rings into the warp positions from the stored ratios.
   */
  private updateForehead(layout: SourceLayout, k: LandmarkKinematics, timestamp: number): { strength: number; featherPx: number } {
    const s = this.settings;
    const masksDrive = this.segActive && (s.segmentationStrength ?? 1) > 0.5;
    const frontal = isHairlineFrontal(k.yaw, k.pitch);
    let sample: Array<number | null> | null = null;
    if (masksDrive && this.segUpdates !== this.hairlineSegSeen) {
      this.hairlineSegSeen = this.segUpdates;
      if (frontal) {
        const W = this.canvas.width;
        const m = this.masks;
        sample = measureHairlineRatios(this.smoothed, (x, y) => {
          const u = ((layout.mirror ? W - x : x) - layout.offsetX) / layout.drawWidth;
          const v = (y - layout.offsetY) / layout.drawHeight;
          if (u < m.rect[0] || u > m.rect[0] + m.rect[2] || v < m.rect[1] || v > m.rect[1] + m.rect[3]) return null;
          return { hair: sampleMask(m, 0, u, v), skin: Math.max(sampleMask(m, 2, u, v), sampleMask(m, 1, u, v)) };
        });
      }
    }
    const frame = foreheadFrame(this.smoothed);
    if (this.hairline.push(sample, { frontal, t: timestamp, spanOverFaceHeight: frame ? frame.span / Math.max(1, k.faceHeight) : 0.3 })) this.applyForeheadMapping();

    // Active once the wearer and the persona hairlines are both known; real keyframes get their own calibration in R5.
    const active = masksDrive && !!this.foreheadWearer && this.referenceBank.getKeyframes().length === 0;
    const dt = this.foreheadClock === null ? 0 : clamp(timestamp - this.foreheadClock, 0, 100);
    this.foreheadClock = timestamp;
    this.foreheadStrength = clamp(this.foreheadStrength + (active ? dt : -dt) / FOREHEAD_RAMP_MS, 0, 1);
    // A recalibration moves the rings to the new hairline over a few frames instead of in one step.
    const target = this.foreheadWearer;
    if (!target) {
      if (this.foreheadStrength === 0) this.foreheadShown = null;
    } else if (!this.foreheadShown || this.foreheadStrength === 0) {
      this.foreheadShown = [...target];
    } else {
      const a = Math.min(1, dt / FOREHEAD_SETTLE_MS);
      for (let c = 0; c < EXT_COLUMNS; c++) this.foreheadShown[c] += (target[c] - this.foreheadShown[c]) * a;
    }
    extendForehead(this.warpPositions, this.foreheadShown ?? NO_EXTENSION, this.foreheadStrength);
    return { strength: this.foreheadStrength, featherPx: clamp(s.hairlineFeather ?? 0.025, 0.005, 0.1) * k.faceHeight };
  }

  private async inpaintPersona(
    texture: HTMLImageElement | HTMLCanvasElement,
    uv: Float32Array,
    opts: { inpaint: boolean; forehead: boolean }
  ): Promise<{ canvas: HTMLCanvasElement; share: number; ratios: number[] | null; measured: Array<number | null> | null } | null> {
    this.ensureSegmenter();
    // The worker takes ~10 s to start on this laptop (model, WASM, GPU graph); persona preparation can wait for it.
    for (let i = 0; i < 60 && !this.segmenter.ready && !this.segmenter.error; i++) await new Promise((r) => setTimeout(r, 500));
    if (!this.segmenter.ready) return null;
    const tw0 = texture instanceof HTMLImageElement ? texture.naturalWidth : texture.width;
    const th0 = texture instanceof HTMLImageElement ? texture.naturalHeight : texture.height;
    const ub = pointBounds(uv.subarray(0, 468 * 2));
    const masks = await this.segmenter.segmentImage(texture, faceCropRect([ub.minX, ub.minY, ub.width, ub.height], tw0 / th0, 1.5));
    if (!masks) return null;
    const tw = texture instanceof HTMLImageElement ? texture.naturalWidth : texture.width;
    const th = texture instanceof HTMLImageElement ? texture.naturalHeight : texture.height;
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    const cctx = c.getContext('2d', { willReadFrequently: true })!;
    cctx.drawImage(texture, 0, 0, tw, th);
    const px = cctx.getImageData(0, 0, tw, th);
    // Face oval (dilated 5%) in texture pixels.
    const oval = FACE_OVAL_RING.map((i) => ({ x: uv[i * 2] * tw, y: uv[i * 2 + 1] * th }));
    const cx = oval.reduce((s, p) => s + p.x, 0) / oval.length, cy = oval.reduce((s, p) => s + p.y, 0) / oval.length;
    const grown = oval.map((p) => ({ x: cx + (p.x - cx) * 1.05, y: cy + (p.y - cy) * 1.05 }));
    const minX = Math.max(0, Math.floor(Math.min(...grown.map((p) => p.x)))), maxX = Math.min(tw - 1, Math.ceil(Math.max(...grown.map((p) => p.x))));
    const minY = Math.max(0, Math.floor(Math.min(...grown.map((p) => p.y)))), maxY = Math.min(th - 1, Math.ceil(Math.max(...grown.map((p) => p.y))));
    // R4b §2: the persona's hairline per column, and the forehead polygon up to it (texture pixels).
    let ratios: number[] | null = null;
    let measured: Array<number | null> | null = null;
    let forehead: Array<{ x: number; y: number }> | null = null;
    if (opts.forehead) {
      const pts = new Float32Array(EXT_VERTEX_COUNT * 2);
      for (let i = 0; i < Math.min(TRACKED_POINT_COUNT, uv.length / 2); i++) {
        pts[i * 2] = uv[i * 2] * tw;
        pts[i * 2 + 1] = uv[i * 2 + 1] * th;
      }
      measured = measureHairlineRatios(
        pts,
        (x, y) => {
          const u = x / tw, v = y / th;
          if (u < masks.rect[0] || u > masks.rect[0] + masks.rect[2] || v < masks.rect[1] || v > masks.rect[1] + masks.rect[3]) return null;
          return { hair: sampleMask(masks, 0, u, v), skin: Math.max(sampleMask(masks, 2, u, v), sampleMask(masks, 1, u, v)) };
        },
        // Hair right on the oval is a fringe: it is filled below and the column takes its neighbours' ratio.
        { startsInHair: 'ambiguous' }
      );
      ratios = smoothHairlineRatios(fillAmbiguousRatios(measured));
      extendForehead(pts, ratios);
      forehead = foreheadPolygon(pts);
    }
    const mask = new Uint8Array(tw * th);
    /** Pixels masked because they were hair (not glasses): their alpha is lowered after the fill (R4b §2). */
    const hairFill = opts.forehead ? new Uint8Array(tw * th) : null;
    let inside = 0, masked = 0, filled = 0;
    const insidePoly = (x: number, y: number) => {
      let inn = false;
      for (let i = 0, j = grown.length - 1; i < grown.length; j = i++) {
        const a = grown[i], b = grown[j];
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inn = !inn;
      }
      return inn;
    };
    // The scan covers the oval and, with the extension, the forehead above it.
    const fMinX = forehead ? Math.max(0, Math.floor(Math.min(...forehead.map((p) => p.x)))) : minX;
    const fMaxX = forehead ? Math.min(tw - 1, Math.ceil(Math.max(...forehead.map((p) => p.x)))) : maxX;
    const fMinY = forehead ? Math.max(0, Math.floor(Math.min(...forehead.map((p) => p.y)))) : minY;
    const fMaxY = forehead ? Math.min(th - 1, Math.ceil(Math.max(...forehead.map((p) => p.y)))) : maxY;
    for (let y = Math.min(minY, fMinY); y <= Math.max(maxY, fMaxY); y++) {
      for (let x = Math.min(minX, fMinX); x <= Math.max(maxX, fMaxX); x++) {
        const inOval = opts.inpaint && insidePoly(x + 0.5, y + 0.5);
        const inForehead = !inOval && !!forehead && insidePolygon(forehead, x + 0.5, y + 0.5);
        if (!inOval && !inForehead) continue;
        const u = (x + 0.5) / tw, v = (y + 0.5) / th;
        const hair = sampleMask(masks, 0, u, v) >= 0.5;
        if (inOval) {
          // The share reported by the quality gate stays the oval's (R4).
          inside++;
          if (hair || sampleMask(masks, 3, u, v) >= 0.5) {
            mask[y * tw + x] = 1;
            masked++;
            filled++;
          }
        } else if (hair) {
          mask[y * tw + x] = 1;
          filled++;
        }
        // Only above the oval: inside it the texture stays exactly what R4 (personaInpaint) renders.
        if (hair && hairFill && inForehead && mask[y * tw + x]) hairFill[y * tw + x] = 1;
      }
    }
    if (!filled) return { canvas: c, share: 0, ratios, measured };
    // Grow by 1.5 mask pixels so the soft, blurred edge of a frame or strand goes with it.
    const radius = Math.max(2, Math.round((1.5 * masks.rect[2] * tw) / masks.width));
    const grownMask = dilateMask(mask, tw, th, radius);
    inpaintMasked(px.data, tw, th, grownMask);
    if (hairFill) {
      // Filled hair is invented skin: the persona is slightly more transparent there.
      const grownHair = dilateMask(hairFill, tw, th, radius);
      for (let i = 0; i < grownHair.length; i++) if (grownHair[i]) px.data[i * 4 + 3] = Math.min(px.data[i * 4 + 3], FRINGE_FILL_ALPHA);
    }
    cctx.putImageData(px, 0, 0);
    return { canvas: c, share: inside ? masked / inside : 0, ratios, measured };
  }

  /**
   * R3c auto-radius loop: every AUTO_RADIUS_EVERY frames read the face-and-neck region of the
   * persona layer and of the driver back (asynchronously, like the camera match), measure the
   * side-shading gap and the cheek-vs-neck ΔE on both, and step the radius.
   */
  private stepAutoRadiusLoop(
    layout: SourceLayout,
    source: CanvasImageSource,
    k: LandmarkKinematics,
    bounds: { minX: number; minY: number; width: number; height: number },
    hold: boolean,
    illum = false
  ) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    // Display rectangle: the face box widened by 10% each side and extended below the chin for the neck patch.
    const x0 = clamp(bounds.minX - 0.1 * bounds.width, 0, W - 1);
    const y0 = clamp(bounds.minY, 0, H - 1);
    const x1 = clamp(bounds.minX + 1.1 * bounds.width, x0 + 1, W);
    const y1 = clamp(bounds.minY + bounds.height * 1.45, y0 + 1, H);
    const rect: [number, number, number, number] = [x0, y0, x1 - x0, y1 - y0];
    let sx0 = (x0 - layout.offsetX) / layout.drawWidth;
    let sx1 = (x1 - layout.offsetX) / layout.drawWidth;
    if (layout.mirror) {
      const m0 = 1 - sx1;
      const m1 = 1 - sx0;
      sx0 = m0;
      sx1 = m1;
    }
    const sy0 = (y0 - layout.offsetY) / layout.drawHeight;
    const sy1 = (y1 - layout.offsetY) / layout.drawHeight;
    const srcRect: [number, number, number, number] = [clamp(sx0, 0, 1), clamp(sy0, 0, 1), clamp(sx1 - sx0, 0.01, 1), clamp(sy1 - sy0, 0.01, 1)];
    const outMap = { x0, y0, w: rect[2], h: rect[3], size: READBACK_SIZE, flipY: true, mirrorX: false };
    const drvMap = { x0, y0, w: rect[2], h: rect[3], size: READBACK_SIZE, flipY: false, mirrorX: layout.mirror };
    const patches = illum ? shadingPatches(this.smoothed, k.faceWidth, k.faceHeight, ILLUM_CHEEKS[0], ILLUM_CHEEKS[1]) : shadingPatches(this.smoothed, k.faceWidth, k.faceHeight);
    const token = this.personaPrepareToken;
    this.autoRadiusPending = true;
    const out = this.warp.readFacePixels(rect);
    const drv = this.warp.readSourcePixels(source as TexImageSource, srcRect);
    void Promise.all([out, drv]).then(([o, d]) => {
      this.autoRadiusPending = false;
      if (this.disposed || token !== this.personaPrepareToken || !o || !d) return;
      const mo = measureShading(o, outMap, patches, { data: d, mapping: drvMap });
      const md = measureShading(d, drvMap, patches);
      this.autoRadiusLast = {
        sideOut: mo?.side ?? null, sideDrv: md?.side ?? null, neckOut: mo?.neck ?? null, neckDrv: md?.neck ?? null,
        cheekOutL: mo?.cheek[0] ?? null, cheekDrvL: md?.cheek[0] ?? null,
      };
      if (!mo || !md || mo.neck === null || md.neck === null) return;
      const sample = { sideOut: mo.side, sideDrv: md.side, neckOut: mo.neck, neckDrv: md.neck };
      if (illum) this.illumRadius = stepAutoRadius(this.illumRadius, sample, { hold, min: ILLUM_RADIUS_MIN, max: ILLUM_RADIUS_MAX, proportional: true });
      else this.autoRadius = stepAutoRadius(this.autoRadius, sample, { hold });
      if (this.autoRadiusTrace.length >= 1024) this.autoRadiusTrace.shift();
      this.autoRadiusTrace.push(illum ? this.illumRadius.radius : this.autoRadius.radius);
    });
  }

  /**
   * Copies the warp output onto the transparent overlay layer and runs the alpha-only boundary
   * passes there. `destination-out` on this layer erases persona alpha so the driver's hairline
   * shows through after compositing; on the opaque output canvas it would only darken pixels.
   */
  /** True when the persona layer needs a 2D pass this frame (the geometric hairline fades, used without segmentation masks). */
  private overlayNeeds2dPasses(): boolean {
    const flags = realismFlags.get();
    const segDrives = this.segActive && (this.settings.segmentationStrength ?? 1) > 0.5;
    const stackedFades = !segDrives && this.foreheadStrength === 0;
    return stackedFades && (flags.foreheadHarmonize || flags.hairlineSoften);
  }

  /** True when the review tool captures this frame (a scheduled capture time has passed, or a burst is running). */
  private captureDueNow(): boolean {
    const t = this.captureClock();
    return (this.captureTimes.length > 0 && t >= this.captureTimes[0]) || (!!this.burstPlan && t >= this.burstPlan.start);
  }

  private composeOverlayLayer() {
    const octx = this.overlayCtx;
    const W = this.overlayLayer.width;
    const H = this.overlayLayer.height;
    octx.clearRect(0, 0, W, H);
    octx.drawImage(this.warp.canvas, 0, 0, W, H);
    const flags = realismFlags.get();
    // R4: with segmentation masks driving the hairline, the geometric passes are the fallback only.
    const segDrives = this.segActive && (this.settings.segmentationStrength ?? 1) > 0.5;
    // R4b: with the forehead extension in, the hairline ring's feather is the only transition.
    const stackedFades = !segDrives && this.foreheadStrength === 0;
    if (flags.foreheadHarmonize && stackedFades) CranialBoundaryBlender.harmonizeForeheadBoundary(octx, this.warpPositions);
    if (flags.hairlineSoften && stackedFades) CranialBoundaryBlender.softenHairlineEdges(octx, this.warpPositions);
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
        lightingGain: IDENTITY_GAIN,
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
        warpPositions: Float32Array.from(this.foreheadOn ? this.warpPositions : this.warpPositions.subarray(0, LANDMARK_COUNT * 2)),
        outputLandmarks: null,
        mirror: layout.mirror,
        layout: { offsetX: layout.offsetX, offsetY: layout.offsetY, drawWidth: layout.drawWidth, drawHeight: layout.drawHeight },
        masks: this.segActive ? { width: this.masks.width, height: this.masks.height, data: Uint8ClampedArray.from(this.masks.data), rect: [...this.masks.rect] as NormRect } : null,
        mar: this.lastMar,
        pose: { ...this.lastPose },
        isSpeaking: this.lastMetrics?.isSpeaking ?? false,
        isSmiling: this.lastMetrics?.isSmiling ?? false,
        syntheticTeeth: this.syntheticTeethThisFrame,
        keyframeId: this.currentKeyframeId,
        keyframeSecondaryId: this.keyframeSecondaryId,
        keyframeMix: this.keyframeMix,
        matrixPose: this.matrixPose ? { ...this.matrixPose } : null,
        lidClosure: this.lidLast[0] >= 0 ? [this.lidLast[0], this.lidLast[1]] : null,
        headDown: this.lastHeadDown,
      });
    }
    const plan = this.burstPlan;
    if (plan && t >= plan.start) {
      if (!this.burst) this.burst = { start: plan.start, scale: plan.scale, frames: [] };
      const snap = this.snapshot(plan.scale, src, layout);
      this.burst.frames.push({
        t,
        frameIndex: this.frameIndex,
        output: snap.output,
        driver: snap.driver,
        landmarks: snap.landmarks,
        // R4b: the persona layer and the masks of this very frame, for the frame-to-frame hairline jitter.
        overlay: this.overlayDrawnThisFrame ? snap.overlay : null,
        masks: this.segActive ? { width: this.masks.width, height: this.masks.height, data: Uint8ClampedArray.from(this.masks.data), rect: [...this.masks.rect] as NormRect } : null,
        mirror: layout.mirror,
        layout: { offsetX: layout.offsetX * plan.scale, offsetY: layout.offsetY * plan.scale, drawWidth: layout.drawWidth * plan.scale, drawHeight: layout.drawHeight * plan.scale },
        pose: { ...this.lastPose },
      });
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
          personaDelightRange: this.personaDelightRange,
          photoLighting: this.personaLighting
            ? (({ asymmetry, asymmetryL, asymmetryAb, hue, chroma, strength, cast }) => ({ asymmetry, asymmetryL, asymmetryAb, hue, chroma, strength, cast }))(this.personaLighting)
            : null,
          toneFloor: this.warp.toneFloor,
          autoRadius: this.illumLoopActive ? { ...this.illumRadius } : realismFlags.get().autoRadius ? { ...this.autoRadius } : null,
          autoRadiusTrace: [...this.autoRadiusTrace],
          autoRadiusLast: this.autoRadiusLast,
          relightRadius: this.illumLoopActive ? this.illumRadius.radius : realismFlags.get().autoRadius ? this.autoRadius.radius : this.settings.relightRadius,
          symmetricDelight: !!this.delightBands,
          segmentation: { ready: this.segmenter.ready, active: this.segActive, updates: this.segUpdates, backend: this.segmenter.backend, error: this.segmenter.error, lastMs: this.segmenter.lastMs, lastPackMs: this.segmenter.lastPackMs, bitmapMs: this.segmenter.bitmapMs, inferMs: this.segmenter.inferMs, readMs: this.segmenter.readMs, roundTripMs: this.segmenter.roundTripMs, submits: this.segmenter.submits },
          personaInpaintShare: this.personaInpaintShare,
          forehead: this.foreheadOn
            ? {
                strength: this.foreheadStrength,
                calibrations: this.hairline.calibrations,
                collecting: this.hairline.isCollecting,
                samples: this.hairline.sampleCount,
                wearerRatios: this.hairline.ratios ? [...this.hairline.ratios] : null,
                personaRatios: this.personaRatios ? [...this.personaRatios] : null,
                personaMeasured: this.personaRatiosMeasured ? [...this.personaRatiosMeasured] : null,
                effectiveRatios: this.foreheadWearer ? [...this.foreheadWearer] : null,
                clampedColumns: this.foreheadClamped,
                disagreement: this.hairline.lastDisagreement,
              }
            : null,
          renderer: this.status.renderer,
          pose: { ...this.lastPose },
          isSpeaking: this.lastMetrics?.isSpeaking ?? false,
          isSmiling: this.lastMetrics?.isSmiling ?? false,
          keyframeId: this.currentKeyframeId,
          keyframeCount: this.referenceBank.getKeyframes().length,
          r5: {
            realKeyframes: this.realKeyframes,
            keyframeUploads: this.warp.keyframeUploads,
            keyframeSecondaryId: this.keyframeSecondaryId,
            keyframeMix: this.keyframeMix,
            matrixPose: this.matrixPose ? { ...this.matrixPose } : null,
            pacing: this.lastPacing ? pacingMode(realismFlags.get().videoFramePacing, this.videoElement as unknown as PacedVideo | null) : null,
            framesOverwritten: this.pacer.framesOverwritten,
            framesSkipped: this.framesSkipped,
            singleGl: this.singleGlThisFrame,
          },
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

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
import {
  applyEyelidKinematics,
  applyGazeIrisTracking,
  applyPerspectiveForeshortening,
  applySmileBias,
  applySpeechAnatomy,
  buildFaceTopology,
  computeKinematics,
  FaceTopology,
  INNER_LIP_RING,
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
import { FacialLightingZones, MeshWarpRenderer } from './meshWarpRenderer.ts';
import { OralCavityRenderer, extractOralApertureMetrics } from './oralCavityRenderer.ts';
import { MultiReferenceBank } from './multiReferenceBank.ts';
import { CranialBoundaryBlender } from './cranialBoundaryBlender.ts';

export type MetricsCallback = (metrics: FacialMetrics, pose: HeadPose, fps: number, latency: number) => void;
export type StatusCallback = (status: EngineStatus) => void;

const LANDMARK_COUNT = 478;
const RESOLUTIONS: Record<TransformationSettings['outputResolution'], [number, number]> = {
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '540p': [960, 540],
};

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

export class RealtimeFacialEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tracker = new FaceTracker();
  private warp: MeshWarpRenderer;
  private topology: FaceTopology;

  // Sources
  private videoElement: HTMLVideoElement | null = null;
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
  private colorGain: [number, number, number] = [1, 1, 1];
  private zoneLighting: FacialLightingZones = {
    forehead: [1, 1, 1],
    leftCheek: [1, 1, 1],
    rightCheek: [1, 1, 1],
    nose: [1, 1, 1],
    chin: [1, 1, 1],
  };
  private frameIndex = 0;

  // Where the transformed pane sits on the canvas (used to place the mesh overlay)
  private paneTransform = { x: 0, y: 0, scale: 1 };

  // Loop & settings
  private isRunning = false;
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

  constructor(canvas: HTMLCanvasElement, settings: TransformationSettings) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not get 2D context from canvas');
    this.ctx = context;
    this.settings = settings;

    const [w, h] = RESOLUTIONS[settings.outputResolution] ?? RESOLUTIONS['720p'];
    canvas.width = w;
    canvas.height = h;

    this.topology = buildFaceTopology(FACE_TESSELLATION, FACE_OVAL, 468);
    this.warp = new MeshWarpRenderer(w, h);
    this.warp.setTopology(this.topology);
    this.status.renderer = this.warp.usesWebGL ? 'webgl' : 'canvas2d';

    this.demoCanvas = document.createElement('canvas');
    this.demoCanvas.width = 1280;
    this.demoCanvas.height = 720;
    this.demoCtx = this.demoCanvas.getContext('2d')!;

    this.samplerCanvas = document.createElement('canvas');
    this.samplerCanvas.width = 24;
    this.samplerCanvas.height = 24;
    this.samplerCtx = this.samplerCanvas.getContext('2d', { willReadFrequently: true })!;

    const params = smoothingToFilterParams(settings.temporalSmoothing);
    for (let i = 0; i < LANDMARK_COUNT * 2; i++) {
      this.filters.push(new OneEuroFilter(params.minCutoff, params.beta, 1.0));
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
        this.patchStatus({ modelProgress: p.progress, modelMessage: p.message });
      });
      this.patchStatus({ model: 'ready', modelProgress: 1, backend: this.tracker.backend, modelMessage: 'Face tracking ready' });
      // Persona may have been selected while the model was still loading.
      if (this.personaImage && this.status.persona !== 'ready') void this.preparePersona();
    } catch (err) {
      console.error('Face tracker failed to load', err);
      this.patchStatus({
        model: 'error',
        modelMessage: err instanceof Error ? err.message : 'Face tracking engine failed to load',
      });
    }
  }

  public setVideoSource(video: HTMLVideoElement | null) {
    this.videoElement = video;
    this.resetTracking();
    this.patchStatus({ source: video ? 'webcam' : this.demoImage ? 'demo' : 'none' });
  }

  /** Loads the demo subject portrait used when no webcam is active. */
  public loadDemoSubject(url: string = DEMO_SUBJECT_URL) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.demoImage = img;
      this.demoFailed = false;
      if (!this.videoElement) this.patchStatus({ source: 'demo' });
    };
    img.onerror = () => {
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
      if (token !== this.personaPrepareToken) return;
      this.personaImage = img;
      void this.preparePersona();
    };
    img.onerror = () => {
      if (token !== this.personaPrepareToken) return;
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
      const [w, h] = RESOLUTIONS[settings.outputResolution];
      this.canvas.width = w;
      this.canvas.height = h;
      this.warp.resize(w, h);
      this.resetTracking();
    }
    if (prev.lightingAdaptation && !settings.lightingAdaptation) this.colorGain = [1, 1, 1];
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
    this.stop();
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
      if (token !== this.personaPrepareToken) return;
      if (faces.length === 0) {
        this.warp.clearPersona();
        this.patchStatus({
          persona: 'no-face',
          personaMessage: 'No face was found in this persona photo. Use a clear, front-facing portrait.',
        });
        return;
      }
      const face = faces[0];
      this.warp.setPersona(img, face.landmarks);
      this.currentKeyframeSource = img;
      this.personaMean = this.sampleMeanColor(img, face.landmarks, img.naturalWidth, img.naturalHeight, false);

      // Synthesize calibrated multi-angle, multi-expression identity suite for Person A
      this.referenceBank.clear();
      const suite = MultiReferenceBank.synthesizeSuiteFromMaster(img, face.landmarks, this.personaMean);
      for (const kf of suite) {
        this.referenceBank.addKeyframe(kf);
      }

      this.patchStatus({
        persona: 'ready',
        personaMessage: faces.length > 1 ? 'Multiple faces detected — using the most prominent one.' : undefined,
      });
    } catch (err) {
      console.error('Persona analysis failed', err);
      if (token !== this.personaPrepareToken) return;
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

    // --- 1. Track ---------------------------------------------------------------------------
    let tracked: TrackedFace | null = null;
    if (src && this.tracker.ready) {
      tracked = this.tracker.detectVideo(src.source, timestamp);
    }
    if (tracked && layout) {
      this.ingestLandmarks(tracked.landmarks, layout, timestamp);
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
    const { metrics, pose } = this.computeMetrics();

    // --- 3. Compose base frame --------------------------------------------------------------
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const drawBase = (x: number, y: number, w: number, h: number) => {
      if (src && layout) this.drawSource(ctx, src.source, layout, x, y, w, h);
      else this.drawStandby(ctx, x, y, w, h);
    };

    const overlayReady = !!(this.faceVisible && this.lastFace && this.warp.hasPersona && this.status.persona === 'ready');
    if (overlayReady && src && layout) {
      this.renderPersonaOverlay(layout, src.source, src.width, src.height);
    }
    const drawOverlay = (x: number, y: number, w: number, h: number) => {
      if (!overlayReady) return;
      ctx.drawImage(this.warp.canvas, 0, 0, W, H, x, y, w, h);
      this.drawRealisticPostPass(ctx, x, y, w, h, metrics);
    };

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

    // --- 4. Overlays --------------------------------------------------------------------------
    if (settings.showLandmarkOverlay && this.faceVisible) {
      const t = this.paneTransform;
      this.drawLandmarkMesh(ctx, t.x, t.y, t.scale);
      this.drawHeadPoseTripod(ctx, 40, H - 40, pose);
    }

    if (settings.watermarkMandatory) this.drawMandatoryWatermark(ctx, W, H);

    // --- 5. Telemetry ---------------------------------------------------------------------------
    const avgLatency = this.latencyHistory.length
      ? this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length
      : 0;
    this.onMetricsUpdate?.(metrics, pose, Math.round(this.currentFps * 10) / 10, Math.round(avgLatency * 10) / 10);
  }

  // ---------------------------------------------------------------------------------------------
  // Tracking helpers
  // ---------------------------------------------------------------------------------------------

  private ingestLandmarks(normalized: Float32Array, layout: SourceLayout, timestamp: number) {
    const n = Math.min(LANDMARK_COUNT, normalized.length / 2);
    for (let i = 0; i < n; i++) {
      let x = layout.offsetX + normalized[i * 2] * layout.drawWidth;
      const y = layout.offsetY + normalized[i * 2 + 1] * layout.drawHeight;
      if (layout.mirror) x = this.canvas.width - x;
      this.smoothed[i * 2] = this.filters[i * 2].filter(x, timestamp);
      this.smoothed[i * 2 + 1] = this.filters[i * 2 + 1].filter(y, timestamp);
    }
  }

  private resetFilters() {
    for (const f of this.filters) f.reset();
  }

  private resetTracking() {
    this.resetFilters();
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

  private computeMetrics(): { metrics: FacialMetrics; pose: HeadPose } {
    const s = this.settings;
    if (!this.faceVisible || !this.lastFace) {
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
    const k = computeKinematics(this.smoothed, this.neutralMouthWidth);
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

  private renderPersonaOverlay(layout: SourceLayout, source: CanvasImageSource, srcW: number, srcH: number) {
    const s = this.settings;
    this.warpPositions.set(this.smoothed);
    const k = computeKinematics(this.smoothed, this.neutralMouthWidth);

    // 1. Natural smile warmth bias
    if (s.manualSmileBias) {
      applySmileBias(this.warpPositions, s.manualSmileBias, k.faceWidth);
    }

    // 2. Anatomical speech constraints: stabilizes upper lip and mustache structure
    applySpeechAnatomy(this.warpPositions, k.mar, k.faceHeight);

    // 3. 3D perspective foreshortening & multi-angle head pose compensation
    applyPerspectiveForeshortening(
      this.warpPositions,
      k.yaw,
      k.pitch,
      k.faceWidth,
      k.faceHeight,
      k.center
    );

    // 4. Eyelid kinematic blinking: folds persona's real eyelid skin down smoothly when blinking
    const bs = this.lastFace?.blendshapes ?? {};
    applyEyelidKinematics(
      this.warpPositions,
      k.earLeft,
      k.earRight,
      bs.eyeBlinkLeft ?? 0,
      bs.eyeBlinkRight ?? 0
    );

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

      this.warp.updateUVs(queryResult.primary.landmarks);
      if (queryResult.primary.source !== this.currentKeyframeSource) {
        this.warp.updateTexture(queryResult.primary.source);
        this.currentKeyframeSource = queryResult.primary.source;
      }
    }

    if (s.lightingAdaptation && this.frameIndex % 5 === 0) {
      this.updateLightingGain(layout, source, srcW, srcH);
    }

    const bounds = pointBounds(this.warpPositions.subarray(0, 468 * 2));
    const strength = clamp(s.blendStrength / 100, 0, 1);

    this.warp.render({
      positions: this.warpPositions,
      opacity: Math.pow(strength, 0.55),
      colorGain: this.colorGain,
      zoneLighting: this.zoneLighting,
      faceBounds: [bounds.minX, bounds.minY, bounds.width, bounds.height],
      drawPersonaEyes: !s.eyeGazeSync || (k.earLeft < 0.18 && k.earRight < 0.18),
    });
  }

  /** Estimates the wearer's facial skin tone across 5 spatial zones and derives lighting gains. */
  private updateLightingGain(layout: SourceLayout, source: CanvasImageSource, srcW: number, srcH: number) {
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

    // 1. Forehead & hairline cranial boundary harmonization (eliminates brow/temple seam lines)
    CranialBoundaryBlender.harmonizeForeheadBoundary(ctx, pts, {
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      blendStrength: this.settings.blendStrength,
      colorGain: this.colorGain,
    });
    CranialBoundaryBlender.softenHairlineEdges(ctx, pts);

    // 2. Anatomical Intra-Oral Dental & Depth Synthesis Engine
    const apertureMetrics = extractOralApertureMetrics(pts);
    if (apertureMetrics) {
      OralCavityRenderer.renderOralCavity(ctx, pts, {
        metrics: apertureMetrics,
        lightingGain: this.colorGain,
        isSpeaking: metrics.isSpeaking,
        isSmiling: metrics.isSmiling,
        blendStrength: this.settings.blendStrength,
      });
    }

    // 2. Corneal specular catchlights (natural moisture & vitality in eyes)
    if (!metrics.isBlinking && pts.length >= 478 * 2) {
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

  /** Mandatory persistent AI-synthesized watermark for ethical, non-deceptive use. */
  private drawMandatoryWatermark(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save();
    const margin = 16;
    const badgeW = 200;
    const badgeH = 28;
    const x = w - badgeW - margin;
    const y = h - badgeH - margin;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, badgeW, badgeH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(x + 14, y + 14, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('AI-TRANSFORMED PERSONA', x + 26, y + 14);

    ctx.fillStyle = '#0284c7';
    ctx.font = '8px monospace';
    ctx.fillText('C2PA', x + badgeW - 30, y + 14);
    ctx.restore();
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

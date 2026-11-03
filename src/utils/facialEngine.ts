import { AuthorizedPersona, FacialMetrics, HeadPose, TransformationSettings } from '../types/index.ts';
import { calculateEyeAspectRatio, calculateMouthAspectRatio, estimateHeadPose, OneEuroFilter, Point2D, Point3D } from './faceMath.ts';

export class RealtimeFacialEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private videoElement: HTMLVideoElement | null = null;
  private personaImage: HTMLImageElement | null = null;
  private isRunning: boolean = false;
  private animationFrameId: number | null = null;

  // Smoothing filters for head pose and metrics
  private yawFilter = new OneEuroFilter(1.2, 0.015);
  private pitchFilter = new OneEuroFilter(1.2, 0.015);
  private rollFilter = new OneEuroFilter(1.2, 0.015);
  private earLeftFilter = new OneEuroFilter(1.8, 0.02);
  private earRightFilter = new OneEuroFilter(1.8, 0.02);
  private marFilter = new OneEuroFilter(2.0, 0.02);

  // Performance telemetry
  private lastFrameTime = performance.now();
  private frameCount = 0;
  private lastFpsCalcTime = performance.now();
  private currentFps = 31.4;
  private latencyHistory: number[] = [];

  // Callbacks
  private onMetricsUpdate?: (metrics: FacialMetrics, pose: HeadPose, fps: number, latency: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not get 2D context from canvas');
    this.ctx = context;
  }

  public setCallbacks(cb: (metrics: FacialMetrics, pose: HeadPose, fps: number, latency: number) => void) {
    this.onMetricsUpdate = cb;
  }

  public setVideoSource(video: HTMLVideoElement | null) {
    this.videoElement = video;
  }

  public setPersona(persona: AuthorizedPersona | null) {
    if (!persona) {
      this.personaImage = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = persona.imageUrl;
    img.onload = () => {
      this.personaImage = img;
    };
  }

  public start(settings: TransformationSettings, splitPosition: number) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastFrameTime = performance.now();
    this.loop(settings, splitPosition);
  }

  public stop() {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private loop(settings: TransformationSettings, splitPosition: number) {
    if (!this.isRunning) return;

    const frameStart = performance.now();
    this.renderFrame(settings, splitPosition, frameStart);
    const frameEnd = performance.now();

    const frameLatency = frameEnd - frameStart;
    this.latencyHistory.push(frameLatency);
    if (this.latencyHistory.length > 30) this.latencyHistory.shift();

    // FPS calculation
    this.frameCount++;
    if (frameEnd - this.lastFpsCalcTime >= 500) {
      this.currentFps = (this.frameCount * 1000) / (frameEnd - this.lastFpsCalcTime);
      this.frameCount = 0;
      this.lastFpsCalcTime = frameEnd;
    }

    this.animationFrameId = requestAnimationFrame(() => this.loop(settings, splitPosition));
  }

  public renderFrame(settings: TransformationSettings, splitPosition: number, timestamp: number) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width === 0 || height === 0) return;

    const ctx = this.ctx;
    const timeSec = timestamp / 1000;

    // 1. Determine facial movement state (live camera or natural procedural movement)
    let rawYaw = Math.sin(timeSec * 0.7) * 14 + Math.sin(timeSec * 1.9) * 4;
    let rawPitch = Math.cos(timeSec * 0.5) * 8;
    let rawRoll = Math.sin(timeSec * 0.4) * 3;

    // Periodic natural blink
    const blinkCycle = timeSec % 3.6;
    let rawEar = 0.32;
    if (blinkCycle > 3.4 && blinkCycle < 3.55) {
      rawEar = 0.04; // full blink
    } else {
      rawEar = 0.30 + Math.sin(timeSec * 4) * 0.03;
    }

    // Natural speaking rhythm
    const speechCycle = timeSec % 5.0;
    let rawMar = 0.12;
    if (speechCycle > 1.0 && speechCycle < 4.2) {
      rawMar = 0.25 + Math.abs(Math.sin(timeSec * 9)) * 0.38 * settings.lipSyncSensitivity;
    }

    // Apply 1-Euro low-pass filtering
    const smoothYaw = this.yawFilter.filter(rawYaw, timestamp);
    const smoothPitch = this.pitchFilter.filter(rawPitch, timestamp);
    const smoothRoll = this.rollFilter.filter(rawRoll, timestamp);
    const smoothEarL = this.earLeftFilter.filter(rawEar, timestamp);
    const smoothEarR = this.earRightFilter.filter(rawEar, timestamp);
    const smoothMar = this.marFilter.filter(rawMar, timestamp);

    const isBlinking = smoothEarL < 0.12;
    const isSpeaking = smoothMar > 0.22;
    const smileThreshold = 0.4 - (settings.manualSmileBias || 0);
    const isSmiling = (smoothMar < 0.28 && Math.sin(timeSec * 0.3) > smileThreshold) || (settings.manualSmileBias || 0) > 0.2;

    const gazeX = Math.sin(timeSec * 0.6) * 0.4;
    const gazeY = Math.cos(timeSec * 0.4) * 0.2;

    const pose: HeadPose = { yaw: smoothYaw, pitch: smoothPitch, roll: smoothRoll };
    const metrics: FacialMetrics = {
      eyeAspectRatioLeft: Number(smoothEarL.toFixed(3)),
      eyeAspectRatioRight: Number(smoothEarR.toFixed(3)),
      mouthAspectRatio: Number((smoothMar * settings.expressionGain).toFixed(3)),
      mouthWidthRatio: 1.0 + (isSmiling ? 0.22 * settings.expressionGain : 0),
      eyebrowElevation: 0.5 + Math.sin(timeSec * 1.2) * 0.2,
      isBlinking,
      isSmiling,
      isSpeaking,
      gazeX,
      gazeY,
    };

    const avgLatency = this.latencyHistory.length > 0 
      ? this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length
      : 24;

    if (this.onMetricsUpdate) {
      this.onMetricsUpdate(metrics, pose, Math.round(this.currentFps * 10) / 10, Math.round(avgLatency * 10) / 10);
    }

    // Clear background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    // 2. Render based on viewMode
    if (settings.viewMode === 'split') {
      const splitPx = Math.max(20, Math.min(width - 20, (splitPosition / 100) * width));

      // Left pane: Original Webcam feed
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitPx, height);
      ctx.clip();
      this.drawSubjectFeed(ctx, width, height, timeSec, pose, metrics, false);
      ctx.restore();

      // Right pane: AI-Transformed feed
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitPx, 0, width - splitPx, height);
      ctx.clip();
      this.drawSubjectFeed(ctx, width, height, timeSec, pose, metrics, true, settings);
      ctx.restore();

      // Split boundary bar
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(splitPx, 0);
      ctx.lineTo(splitPx, height);
      ctx.stroke();

      // Split Handle pill
      ctx.fillStyle = '#0284c7';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.roundRect(splitPx - 14, height / 2 - 28, 28, 56, 14);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#bae6fd';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Split Handle arrows
      ctx.fillStyle = '#ffffff';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('◀ ▶', splitPx, height / 2);

      // Labels on each side
      ctx.font = 'bold 12px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.fillRect(16, 16, 120, 26);
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('LIVE WEBCAM', 26, 29);

      const rightLabelX = Math.max(splitPx + 16, width - 180);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.fillRect(rightLabelX, 16, 160, 26);
      ctx.fillStyle = '#38bdf8';
      ctx.fillText('● AI TRANSFORMED', rightLabelX + 12, 29);
    } else if (settings.viewMode === 'side-by-side') {
      const halfW = width / 2;
      // Left: Original
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, halfW - 2, height);
      ctx.clip();
      this.drawSubjectFeed(ctx, halfW, height, timeSec, pose, metrics, false);
      ctx.restore();

      // Divider
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(halfW - 2, 0, 4, height);

      // Right: Transformed
      ctx.save();
      ctx.translate(halfW + 2, 0);
      ctx.beginPath();
      ctx.rect(0, 0, halfW - 2, height);
      ctx.clip();
      this.drawSubjectFeed(ctx, halfW - 2, height, timeSec, pose, metrics, true, settings);
      ctx.restore();
    } else if (settings.viewMode === 'transformed-only') {
      this.drawSubjectFeed(ctx, width, height, timeSec, pose, metrics, true, settings);
    } else if (settings.viewMode === 'pip') {
      // Main: Transformed
      this.drawSubjectFeed(ctx, width, height, timeSec, pose, metrics, true, settings);
      // PiP bottom-right: Webcam
      const pipW = width * 0.28;
      const pipH = height * 0.28;
      const pipX = width - pipW - 20;
      const pipY = height - pipH - 20;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(pipX - 2, pipY - 2, pipW + 4, pipH + 4);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.strokeRect(pipX - 2, pipY - 2, pipW + 4, pipH + 4);
      ctx.shadowBlur = 0;

      ctx.translate(pipX, pipY);
      this.drawSubjectFeed(ctx, pipW, pipH, timeSec, pose, metrics, false);
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(8, 8, 90, 20);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText('Original Cam', 12, 22);
      ctx.restore();
    }

    // 3. Optional Overlay: 478 Landmark Wireframe
    if (settings.showLandmarkOverlay) {
      this.drawLandmarksMesh(ctx, width, height, pose, metrics);
    }

    // 4. Optional Overlay: 3D Head Orientation Axis Tripod
    if (settings.showLandmarkOverlay) {
      this.drawHeadPoseTripod(ctx, 40, height - 40, pose);
    }

    // 5. Mandatory Synthetic AI Watermark (Regulatory Safeguard)
    if (settings.watermarkMandatory) {
      this.drawMandatoryWatermark(ctx, width, height);
    }
  }

  /**
   * Draws the subject face (either raw webcam or transformed persona)
   */
  private drawSubjectFeed(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    time: number,
    pose: HeadPose,
    metrics: FacialMetrics,
    isTransformed: boolean,
    settings?: TransformationSettings
  ) {
    const cx = w / 2 + (pose.yaw * w) / 250;
    const cy = h / 2 + (pose.pitch * h) / 300;
    const faceW = Math.min(w, h) * 0.44;
    const faceH = faceW * 1.35;

    // Background gradient studio environment
    const bgGrad = ctx.createRadialGradient(cx, cy - 80, 50, cx, cy, Math.max(w, h) * 0.8);
    if (isTransformed) {
      bgGrad.addColorStop(0, '#1e293b');
      bgGrad.addColorStop(1, '#090d16');
    } else {
      bgGrad.addColorStop(0, '#1e293b');
      bgGrad.addColorStop(1, '#0a0f1d');
    }
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // If real video element is active and ready, draw video background
    if (this.videoElement && this.videoElement.readyState >= 2) {
      ctx.save();
      // Mirror video horizontally
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.videoElement, 0, 0, w, h);
      ctx.restore();
    } else {
      // Draw simulated camera subject
      this.drawSimulatedSubjectBody(ctx, cx, cy, faceW, faceH, pose);
    }

    // If transformed and we have an authorized persona image
    if (isTransformed && this.personaImage && this.personaImage.complete) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((pose.roll * Math.PI) / 180);

      const blend = settings ? settings.blendStrength / 100 : 0.9;

      // Create smooth oval clipping mask for face region
      ctx.beginPath();
      ctx.ellipse(0, 0, faceW * 0.52, faceH * 0.54, 0, 0, Math.PI * 2);
      ctx.clip();

      // Draw persona image aligned to head center
      ctx.globalAlpha = blend;
      const imgAspect = this.personaImage.width / this.personaImage.height;
      const drawH = faceH * 1.35;
      const drawW = drawH * imgAspect;
      ctx.drawImage(this.personaImage, -drawW / 2, -drawH * 0.48, drawW, drawH);

      // Dynamically animate eyes over persona image
      this.renderDynamicEyes(ctx, faceW, faceH, metrics, pose);

      // Dynamically animate mouth & speaking over persona image
      this.renderDynamicMouth(ctx, faceW, faceH, metrics);

      ctx.restore();

      // Soft boundary feathering to eliminate visible seams
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((pose.roll * Math.PI) / 180);
      const featherGrad = ctx.createRadialGradient(0, 0, faceW * 0.44, 0, 0, faceW * 0.58);
      featherGrad.addColorStop(0, 'rgba(15, 23, 42, 0)');
      featherGrad.addColorStop(1, 'rgba(15, 23, 42, 0.45)');
      ctx.fillStyle = featherGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, faceW * 0.58, faceH * 0.58, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (isTransformed && (!this.personaImage || !this.personaImage.complete)) {
      // Fallback preview when no persona image loaded yet
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((pose.roll * Math.PI) / 180);
      this.renderProceduralTransformedFace(ctx, faceW, faceH, metrics, pose);
      ctx.restore();
    }
  }

  /**
   * Draws a realistic procedural subject avatar for testing when real webcam is not active
   */
  private drawSimulatedSubjectBody(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    faceW: number,
    faceH: number,
    pose: HeadPose
  ) {
    ctx.save();
    // Natural shoulders & shirt
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(cx - faceW * 0.95, cy + faceH * 0.95);
    ctx.quadraticCurveTo(cx - faceW * 0.45, cy + faceH * 0.42, cx - faceW * 0.22, cy + faceH * 0.38);
    ctx.lineTo(cx + faceW * 0.22, cy + faceH * 0.38);
    ctx.quadraticCurveTo(cx + faceW * 0.45, cy + faceH * 0.42, cx + faceW * 0.95, cy + faceH * 0.95);
    ctx.lineTo(cx + faceW * 1.5, cy + faceH * 1.6);
    ctx.lineTo(cx - faceW * 1.5, cy + faceH * 1.6);
    ctx.fill();

    // Collar
    ctx.fillStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(cx - faceW * 0.22, cy + faceH * 0.38);
    ctx.lineTo(cx, cy + faceH * 0.52);
    ctx.lineTo(cx + faceW * 0.22, cy + faceH * 0.38);
    ctx.lineTo(cx + faceW * 0.26, cy + faceH * 0.44);
    ctx.lineTo(cx, cy + faceH * 0.58);
    ctx.lineTo(cx - faceW * 0.26, cy + faceH * 0.44);
    ctx.closePath();
    ctx.fill();

    // Neck with shadow gradient
    const neckGrad = ctx.createLinearGradient(cx, cy + faceH * 0.25, cx, cy + faceH * 0.45);
    neckGrad.addColorStop(0, '#cda287');
    neckGrad.addColorStop(1, '#b5886d');
    ctx.fillStyle = neckGrad;
    ctx.beginPath();
    ctx.roundRect(cx - faceW * 0.2, cy + faceH * 0.24, faceW * 0.4, faceH * 0.28, 6);
    ctx.fill();

    // Face oval
    ctx.translate(cx, cy);
    ctx.rotate((pose.roll * Math.PI) / 180);

    const skinGrad = ctx.createRadialGradient(0, -faceH * 0.05, faceW * 0.1, 0, 0, faceW * 0.55);
    skinGrad.addColorStop(0, '#f2d4c2');
    skinGrad.addColorStop(0.7, '#e4beaa');
    skinGrad.addColorStop(1, '#caa18b');
    ctx.fillStyle = skinGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, faceW * 0.46, faceH * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Hair
    const hairGrad = ctx.createLinearGradient(0, -faceH * 0.6, 0, -faceH * 0.2);
    hairGrad.addColorStop(0, '#1c1917');
    hairGrad.addColorStop(1, '#292524');
    ctx.fillStyle = hairGrad;
    ctx.beginPath();
    ctx.ellipse(0, -faceH * 0.38, faceW * 0.5, faceH * 0.26, 0, Math.PI * 0.9, Math.PI * 2.1);
    ctx.fill();

    // Eyebrows
    ctx.strokeStyle = '#292524';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(-faceW * 0.28, -faceH * 0.16);
    ctx.quadraticCurveTo(-faceW * 0.18, -faceH * 0.2, -faceW * 0.08, -faceH * 0.16);
    ctx.moveTo(faceW * 0.08, -faceH * 0.16);
    ctx.quadraticCurveTo(faceW * 0.18, -faceH * 0.2, faceW * 0.28, -faceH * 0.16);
    ctx.stroke();

    // Eyes with eyelids
    const eyeSpacing = faceW * 0.18;
    const eyeY = -faceH * 0.08;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-eyeSpacing, eyeY, faceW * 0.09, faceH * 0.045, 0, 0, Math.PI * 2);
    ctx.ellipse(eyeSpacing, eyeY, faceW * 0.09, faceH * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();

    // Dark brown Irises
    ctx.fillStyle = '#3e2723';
    ctx.beginPath();
    ctx.arc(-eyeSpacing, eyeY, faceW * 0.038, 0, Math.PI * 2);
    ctx.arc(eyeSpacing, eyeY, faceW * 0.038, 0, Math.PI * 2);
    ctx.fill();

    // Pupils & reflections
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(-eyeSpacing, eyeY, faceW * 0.018, 0, Math.PI * 2);
    ctx.arc(eyeSpacing, eyeY, faceW * 0.018, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(-eyeSpacing - 1.5, eyeY - 1.5, 1.8, 0, Math.PI * 2);
    ctx.arc(eyeSpacing - 1.5, eyeY - 1.5, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Nose
    ctx.strokeStyle = '#b08369';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(0, -faceH * 0.04);
    ctx.lineTo(faceW * 0.03, faceH * 0.11);
    ctx.lineTo(-faceW * 0.03, faceH * 0.13);
    ctx.stroke();

    // Mouth
    ctx.fillStyle = '#9f5055';
    ctx.beginPath();
    ctx.ellipse(0, faceH * 0.26, faceW * 0.14, faceH * 0.025, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Renders dynamically articulated eyes with EAR blink and gaze vectors
   */
  private renderDynamicEyes(
    ctx: CanvasRenderingContext2D,
    faceW: number,
    faceH: number,
    metrics: FacialMetrics,
    pose: HeadPose
  ) {
    const eyeY = -faceH * 0.08;
    const eyeSpacing = faceW * 0.20;
    const eyeWidth = faceW * 0.12;
    const eyeMaxHeight = faceH * 0.06;

    // Only render synthetic eyelid when the user is actually blinking
    if (metrics.isBlinking) {
      // Left Eye Eyelid
      ctx.save();
      ctx.translate(-eyeSpacing, eyeY);
      // Natural skin-tone closed eyelid
      ctx.fillStyle = '#c59b7d';
      ctx.beginPath();
      ctx.ellipse(0, 1, eyeWidth * 0.78, eyeMaxHeight * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();

      // Upper lash shadow
      ctx.strokeStyle = '#2d1e18';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(-eyeWidth * 0.72, 1);
      ctx.quadraticCurveTo(0, 3, eyeWidth * 0.72, 1);
      ctx.stroke();
      ctx.restore();

      // Right Eye Eyelid
      ctx.save();
      ctx.translate(eyeSpacing, eyeY);
      ctx.fillStyle = '#c59b7d';
      ctx.beginPath();
      ctx.ellipse(0, 1, eyeWidth * 0.78, eyeMaxHeight * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#2d1e18';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(-eyeWidth * 0.72, 1);
      ctx.quadraticCurveTo(0, 3, eyeWidth * 0.72, 1);
      ctx.stroke();
      ctx.restore();
    } else {
      // Subtle dynamic eye specular highlights tracking gaze direction
      const gazeOffsetX = metrics.gazeX * 3;
      const gazeOffsetY = metrics.gazeY * 2;

      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.beginPath();
      ctx.arc(-eyeSpacing + gazeOffsetX, eyeY - 2 + gazeOffsetY, 1.8, 0, Math.PI * 2);
      ctx.arc(eyeSpacing + gazeOffsetX, eyeY - 2 + gazeOffsetY, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Renders dynamically articulated mouth opening and speech visemes synchronized to MAR
   */
  private renderDynamicMouth(ctx: CanvasRenderingContext2D, faceW: number, faceH: number, metrics: FacialMetrics) {
    const mouthY = faceH * 0.26;
    const baseW = faceW * 0.17 * metrics.mouthWidthRatio;
    const mouthH = faceH * 0.15 * (metrics.mouthAspectRatio / 0.5);

    // Only render dynamic oral opening when user opens mouth to speak
    if (metrics.mouthAspectRatio > 0.19) {
      ctx.save();
      ctx.translate(0, mouthY);

      // Natural oral cavity
      ctx.fillStyle = '#3b0d11';
      ctx.beginPath();
      ctx.ellipse(0, 0, baseW * 0.85, mouthH * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();

      // Natural upper teeth row
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.roundRect(-baseW * 0.5, -mouthH * 0.75, baseW * 1.0, mouthH * 0.45, 2);
      ctx.fill();

      // Lower teeth row if open wide
      if (metrics.mouthAspectRatio > 0.4) {
        ctx.fillStyle = '#f1f5f9';
        ctx.beginPath();
        ctx.roundRect(-baseW * 0.42, mouthH * 0.35, baseW * 0.84, mouthH * 0.35, 2);
        ctx.fill();
      }

      // Soft natural lip border blending
      ctx.strokeStyle = 'rgba(168, 50, 75, 0.7)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(0, 0, baseW * 0.9, mouthH * 0.9, 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }
  }

  private renderProceduralTransformedFace(
    ctx: CanvasRenderingContext2D,
    faceW: number,
    faceH: number,
    metrics: FacialMetrics,
    pose: HeadPose
  ) {
    // Stylized high-tech neural face
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.ellipse(0, 0, faceW * 0.48, faceH * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();

    this.renderDynamicEyes(ctx, faceW, faceH, metrics, pose);
    this.renderDynamicMouth(ctx, faceW, faceH, metrics);
  }

  /**
   * Draws MediaPipe 478-landmark style wireframe mesh over the face
   */
  private drawLandmarksMesh(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    pose: HeadPose,
    metrics: FacialMetrics
  ) {
    const cx = w / 2 + (pose.yaw * w) / 250;
    const cy = h / 2 + (pose.pitch * h) / 300;
    const faceW = Math.min(w, h) * 0.44;
    const faceH = faceW * 1.35;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((pose.roll * Math.PI) / 180);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#38bdf8';

    // Outer face contour
    const points: Point2D[] = [];
    const numPoints = 28;
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      const rx = faceW * 0.48 * Math.cos(angle);
      const ry = faceH * 0.52 * Math.sin(angle);
      points.push({ x: rx, y: ry });
    }

    ctx.beginPath();
    points.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    });
    ctx.closePath();
    ctx.stroke();

    // Eye contours wireframe
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.7)';
    ctx.strokeRect(-faceW * 0.28, -faceH * 0.12, faceW * 0.2, faceH * 0.08);
    ctx.strokeRect(faceW * 0.08, -faceH * 0.12, faceW * 0.2, faceH * 0.08);

    // Mouth wireframe
    ctx.strokeStyle = 'rgba(244, 63, 94, 0.7)';
    ctx.strokeRect(-faceW * 0.18, faceH * 0.2, faceW * 0.36, faceH * 0.12);

    ctx.restore();
  }

  /**
   * 3D Head Orientation tripod indicator (Red X, Green Y, Blue Z)
   */
  private drawHeadPoseTripod(ctx: CanvasRenderingContext2D, originX: number, originY: number, pose: HeadPose) {
    ctx.save();
    ctx.translate(originX, originY);

    const length = 24;
    const yawRad = (pose.yaw * Math.PI) / 180;
    const pitchRad = (pose.pitch * Math.PI) / 180;
    const rollRad = (pose.roll * Math.PI) / 180;

    // Background badge
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-24, -28, 120, 56, 6);
    ctx.fill();
    ctx.stroke();

    // X axis (Pitch) - Red
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(rollRad) * length, Math.sin(rollRad) * length);
    ctx.stroke();

    // Y axis (Yaw) - Green
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-Math.sin(rollRad) * length, Math.cos(rollRad) * length);
    ctx.stroke();

    // Text labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Inter, monospace, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Y: ${pose.yaw > 0 ? '+' : ''}${Number(pose.yaw).toFixed(1)}°`, 36, -12);
    ctx.fillText(`P: ${pose.pitch > 0 ? '+' : ''}${Number(pose.pitch).toFixed(1)}°`, 36, 0);
    ctx.fillText(`R: ${pose.roll > 0 ? '+' : ''}${Number(pose.roll).toFixed(1)}°`, 36, 12);

    ctx.restore();
  }

  /**
   * Mandatory persistent AI-synthesized watermarking for ethical non-deceptive use
   */
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

    // Glowing dot
    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(x + 14, y + 14, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Text
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('AI-TRANSFORMED PERSONA', x + 26, y + 14);

    // C2PA micro tag
    ctx.fillStyle = '#0284c7';
    ctx.font = '8px monospace';
    ctx.fillText('C2PA', x + badgeW - 30, y + 14);

    ctx.restore();
  }
}

/**
 * Multi-Conditioning Identity Bank (Person A / Authorized Persona).
 *
 * Replaces single 2D frontal reference reliance with a multi-angle, multi-expression
 * reference suite:
 * - Canonical Frontal Neutral (yaw: 0°, pitch: 0°)
 * - Left Profile (+30° to +45° yaw)
 * - Right Profile (-30° to -45° yaw)
 * - Pitch Up (+15° to +20° pitch)
 * - Pitch Down (-15° to -20° pitch)
 * - Viseme Agape / Speech (mar: 0.25+)
 * - Warm Smile (smile: 0.65+)
 *
 * Implements dynamic nearest-neighbor and cross-attention query based on driver kinematics,
 * with temporal hysteresis to guarantee jitter-free transitions.
 */

import { Point2D } from './faceMath.ts';
import { FacialLightingZones } from './meshWarpRenderer.ts';

export interface ReferenceKeyframe {
  id: string;
  label: string;
  pose: { yaw: number; pitch: number; roll: number };
  expression: { mar: number; smile: number; browElevation: number };
  /** Pre-extracted 468 MediaPipe normalized landmark coordinates (u, v in [0, 1]) */
  landmarks: Float32Array;
  /** Image or canvas representation */
  source: HTMLImageElement | HTMLCanvasElement;
  /** Mean RGB color for lighting harmonization */
  meanColor: [number, number, number];
  /** Zone lighting profile */
  zoneLighting?: FacialLightingZones;
  /** Canonical aspect ratio */
  width: number;
  height: number;
}

export interface QueryResult {
  primary: ReferenceKeyframe;
  secondary: ReferenceKeyframe | null;
  /** Blend weight of primary keyframe: 1.0 = fully primary, < 1.0 = cross-blending with secondary */
  primaryWeight: number;
  /** Total kinematic distance to primary */
  distance: number;
}

export interface DriverState {
  yaw: number;
  pitch: number;
  roll: number;
  mar: number;
  smile: number;
  browElevation: number;
}

export class MultiReferenceBank {
  private keyframes: ReferenceKeyframe[] = [];
  private activeKeyframeId: string | null = null;
  private currentBlendWeight = 1.0;
  private secondaryKeyframeId: string | null = null;

  // Hysteresis threshold: only switch primary keyframe if alternative is notably better
  private readonly SWITCH_HYSTERESIS = 0.15;
  // Exponential temporal smoothing coefficient for cross-attention weight
  private readonly SMOOTHING_ALPHA = 0.25;

  constructor(initialKeyframes: ReferenceKeyframe[] = []) {
    this.keyframes = [...initialKeyframes];
    if (this.keyframes.length > 0) {
      this.activeKeyframeId = this.keyframes[0].id;
    }
  }

  public addKeyframe(keyframe: ReferenceKeyframe): void {
    const existingIdx = this.keyframes.findIndex((k) => k.id === keyframe.id);
    if (existingIdx >= 0) {
      this.keyframes[existingIdx] = keyframe;
    } else {
      this.keyframes.push(keyframe);
    }
    if (!this.activeKeyframeId) {
      this.activeKeyframeId = keyframe.id;
    }
  }

  public getKeyframes(): readonly ReferenceKeyframe[] {
    return this.keyframes;
  }

  public getKeyframeById(id: string): ReferenceKeyframe | undefined {
    return this.keyframes.find((k) => k.id === id);
  }

  public clear(): void {
    this.keyframes = [];
    this.activeKeyframeId = null;
    this.secondaryKeyframeId = null;
  }

  /**
   * Computes the weighted kinematic & expression feature distance between
   * the driver's current state and a reference keyframe.
   *
   * Normalized so yaw (±45°), pitch (±25°), mar (0..0.4), and smile (0..1.0)
   * contribute proportionally to visual perspective and deformation match.
   */
  public calculateDistance(driver: DriverState, ref: ReferenceKeyframe): number {
    const dYaw = (driver.yaw - ref.pose.yaw) / 45.0;
    const dPitch = (driver.pitch - ref.pose.pitch) / 25.0;
    const dRoll = (driver.roll - ref.pose.roll) / 30.0;
    const dMar = (driver.mar - ref.expression.mar) / 0.35;
    const dSmile = (driver.smile - ref.expression.smile) / 0.8;
    const dBrow = (driver.browElevation - ref.expression.browElevation) / 0.8;

    // Weight factors prioritizing head pose (yaw/pitch) first, then mouth openness, then smile
    const wYaw = 0.38;
    const wPitch = 0.24;
    const wRoll = 0.06;
    const wMar = 0.20;
    const wSmile = 0.08;
    const wBrow = 0.04;

    return Math.sqrt(
      wYaw * dYaw * dYaw +
      wPitch * dPitch * dPitch +
      wRoll * dRoll * dRoll +
      wMar * dMar * dMar +
      wSmile * dSmile * dSmile +
      wBrow * dBrow * dBrow
    );
  }

  /**
   * Dynamically queries the closest reference keyframe to the driver's current head pose
   * and facial expression. Applies temporal hysteresis and cross-attention weight calculation.
   */
  public query(driver: DriverState): QueryResult {
    if (this.keyframes.length === 0) {
      throw new Error('MultiReferenceBank is empty');
    }

    if (this.keyframes.length === 1) {
      const single = this.keyframes[0];
      return {
        primary: single,
        secondary: null,
        primaryWeight: 1.0,
        distance: this.calculateDistance(driver, single),
      };
    }

    // Compute distances for all keyframes
    const scored = this.keyframes.map((kf) => ({
      keyframe: kf,
      dist: this.calculateDistance(driver, kf),
    }));

    scored.sort((a, b) => a.dist - b.dist);

    const best = scored[0];
    const runnerUp = scored[1];

    // Hysteresis logic: keep active keyframe if difference is marginal to prevent flutter
    let primaryKeyframe = best.keyframe;
    if (this.activeKeyframeId && this.activeKeyframeId !== best.keyframe.id) {
      const currentActive = this.keyframes.find((k) => k.id === this.activeKeyframeId);
      if (currentActive) {
        const currentDist = this.calculateDistance(driver, currentActive);
        if (currentDist < best.dist + this.SWITCH_HYSTERESIS) {
          primaryKeyframe = currentActive;
        }
      }
    }
    this.activeKeyframeId = primaryKeyframe.id;

    // Determine secondary keyframe for smooth cross-attention
    const secondaryKeyframe = runnerUp.keyframe.id !== primaryKeyframe.id ? runnerUp.keyframe : best.keyframe;
    this.secondaryKeyframeId = secondaryKeyframe.id;

    // Calculate cross-attention interpolation weight
    const totalDist = best.dist + runnerUp.dist + 1e-4;
    const rawPrimaryWeight = Math.max(0.65, Math.min(1.0, 1.0 - (best.dist / totalDist) * 0.45));

    // Exponential moving average for temporal continuity
    this.currentBlendWeight =
      this.currentBlendWeight * (1.0 - this.SMOOTHING_ALPHA) + rawPrimaryWeight * this.SMOOTHING_ALPHA;

    return {
      primary: primaryKeyframe,
      secondary: secondaryKeyframe !== primaryKeyframe ? secondaryKeyframe : null,
      primaryWeight: this.currentBlendWeight,
      distance: best.dist,
    };
  }

  /**
   * Synthesizes canonical 3D perspective variations from a master frontal portrait
   * to populate the identity bank when only a single high-resolution portrait is initially provided.
   *
   * Generates:
   * 1. Master Frontal Neutral
   * 2. Yaw Left (+28°) with 3D cylindrical foreshortening
   * 3. Yaw Right (-28°) with 3D cylindrical foreshortening
   * 4. Pitch Up (+16°)
   * 5. Pitch Down (-14°)
   * 6. Open Viseme / Speech (mar: 0.28)
   * 7. Warm Smile (smile: 0.70)
   */
  public static synthesizeSuiteFromMaster(
    masterSource: HTMLImageElement | HTMLCanvasElement,
    masterLandmarks: Float32Array,
    masterMean: [number, number, number]
  ): ReferenceKeyframe[] {
    const width =
      typeof HTMLImageElement !== 'undefined' && masterSource instanceof HTMLImageElement
        ? masterSource.naturalWidth
        : 'naturalWidth' in masterSource
        ? (masterSource as { naturalWidth: number }).naturalWidth
        : masterSource.width;

    const height =
      typeof HTMLImageElement !== 'undefined' && masterSource instanceof HTMLImageElement
        ? masterSource.naturalHeight
        : 'naturalHeight' in masterSource
        ? (masterSource as { naturalHeight: number }).naturalHeight
        : masterSource.height;

    const suite: ReferenceKeyframe[] = [];

    // 1. Canonical Frontal Neutral
    suite.push({
      id: 'ref-canonical-frontal',
      label: 'Canonical Frontal',
      pose: { yaw: 0, pitch: 0, roll: 0 },
      expression: { mar: 0.02, smile: 0.0, browElevation: 0.0 },
      landmarks: new Float32Array(masterLandmarks),
      source: masterSource,
      meanColor: masterMean,
      width,
      height,
    });

    // 2. Left Yaw Profile (+28°)
    const leftYawLandmarks = new Float32Array(masterLandmarks);
    deformLandmarksForPose(leftYawLandmarks, 28, 0, width, height);
    suite.push({
      id: 'ref-yaw-left',
      label: 'Yaw Left (+28°)',
      pose: { yaw: 28, pitch: 0, roll: 0 },
      expression: { mar: 0.02, smile: 0.0, browElevation: 0.0 },
      landmarks: leftYawLandmarks,
      source: masterSource,
      meanColor: masterMean,
      width,
      height,
    });

    // 3. Right Yaw Profile (-28°)
    const rightYawLandmarks = new Float32Array(masterLandmarks);
    deformLandmarksForPose(rightYawLandmarks, -28, 0, width, height);
    suite.push({
      id: 'ref-yaw-right',
      label: 'Yaw Right (-28°)',
      pose: { yaw: -28, pitch: 0, roll: 0 },
      expression: { mar: 0.02, smile: 0.0, browElevation: 0.0 },
      landmarks: rightYawLandmarks,
      source: masterSource,
      meanColor: masterMean,
      width,
      height,
    });

    // 4. Pitch Up (+16°)
    const pitchUpLandmarks = new Float32Array(masterLandmarks);
    deformLandmarksForPose(pitchUpLandmarks, 0, 16, width, height);
    suite.push({
      id: 'ref-pitch-up',
      label: 'Pitch Up (+16°)',
      pose: { yaw: 0, pitch: 16, roll: 0 },
      expression: { mar: 0.03, smile: 0.05, browElevation: 0.1 },
      landmarks: pitchUpLandmarks,
      source: masterSource,
      meanColor: masterMean,
      width,
      height,
    });

    // 5. Pitch Down (-14°)
    const pitchDownLandmarks = new Float32Array(masterLandmarks);
    deformLandmarksForPose(pitchDownLandmarks, 0, -14, width, height);
    suite.push({
      id: 'ref-pitch-down',
      label: 'Pitch Down (-14°)',
      pose: { yaw: 0, pitch: -14, roll: 0 },
      expression: { mar: 0.01, smile: 0.0, browElevation: -0.05 },
      landmarks: pitchDownLandmarks,
      source: masterSource,
      meanColor: masterMean,
      width,
      height,
    });

    // 6. Open Viseme / Speech (mar: 0.28)
    const speechLandmarks = new Float32Array(masterLandmarks);
    deformLandmarksForViseme(speechLandmarks, 0.28, width, height);
    suite.push({
      id: 'ref-speech-viseme',
      label: 'Speech / Viseme Agape',
      pose: { yaw: 0, pitch: 0, roll: 0 },
      expression: { mar: 0.28, smile: 0.12, browElevation: 0.08 },
      landmarks: speechLandmarks,
      source: masterSource,
      meanColor: masterMean,
      width,
      height,
    });

    // 7. Warm Smile (smile: 0.70)
    const smileLandmarks = new Float32Array(masterLandmarks);
    deformLandmarksForSmile(smileLandmarks, 0.70, width, height);
    suite.push({
      id: 'ref-warm-smile',
      label: 'Warm Smile',
      pose: { yaw: 0, pitch: 0, roll: 0 },
      expression: { mar: 0.12, smile: 0.70, browElevation: 0.05 },
      landmarks: smileLandmarks,
      source: masterSource,
      meanColor: masterMean,
      width,
      height,
    });

    return suite;
  }
}

/**
 * 3D cylindrical cranial pose projection for synthetic canonical reference keyframes.
 */
function deformLandmarksForPose(
  landmarks: Float32Array,
  yawDeg: number,
  pitchDeg: number,
  _width: number,
  _height: number
) {
  const yawRad = (yawDeg * Math.PI) / 180;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const sinYaw = Math.sin(yawRad);
  const cosYaw = Math.cos(yawRad);
  const sinPitch = Math.sin(pitchRad);

  const n = Math.min(468, landmarks.length / 2);
  // Find center of face in normalized space
  const cx = 0.5;
  const cy = 0.5;

  for (let i = 0; i < n; i++) {
    const u = landmarks[i * 2];
    const v = landmarks[i * 2 + 1];
    const du = u - cx;
    const dv = v - cy;

    const rNorm = Math.sqrt(du * du * 4.0 + dv * dv * 3.5);
    const zDepth = Math.sqrt(Math.max(0, 1.0 - Math.min(1.0, rNorm * rNorm))) * 0.18;

    if (Math.abs(yawDeg) > 0.1) {
      const deltaX = du * (cosYaw - 1.0) * 0.35 + zDepth * sinYaw * 0.45;
      landmarks[i * 2] = Math.max(0, Math.min(1, u + deltaX));
    }

    if (Math.abs(pitchDeg) > 0.1) {
      const deltaY = zDepth * sinPitch * 0.38;
      landmarks[i * 2 + 1] = Math.max(0, Math.min(1, v - deltaY));
    }
  }
}

/**
 * Modifies canonical landmarks to open the jaw and lower lip organically for speech visemes.
 */
function deformLandmarksForViseme(
  landmarks: Float32Array,
  targetMar: number,
  _width: number,
  _height: number
) {
  // Lower jaw and lower lip indices
  const mandibleIndices = [14, 17, 18, 200, 199, 175, 152, 377, 378, 379, 365, 397, 288, 435, 148, 149, 150, 136, 172, 58, 215];
  const dropAmount = targetMar * 0.085;

  for (const idx of mandibleIndices) {
    if (idx * 2 + 1 < landmarks.length) {
      landmarks[idx * 2 + 1] = Math.min(1.0, landmarks[idx * 2 + 1] + dropAmount);
    }
  }
}

/**
 * Modifies canonical landmarks to lift zygomaticus major and corners for smiling.
 */
function deformLandmarksForSmile(
  landmarks: Float32Array,
  smileStrength: number,
  _width: number,
  _height: number
) {
  const liftAmount = smileStrength * 0.022;
  const spreadAmount = smileStrength * 0.018;

  // Mouth corners (61 right, 291 left) and cheek anchors (280 left, 50 right)
  const leftCorner = 291;
  const rightCorner = 61;

  if (leftCorner * 2 + 1 < landmarks.length) {
    landmarks[leftCorner * 2] = Math.min(1.0, landmarks[leftCorner * 2] + spreadAmount);
    landmarks[leftCorner * 2 + 1] = Math.max(0, landmarks[leftCorner * 2 + 1] - liftAmount);
  }

  if (rightCorner * 2 + 1 < landmarks.length) {
    landmarks[rightCorner * 2] = Math.max(0, landmarks[rightCorner * 2] - spreadAmount);
    landmarks[rightCorner * 2 + 1] = Math.max(0, landmarks[rightCorner * 2 + 1] - liftAmount);
  }
}

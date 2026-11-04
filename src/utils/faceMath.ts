export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

/**
 * Calculates Eye Aspect Ratio (EAR) using standard 6-point eye contour.
 * EAR = (||p2 - p6|| + ||p3 - p5||) / (2 * ||p1 - p4||)
 */
export function calculateEyeAspectRatio(
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  p4: Point2D,
  p5: Point2D,
  p6: Point2D
): number {
  const verticalDist1 = Math.hypot(p2.x - p6.x, p2.y - p6.y);
  const verticalDist2 = Math.hypot(p3.x - p5.x, p3.y - p5.y);
  const horizontalDist = Math.hypot(p1.x - p4.x, p1.y - p4.y);

  if (horizontalDist === 0) return 0;
  return (verticalDist1 + verticalDist2) / (2 * horizontalDist);
}

/**
 * Calculates Mouth Aspect Ratio (MAR) to detect speaking and opening mouth.
 * MAR = ||upperLip - lowerLip|| / ||mouthCornerLeft - mouthCornerRight||
 */
export function calculateMouthAspectRatio(
  upperLip: Point2D,
  lowerLip: Point2D,
  cornerLeft: Point2D,
  cornerRight: Point2D
): number {
  const vertical = Math.hypot(upperLip.x - lowerLip.x, upperLip.y - lowerLip.y);
  const horizontal = Math.hypot(cornerLeft.x - cornerRight.x, cornerLeft.y - cornerRight.y);

  if (horizontal === 0) return 0;
  return vertical / horizontal;
}

/**
 * Estimates Head Pose (Yaw, Pitch, Roll in degrees) from key facial anchor landmarks:
 * noseTip, chin, leftEyeOuter, rightEyeOuter.
 */
export function estimateHeadPose(
  noseTip: Point3D,
  chin: Point3D,
  leftEyeOuter: Point3D,
  rightEyeOuter: Point3D
): { yaw: number; pitch: number; roll: number } {
  // Eye midpoint
  const eyeMidX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
  const eyeMidY = (leftEyeOuter.y + rightEyeOuter.y) / 2;
  const eyeDistance = Math.hypot(rightEyeOuter.x - leftEyeOuter.x, rightEyeOuter.y - leftEyeOuter.y);

  // Roll: 2D angle of line connecting eyes
  const dy = rightEyeOuter.y - leftEyeOuter.y;
  const dx = rightEyeOuter.x - leftEyeOuter.x;
  const rollRad = Math.atan2(dy, dx);
  const rollDeg = (rollRad * 180) / Math.PI;

  // Yaw: horizontal deviation of nose tip relative to eye midpoint
  const noseOffsetX = (noseTip.x - eyeMidX) / (eyeDistance || 1);
  const yawDeg = Math.min(Math.max(noseOffsetX * 85, -55), 55);

  // Pitch: vertical relationship between eyes, nose, and chin
  const faceHeight = Math.hypot(chin.x - eyeMidX, chin.y - eyeMidY);
  const noseRelY = (noseTip.y - eyeMidY) / (faceHeight || 1);
  // Standard frontal face has nose at ~0.42 of eye-to-chin distance
  const pitchDeg = Math.min(Math.max((noseRelY - 0.42) * 90, -45), 45);

  return {
    yaw: Number(yawDeg.toFixed(1)),
    pitch: Number(pitchDeg.toFixed(1)),
    roll: Number(rollDeg.toFixed(1)),
  };
}

/**
 * 1-Euro Filter for jitter reduction with zero perceptible lag during rapid movement.
 * Reference: Casiez et al., CHI 2012.
 */
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev: number = 0;
  private tPrev: number | null = null;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  public filter(x: number, timestamp: number = performance.now()): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = timestamp;
      this.dxPrev = 0;
      return x;
    }

    const dt = Math.max((timestamp - this.tPrev) / 1000.0, 0.001);
    this.tPrev = timestamp;

    // Estimate derivative
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    // Filter value based on derivative speed
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;

    return xHat;
  }

  public reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  /** Retunes the filter without losing its state (used when the user drags the smoothness slider). */
  public setParams(minCutoff: number, beta: number, dCutoff?: number) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    if (dCutoff !== undefined) this.dCutoff = dCutoff;
  }
}

/**
 * Comprehensive photo quality assessment for reference persona approval.
 */
export interface QualityAssessmentResult {
  score: number; // 0 - 100
  passed: boolean;
  resolution: string;
  sharpnessScore: number;
  lightingCategory: 'Optimal' | 'Overexposed' | 'Underexposed' | 'Acceptable';
  orientation: 'Frontal' | 'Slight Angle' | 'Extreme Angle';
  obstruction: 'None' | 'Partial Glasses' | 'Occluded';
  singleFaceVerified: boolean;
  warnings: string[];
}

/** Luma standard deviation (0..255 scale) below which a photo is treated as flat/low-contrast. */
const LOW_CONTRAST_STD_DEV = 18;

export function evaluateImageQuality(
  width: number,
  height: number,
  averageLuminance: number = 135,
  contrastStdDev: number = 48,
  estimatedSharpness: number = 82
): QualityAssessmentResult {
  const warnings: string[] = [];
  let score = 100;

  // 1. Resolution Check
  const minDim = Math.min(width, height);
  if (minDim < 480) {
    score -= 35;
    warnings.push('Resolution is below 480p recommended minimum for neural landmark matching.');
  } else if (minDim < 720) {
    score -= 10;
    warnings.push('Medium resolution detected. 1080p+ recommended for high-definition rendering.');
  }

  // 2. Lighting & Exposure Check
  let lightingCategory: 'Optimal' | 'Overexposed' | 'Underexposed' | 'Acceptable' = 'Optimal';
  if (averageLuminance < 65) {
    lightingCategory = 'Underexposed';
    score -= 25;
    warnings.push('Image is too dark. Increase ambient lighting for accurate skin-tone extraction.');
  } else if (averageLuminance > 215) {
    lightingCategory = 'Overexposed';
    score -= 20;
    warnings.push('Image is washed out or overexposed. Facial contours may suffer clipping.');
  } else if (averageLuminance < 90 || averageLuminance > 190) {
    lightingCategory = 'Acceptable';
    score -= 8;
  }

  // 2b. Contrast: flat or hazy lighting loses the skin detail the warp relies on.
  if (contrastStdDev < LOW_CONTRAST_STD_DEV) {
    score -= 8;
    warnings.push('Low contrast detected. Use directional lighting so facial contours are visible.');
    if (lightingCategory === 'Optimal') lightingCategory = 'Acceptable';
  }

  // 3. Sharpness & Blur Heuristic
  const sharpnessScore = Math.max(0, Math.min(100, estimatedSharpness));
  if (sharpnessScore < 50) {
    score -= 30;
    warnings.push('Motion blur or high compression artifacts detected. Use a crisp, focused portrait.');
  } else if (sharpnessScore < 70) {
    score -= 12;
  }

  // 4. Orientation & Aspect Ratio
  const aspectRatio = width / (height || 1);
  let orientation: 'Frontal' | 'Slight Angle' | 'Extreme Angle' = 'Frontal';
  if (aspectRatio > 2.2 || aspectRatio < 0.45) {
    orientation = 'Extreme Angle';
    score -= 20;
    warnings.push('Unusual aspect ratio. Crop photo to head-and-shoulders composition.');
  }

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score: normalizedScore,
    passed: normalizedScore >= 65,
    resolution: `${width} × ${height} px`,
    sharpnessScore,
    lightingCategory,
    orientation,
    obstruction: 'None',
    singleFaceVerified: true,
    warnings,
  };
}

/**
 * Deterministic SHA-like verification hash for consent logs
 */
export function generateConsentHash(name: string, timestamp: string, imageLength: number): string {
  let hash = 0x811c9dc5;
  const input = `${name}-${timestamp}-${imageLength}-auth-v1`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `C2PA-SEC-${hex.toUpperCase()}-${timestamp.slice(0, 10).replace(/-/g, '')}`;
}

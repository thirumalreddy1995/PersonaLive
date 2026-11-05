/**
 * Measured quality assessment of a persona photo, shared by the enrolment flow and the local
 * persona loader so no persona ever carries hand-typed resolution or sharpness numbers.
 */
import { calculateEyeAspectRatio, calculateMouthAspectRatio, evaluateImageQuality, QualityAssessmentResult } from './faceMath.ts';
import { jpegBlockiness, leftRightLuminanceRatio, measureImageStatistics } from './imageStatistics.ts';
import { FaceTracker } from './faceTracker.ts';
import { FACE_OVAL_RING } from '../../tools/realism/landmarks.ts';
import { LM } from './faceMesh.ts';

export function loadImage(src: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The photo could not be decoded. Try a different JPG, PNG or WebP file.'));
    img.src = src;
  });
}

/**
 * Decodes the photo and scores it from measured luminance, contrast and sharpness. If the pixels
 * cannot be read (cross-origin image without CORS headers), the resolution-only score is returned
 * with an explicit warning rather than fabricated lighting/sharpness values.
 */
export async function assessPhoto(src: string, crossOrigin: boolean): Promise<QualityAssessmentResult> {
  const img = await loadImage(src, crossOrigin);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  try {
    const stats = measureImageStatistics(img);
    return evaluateImageQuality(width, height, stats.averageLuminance, stats.contrastStdDev, stats.estimatedSharpness);
  } catch (err) {
    console.warn('Photo statistics unavailable, scoring resolution only.', err);
    const result = evaluateImageQuality(width, height);
    result.warnings.push('Lighting and sharpness could not be measured for this image.');
    return result;
  }
}

/** Reference quality gate (R2 §3): what the persona card shows beyond the basic score. */
export interface ReferenceGate {
  /** Face height (chin to forehead landmark) in photo pixels; ≥ 600 recommended. */
  faceHeightPx: number | null;
  /** Variance of the Laplacian on the 256 px copy (blur estimate). */
  laplacianVariance: number;
  /** 8×8 boundary / interior step ratio at full resolution (~1 clean, > 1.3 recompressed). */
  blockiness: number;
  /** Left/right luma ratio over the face box (1 = even). */
  lightingRatio: number | null;
  eyesOpen: boolean | null;
  mouthClosed: boolean | null;
  neutral: boolean | null;
  /** Heavy recompression at a small size: a forwarded / messaging-app copy. */
  forwardedCopy: boolean;
  warnings: string[];
}

export const FACE_HEIGHT_RECOMMENDED_PX = 600;
export const BLOCKINESS_WARN = 1.3;

let gateTracker: FaceTracker | null = null;
let gateTrackerLoad: Promise<FaceTracker> | null = null;

/** One IMAGE-mode landmarker for the enrolment card, created on first use. */
function getGateTracker(): Promise<FaceTracker> {
  if (gateTracker?.ready) return Promise.resolve(gateTracker);
  if (!gateTrackerLoad) {
    const t = new FaceTracker();
    gateTrackerLoad = t
      .load(() => undefined)
      .then(() => {
        gateTracker = t;
        return t;
      })
      .catch((err: unknown) => {
        gateTrackerLoad = null;
        throw err;
      });
  }
  return gateTrackerLoad;
}

/** Pure part of the gate, given full-resolution pixels and (optionally) normalized landmarks. */
export function evaluateReferenceGate(
  data: ArrayLike<number>,
  width: number,
  height: number,
  laplacianVariance: number,
  landmarks: ArrayLike<number> | null,
  blendshapes: Record<string, number> | null
): ReferenceGate {
  const warnings: string[] = [];
  const blockiness = jpegBlockiness(data, width, height);
  let faceHeightPx: number | null = null;
  let lightingRatio: number | null = null;
  let eyesOpen: boolean | null = null;
  let mouthClosed: boolean | null = null;
  let neutral: boolean | null = null;
  if (landmarks) {
    const px = (i: number) => ({ x: landmarks[i * 2] * width, y: landmarks[i * 2 + 1] * height });
    const top = px(LM.FOREHEAD);
    const chin = px(LM.CHIN);
    faceHeightPx = Math.hypot(chin.x - top.x, chin.y - top.y);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of FACE_OVAL_RING) {
      const p = px(i);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    lightingRatio = leftRightLuminanceRatio(data, width, { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    const l = LM.LEFT_EYE, r = LM.RIGHT_EYE, m = LM.MOUTH;
    const earL = calculateEyeAspectRatio(px(l.outer), px(l.top1), px(l.top2), px(l.inner), px(l.bottom2), px(l.bottom1));
    const earR = calculateEyeAspectRatio(px(r.outer), px(r.top1), px(r.top2), px(r.inner), px(r.bottom2), px(r.bottom1));
    eyesOpen = (earL + earR) / 2 > 0.18;
    mouthClosed = calculateMouthAspectRatio(px(m.upperInner), px(m.lowerInner), px(m.cornerRight), px(m.cornerLeft)) < 0.08;
    if (blendshapes) {
      const smile = ((blendshapes.mouthSmileLeft ?? 0) + (blendshapes.mouthSmileRight ?? 0)) / 2;
      const brow = blendshapes.browInnerUp ?? 0;
      const jaw = blendshapes.jawOpen ?? 0;
      neutral = smile < 0.35 && brow < 0.5 && jaw < 0.25;
    }
    if (faceHeightPx < FACE_HEIGHT_RECOMMENDED_PX) warnings.push(`The face is ${Math.round(faceHeightPx)} px tall; ${FACE_HEIGHT_RECOMMENDED_PX} px or more keeps skin detail after the warp.`);
    if (lightingRatio > 1.35 || lightingRatio < 1 / 1.35) warnings.push('One side of the face is much brighter than the other; even lighting matches more webcams.');
    if (eyesOpen === false) warnings.push('The eyes look closed in this photo.');
    if (mouthClosed === false) warnings.push('The mouth is open in this photo; a closed mouth gives the cleanest lip texture.');
    if (neutral === false) warnings.push('The expression is not neutral; smiles and raised brows get baked into every frame.');
  }
  const forwardedCopy = blockiness > BLOCKINESS_WARN && Math.max(width, height) <= 1024;
  if (forwardedCopy) {
    warnings.push('This looks like a forwarded or messaging-app copy (heavy recompression at a small size). The original photo will look better; this one still works.');
  } else if (blockiness > BLOCKINESS_WARN) {
    warnings.push('JPEG block artefacts detected; a less compressed export will look better.');
  }
  return { faceHeightPx, laplacianVariance, blockiness, lightingRatio, eyesOpen, mouthClosed, neutral, forwardedCopy, warnings };
}

/**
 * Full gate for the enrolment card: decodes the photo at full resolution for the blockiness test,
 * runs the landmarker (IMAGE mode) for face height, lighting and expression, and merges the
 * warnings into the basic assessment.
 */
export async function assessReference(src: string, crossOrigin: boolean): Promise<{ quality: QualityAssessmentResult; gate: ReferenceGate | null }> {
  const quality = await assessPhoto(src, crossOrigin);
  try {
    const img = await loadImage(src, crossOrigin);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const scale = Math.min(1, 2048 / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, cw, ch);
    const { data } = ctx.getImageData(0, 0, cw, ch);
    let landmarks: Float32Array | null = null;
    let blendshapes: Record<string, number> | null = null;
    try {
      const tracker = await getGateTracker();
      const { faces } = await tracker.detectImage(img);
      if (faces[0]) {
        landmarks = faces[0].landmarks;
        blendshapes = faces[0].blendshapes;
      }
    } catch (err) {
      console.warn('Reference gate: landmarker unavailable, skipping the face checks.', err);
    }
    const stats = measureImageStatistics(img);
    const gate = evaluateReferenceGate(data, cw, ch, stats.laplacianVariance, landmarks, blendshapes);
    quality.warnings.push(...gate.warnings);
    return { quality, gate };
  } catch (err) {
    console.warn('Reference gate skipped.', err);
    return { quality, gate: null };
  }
}

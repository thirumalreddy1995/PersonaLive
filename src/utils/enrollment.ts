/**
 * Guided persona enrollment (R5 §2, flag guidedEnrollment): the pure parts.
 *
 * The person whose face will be used sits at the webcam, accepts the consent text and is guided
 * through a fixed set of reference shots. Each shot is checked live for pose, expression, blur and
 * exposure before it is taken. The result is a persona whose consent record is signed by that
 * person and lists the SHA-256 of every shot; everything stays on the machine.
 *
 * This module has no DOM and no engine dependency: step definitions, the per-frame shot check,
 * the hold timer, the image statistics and the record builders are unit-tested.
 */
import { AuthorizedPersona, CONSENT_FORM_VERSION, ConsentRecord, HeadPose, PersonaCategory, PersonaReference } from '../types/index.ts';

export type EnrollmentExpression = 'neutral' | 'open-mouth' | 'smile';

export interface EnrollmentStep {
  id: string;
  label: string;
  /** What the person is asked to do, in screen terms (the preview is mirrored, like a mirror). */
  instruction: string;
  /** Head pose relative to the neutral frontal shot, degrees (yaw positive = toward the right edge of the screen, pitch positive = down). */
  target: { yaw: number; pitch: number };
  tolerance: { yaw: number; pitch: number };
  expression: EnrollmentExpression;
}

/** Plan R5 §2: neutral frontal, ±25° yaw, ±15° pitch, open mouth, smile. The frontal shot comes first: it is the baseline the others are measured from. */
export const ENROLLMENT_STEPS: ReadonlyArray<EnrollmentStep> = [
  { id: 'frontal', label: 'Frontal', instruction: 'Look straight at the screen with a relaxed, closed mouth.', target: { yaw: 0, pitch: 0 }, tolerance: { yaw: 8, pitch: 8 }, expression: 'neutral' },
  { id: 'yaw-right', label: 'Turn right', instruction: 'Slowly turn your head toward the right edge of the screen.', target: { yaw: 25, pitch: 0 }, tolerance: { yaw: 6, pitch: 8 }, expression: 'neutral' },
  { id: 'yaw-left', label: 'Turn left', instruction: 'Slowly turn your head toward the left edge of the screen.', target: { yaw: -25, pitch: 0 }, tolerance: { yaw: 6, pitch: 8 }, expression: 'neutral' },
  { id: 'pitch-up', label: 'Chin up', instruction: 'Face the screen and raise your chin a little.', target: { yaw: 0, pitch: -15 }, tolerance: { yaw: 8, pitch: 5 }, expression: 'neutral' },
  { id: 'pitch-down', label: 'Chin down', instruction: 'Face the screen and lower your chin a little.', target: { yaw: 0, pitch: 15 }, tolerance: { yaw: 8, pitch: 5 }, expression: 'neutral' },
  { id: 'open-mouth', label: 'Open mouth', instruction: 'Face the screen and open your mouth as if saying "aah".', target: { yaw: 0, pitch: 0 }, tolerance: { yaw: 8, pitch: 8 }, expression: 'open-mouth' },
  { id: 'smile', label: 'Smile', instruction: 'Face the screen and smile.', target: { yaw: 0, pitch: 0 }, tolerance: { yaw: 8, pitch: 8 }, expression: 'smile' },
];

/**
 * Before the frontal baseline exists the pitch band is absolute. A camera above or below the face
 * reads a few degrees of pitch at rest, so it is wider than the later steps' tolerance, but it must
 * stay below the chin-up/chin-down target (15 degrees) minus that step's tolerance (5): at the
 * R5 value of 18 a chin-down frame (17 degrees) passed as frontal. 9.5 rather than 10 so no pitch is both frontal and a chin shot.
 */
export const FRONTAL_PITCH_BAND = 9.5;
export const NEUTRAL_MAX_MAR = 0.14;
export const NEUTRAL_MAX_SMILE = 0.3;
/** Mouth aperture for the open-mouth shot. Speech peaks near 0.27 on the review clips; with the still hold a held "aah" passes from 0.26 (R5 used 0.30, which a natural "aah" at a laptop camera angle did not reach). */
export const OPEN_MOUTH_MIN_MAR = 0.26;
export const SMILE_MIN_SCORE = 0.45;
/** Blur: Laplacian variance of the face crop at ENROLL_ANALYSIS_WIDTH pixels wide (8-bit luma). Provisional floor, to be tuned on recorded shots. */
export const ENROLL_MIN_SHARPNESS = 4;
export const ENROLL_ANALYSIS_WIDTH = 256;
/** Exposure: mean face luma (0..255) and the share of clipped pixels. */
export const ENROLL_LUMA_RANGE: [number, number] = [50, 205];
export const ENROLL_MAX_CLIPPED = 0.05;
/** The checks must pass continuously this long, with the head this still, before a shot is taken. */
export const ENROLL_HOLD_MS = 600;
export const ENROLL_MAX_POSE_SPEED = 12;

/** One frame of the live tracker, as the shot check sees it. */
export interface EnrollmentSample {
  faceVisible: boolean;
  /** Live head pose in the driver convention (the mirrored display), degrees. */
  yaw: number;
  pitch: number;
  mar: number;
  /** Smile blendshape score, 0..1. */
  smile: number;
  /** Laplacian variance of the face crop (see laplacianVariance), null when not measured this frame. */
  sharpness: number | null;
  meanLuma: number | null;
  clippedShare: number | null;
}

export interface ShotEvaluation {
  ok: boolean;
  checks: { face: boolean; pose: boolean; expression: boolean; sharpness: boolean; exposure: boolean };
  /** What to change, most important first; empty when ok. */
  hints: string[];
}

/**
 * Checks one live frame against a step. `baseline` is the pose of the neutral frontal shot (null
 * while that shot is being taken): later steps are measured relative to it, so a camera above or
 * below the face does not shift every target.
 */
export function evaluateShot(step: EnrollmentStep, s: EnrollmentSample, baseline: { yaw: number; pitch: number } | null): ShotEvaluation {
  const hints: string[] = [];
  const checks = { face: s.faceVisible, pose: false, expression: false, sharpness: false, exposure: false };
  if (!s.faceVisible) return { ok: false, checks, hints: ['No face found. Sit in front of the camera with your whole face in view.'] };

  // Pose.
  const dyaw = s.yaw - (baseline ? baseline.yaw : 0) - step.target.yaw;
  const dpitch = s.pitch - (baseline ? baseline.pitch : 0) - step.target.pitch;
  const pitchTol = baseline ? step.tolerance.pitch : FRONTAL_PITCH_BAND;
  const yawOk = Math.abs(dyaw) <= step.tolerance.yaw;
  const pitchOk = Math.abs(dpitch) <= pitchTol;
  checks.pose = yawOk && pitchOk;
  if (!yawOk) hints.push(dyaw > 0 ? 'Turn a little toward the left edge of the screen.' : 'Turn a little toward the right edge of the screen.');
  if (!pitchOk) hints.push(dpitch > 0 ? 'Raise your chin a little.' : 'Lower your chin a little.');

  // Expression.
  if (step.expression === 'neutral') {
    checks.expression = s.mar <= NEUTRAL_MAX_MAR && s.smile <= NEUTRAL_MAX_SMILE;
    if (s.mar > NEUTRAL_MAX_MAR) hints.push('Close your mouth.');
    else if (s.smile > NEUTRAL_MAX_SMILE) hints.push('Relax your face (no smile).');
  } else if (step.expression === 'open-mouth') {
    checks.expression = s.mar >= OPEN_MOUTH_MIN_MAR;
    if (!checks.expression) hints.push('Open your mouth wider.');
  } else {
    checks.expression = s.smile >= SMILE_MIN_SCORE;
    if (!checks.expression) hints.push('Smile a little more.');
  }

  // Image quality (measured on the face crop; unknown counts as not yet passed).
  checks.sharpness = s.sharpness !== null && s.sharpness >= ENROLL_MIN_SHARPNESS;
  if (s.sharpness !== null && !checks.sharpness) hints.push('The picture is blurred: hold still, or clean the lens and add light.');
  const lumaOk = s.meanLuma !== null && s.meanLuma >= ENROLL_LUMA_RANGE[0] && s.meanLuma <= ENROLL_LUMA_RANGE[1];
  const clipOk = s.clippedShare !== null && s.clippedShare <= ENROLL_MAX_CLIPPED;
  checks.exposure = lumaOk && clipOk;
  if (s.meanLuma !== null && s.meanLuma < ENROLL_LUMA_RANGE[0]) hints.push('Too dark: add light on your face.');
  else if (s.meanLuma !== null && s.meanLuma > ENROLL_LUMA_RANGE[1]) hints.push('Too bright: reduce the light on your face.');
  else if (s.clippedShare !== null && !clipOk) hints.push('Parts of your face are over- or under-exposed: use softer, more even light.');

  const ok = checks.face && checks.pose && checks.expression && checks.sharpness && checks.exposure;
  return { ok, checks, hints };
}

/**
 * Fires once the shot check has passed without a break for ENROLL_HOLD_MS while the head moved
 * slower than ENROLL_MAX_POSE_SPEED degrees per second: the shot is taken on a still, settled face.
 */
export class ShotHold {
  private since: number | null = null;
  private last: { t: number; yaw: number; pitch: number } | null = null;

  constructor(
    private readonly holdMs = ENROLL_HOLD_MS,
    private readonly maxSpeed = ENROLL_MAX_POSE_SPEED
  ) {}

  reset(): void {
    this.since = null;
    this.last = null;
  }

  /** Progress of the hold, 0..1. */
  progress(tMs: number): number {
    return this.since === null ? 0 : Math.min(1, (tMs - this.since) / this.holdMs);
  }

  /** Feeds one frame; returns true on the frame the hold completes. */
  push(ok: boolean, pose: { yaw: number; pitch: number }, tMs: number): boolean {
    const prev = this.last;
    this.last = { t: tMs, yaw: pose.yaw, pitch: pose.pitch };
    let still = true;
    if (prev && tMs > prev.t) {
      const speed = (Math.hypot(pose.yaw - prev.yaw, pose.pitch - prev.pitch) / (tMs - prev.t)) * 1000;
      still = speed <= this.maxSpeed;
    }
    if (!ok || !still) {
      this.since = null;
      return false;
    }
    if (this.since === null) this.since = tMs;
    if (tMs - this.since >= this.holdMs) {
      this.since = null;
      return true;
    }
    return false;
  }
}

/** Rec. 601 luma of RGBA pixels as 8-bit values. */
export function toLuma(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
  return out;
}

/** Variance of the 4-neighbour Laplacian over the interior pixels: low for a blurred image. */
export function laplacianVariance(luma: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = luma[i - width] + luma[i + width] + luma[i - 1] + luma[i + 1] - 4 * luma[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Mean luma (0..255) and the share of pixels clipped dark (≤ 4) or bright (≥ 251). */
export function exposureStats(luma: ArrayLike<number>): { meanLuma: number; clippedShare: number } {
  if (luma.length === 0) return { meanLuma: 0, clippedShare: 1 };
  let sum = 0, clipped = 0;
  for (let i = 0; i < luma.length; i++) {
    const v = luma[i];
    sum += v;
    if (v <= 4 || v >= 251) clipped++;
  }
  return { meanLuma: sum / luma.length, clippedShare: clipped / luma.length };
}

/** One captured shot. */
export interface EnrollmentShot {
  stepId: string;
  label: string;
  /** The photo as a data URL (un-mirrored camera frame). */
  dataUrl: string;
  /** SHA-256 hex of the photo bytes. */
  sha256: string;
  pose: HeadPose;
  matrixPose: HeadPose | null;
  expression: { mar: number; smile: number; browElevation: number };
  quality: { sharpness: number; meanLuma: number; clippedShare: number };
}

export interface EnrollmentConsentInput {
  signerName: string;
  /** The person confirmed they are the one at the camera and in the photos, signing for themselves. */
  attested: boolean;
  scope: { liveCalls: boolean; cloudProcessing: boolean; recordings: boolean };
  /** ISO timestamp of the signature. */
  signedAt: string;
}

/**
 * The signed consent record for an enrollment: the same shape the consent form writes (R3c), with
 * the hash of every shot. Throws when the attestation is missing, there is no signer name, no
 * live-call use is granted or a shot has no hash: such an enrollment must not produce a usable persona.
 */
export function buildEnrollmentConsent(input: EnrollmentConsentInput, shots: ReadonlyArray<EnrollmentShot>): ConsentRecord {
  const signerName = input.signerName.trim();
  if (!signerName) throw new Error('The person pictured must enter their name.');
  if (!input.attested) throw new Error('Only the person at the camera can sign this record.');
  if (!input.scope.liveCalls) throw new Error('Consent to live video calls where every participant knows they are seeing a persona is required.');
  if (shots.length === 0) throw new Error('No reference shots were taken.');
  const hashes = shots.map((s) => s.sha256);
  if (hashes.some((h) => !/^[0-9a-f]{64}$/.test(h))) throw new Error('A reference shot could not be hashed.');
  const usage = [
    'live video calls where all participants know they see a persona',
    input.scope.cloudProcessing && 'opt-in cloud processing of face crops (no frames stored)',
    input.scope.recordings && 'recordings of such calls',
  ]
    .filter(Boolean)
    .join('; ');
  return {
    status: 'signed',
    signerName,
    authorizedUsage: usage,
    timestamp: input.signedAt,
    signedAt: input.signedAt,
    scope: { ...input.scope },
    imageHashes: hashes,
    formVersion: CONSENT_FORM_VERSION,
    signatureHash: `sha256:${hashes[0].slice(0, 16)}@${input.signedAt.slice(0, 10)}`,
    verified: true,
  };
}

/** True when every step of the plan has a shot. */
export function enrollmentComplete(shots: ReadonlyArray<EnrollmentShot>): boolean {
  return ENROLLMENT_STEPS.every((step) => shots.some((s) => s.stepId === step.id));
}

/**
 * The persona an enrollment produces: the neutral frontal shot is its photo, every shot is a
 * reference (frontal first, in plan order), and the consent record covers all of them.
 */
export function enrollmentPersona(
  info: { id: string; name: string; role?: string; category: PersonaCategory; width: number; height: number },
  shots: ReadonlyArray<EnrollmentShot>,
  consent: ConsentRecord
): AuthorizedPersona {
  if (!enrollmentComplete(shots)) throw new Error('The reference set is incomplete.');
  if (consent.status !== 'signed' || !consent.verified) throw new Error('The consent record is not signed.');
  const ordered = ENROLLMENT_STEPS.map((step) => shots.find((s) => s.stepId === step.id)!);
  const missing = ordered.filter((s) => !consent.imageHashes?.includes(s.sha256));
  if (missing.length) throw new Error('The consent record does not cover every reference shot.');
  const frontal = ordered[0];
  const references: PersonaReference[] = ordered.map((s) => ({
    id: `${info.id}-${s.stepId}`,
    label: s.label,
    imageUrl: s.dataUrl,
    pose: { ...s.pose },
    matrixPose: s.matrixPose ? { ...s.matrixPose } : null,
    expression: { ...s.expression },
  }));
  const meanSharpness = ordered.reduce((a, s) => a + s.quality.sharpness, 0) / ordered.length;
  const luma = frontal.quality.meanLuma;
  return {
    id: info.id,
    name: info.name.trim(),
    role: info.role?.trim() || 'Enrolled at the webcam',
    category: info.category,
    imageUrl: frontal.dataUrl,
    createdAt: consent.timestamp.slice(0, 10),
    qualityScore: Math.round(Math.min(100, 60 + Math.min(40, meanSharpness))),
    metrics: {
      resolution: `${info.width} × ${info.height} px`,
      sharpness: Math.round(Math.min(100, meanSharpness * 4)),
      lighting: luma < ENROLL_LUMA_RANGE[0] + 20 ? 'Underexposed' : luma > ENROLL_LUMA_RANGE[1] - 20 ? 'Overexposed' : 'Optimal',
      orientation: 'Frontal',
      obstruction: 'None',
      singleFaceVerified: true,
    },
    consent,
    references,
  };
}

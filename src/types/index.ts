/** Faces are grouped so a woman's face is only mapped onto a woman and a man's onto a man. */
export type PersonaCategory = 'women' | 'men';

export const CATEGORY_LABEL: Record<PersonaCategory, { one: string; plural: string }> = {
  women: { one: 'Woman', plural: "Women's faces" },
  men: { one: 'Man', plural: "Men's faces" },
};

export interface AuthorizedPersona {
  id: string;
  name: string;
  role: string;
  category: PersonaCategory;
  imageUrl: string;
  createdAt: string;
  qualityScore: number; // 0 - 100
  metrics: {
    resolution: string;
    sharpness: number; // 0 - 100
    lighting: 'Optimal' | 'Overexposed' | 'Underexposed' | 'Acceptable';
    orientation: 'Frontal' | 'Slight Angle' | 'Extreme Angle';
    obstruction: 'None' | 'Partial Glasses' | 'Occluded';
    singleFaceVerified: boolean;
  };
  consent: ConsentRecord;
}

/** Version of the consent form whose fields a record carries. */
export const CONSENT_FORM_VERSION = 1;

/**
 * Consent of the person pictured. Local personas start as `pending` (no usage granted, the gate
 * stays closed) until that person signs the form themselves (src/components/ConsentForm.tsx).
 */
export interface ConsentRecord {
  signerName: string;
  authorizedUsage: string;
  timestamp: string;
  signatureHash: string;
  /** True only when a signed record grants live-call use. */
  verified: boolean;
  /** `pending` until the pictured person has signed; absent on legacy/sample records (treated as signed). */
  status?: 'pending' | 'signed';
  signedAt?: string | null;
  scope?: { liveCalls: boolean; cloudProcessing: boolean; recordings: boolean };
  /** SHA-256 hex of every photo the record covers. */
  imageHashes?: string[];
  formVersion?: number;
}

export function consentPending(c: ConsentRecord): boolean {
  return c.status === 'pending' || (c.status === 'signed' && !c.verified);
}

export interface HeadPose {
  yaw: number; // Left - Right (-45 to 45 deg)
  pitch: number; // Up - Down (-30 to 30 deg)
  roll: number; // Tilt (-30 to 30 deg)
}

export interface FacialMetrics {
  eyeAspectRatioLeft: number; // EAR (0.0 closed to ~0.35 open)
  eyeAspectRatioRight: number;
  mouthAspectRatio: number; // MAR (0.0 closed to ~0.8 wide open)
  mouthWidthRatio: number;
  eyebrowElevation: number; // 0.0 - 1.0
  isBlinking: boolean;
  isSmiling: boolean;
  isSpeaking: boolean;
  gazeX: number; // -1 (left) to 1 (right)
  gazeY: number; // -1 (up) to 1 (down)
}

export interface TelemetryStats {
  fps: number;
  latencyMs: number;
  frameDrops: number;
  gpuUsagePercent: number;
  cpuUsagePercent: number;
  vramMb: number;
  resolution: string;
  inferenceEngine: string;
}

/** Live state of the on-device tracking & rendering pipeline, surfaced to the UI. */
export interface EngineStatus {
  model: 'idle' | 'loading' | 'ready' | 'error';
  modelProgress: number; // 0..1
  modelMessage: string;
  backend: 'GPU' | 'CPU' | '-';
  renderer: 'webgl2' | 'webgl' | 'canvas2d';
  source: 'none' | 'webcam' | 'demo' | 'file';
  faceDetected: boolean;
  persona: 'none' | 'preparing' | 'ready' | 'no-face' | 'error';
  personaMessage?: string;
  /** Quality-gate warnings about the persona photo (R4): e.g. hair or glasses over the face skin. */
  personaWarnings?: string[];
}

export interface TransformationSettings {
  blendStrength: number; // 0 - 100
  temporalSmoothing: number; // 0 - 100
  expressionGain: number; // 0.5 - 2.0
  lipSyncSensitivity: number; // 0.5 - 2.0
  manualSmileBias: number; // -0.5 to 0.5
  audioReactiveLipSync: boolean;
  eyeGazeSync: boolean;
  /** Fade the persona lips out as the mouth opens so the wearer's own lips show (R1). */
  keepRealMouth: boolean;
  /** Eye pass-through ring in tessellation rings (0 = none, 1 = just past the lash line, up to 2). */
  eyePassThroughRadius: number;
  /** Minimum lip fade, 0..1: 0 shows the persona lips at rest, 1 keeps the wearer's lips always (R3c item 4). */
  lipFadeFloor: number;
  /** Run the segmenter every N frames (R4 §1). */
  segmentEvery: number;
  /** Longest edge of the persona texture after the face crop (R2 §2). */
  personaTextureSize: 512 | 1024 | 2048;
  /** One Euro minimum cutoff (Hz) of the rigid head pose behind the forehead (realism flag rigidForehead). */
  rigidPoseMinCutoff: number;
  /** One Euro speed coefficient of the rigid head pose: higher follows fast turns with less lag. */
  rigidPoseBeta: number;
  /** Learn the wearer's forehead shape as a per-vertex offset while the head is near frontal. */
  rigidShapeOffset: boolean;
  /** R3 relighting tone match, 0..1: 0 keeps the persona's complexion everywhere, 1 matches the wearer's at the face boundary. */
  skinToneMatch: number;
  /** R3 relighting low-pass sigma as a share of face width (0.02 measured on the persona grid; 5% let harshly lit personas keep their own shading, the plan's 6–10% darkened the cheeks). */
  relightRadius: number;
  lightingAdaptation: boolean;
  preserveFacialHair: boolean;
  showLandmarkOverlay: boolean;
  showBoundingBoxes: boolean;
  outputResolution: '1080p' | '720p' | '540p';
  viewMode: 'split' | 'side-by-side' | 'transformed-only' | 'pip';
  virtualCameraActive: boolean;
}

export interface UserAccount {
  email: string;
  phone: string;
  fullName: string;
  tier: 'Free Trial' | 'Pro Creator' | 'Studio Enterprise';
  licenseKey: string;
  expiresAt: string;
  isAuthenticated: boolean;
}

export interface RecordedClip {
  id: string;
  title: string;
  timestamp: string;
  durationSeconds: number;
  personaUsed: string;
  sizeMb: number;
  c2paVerified: boolean;
  /** Object URL of the recorded WebM blob (empty for sample entries). */
  downloadUrl: string;
  mimeType?: string;
}

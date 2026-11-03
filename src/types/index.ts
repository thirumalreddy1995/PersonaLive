export interface AuthorizedPersona {
  id: string;
  name: string;
  role: string;
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
  consent: {
    signerName: string;
    authorizedUsage: string;
    timestamp: string;
    signatureHash: string;
    verified: boolean;
  };
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
  inferenceEngine: 'ONNX DirectML (FP16)' | 'TensorRT (RTX Accel)' | 'CoreML Neural Engine' | 'CPU Safe-Fallback';
}

export interface TransformationSettings {
  blendStrength: number; // 0 - 100
  temporalSmoothing: number; // 0 - 100
  expressionGain: number; // 0.5 - 2.0
  lipSyncSensitivity: number; // 0.5 - 2.0
  manualSmileBias: number; // -0.5 to 0.5
  audioReactiveLipSync: boolean;
  eyeGazeSync: boolean;
  lightingAdaptation: boolean;
  preserveFacialHair: boolean;
  showLandmarkOverlay: boolean;
  showBoundingBoxes: boolean;
  outputResolution: '1080p' | '720p' | '540p';
  viewMode: 'split' | 'side-by-side' | 'transformed-only' | 'pip';
  virtualCameraActive: boolean;
  watermarkMandatory: boolean;
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
  downloadUrl: string;
}

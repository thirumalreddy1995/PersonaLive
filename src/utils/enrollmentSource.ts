/**
 * Live input of the guided enrollment (R5 §2).
 *
 * The studio's engine already tracks the webcam; the enrollment dialog reads that tracking and
 * the raw camera frame through this small registry instead of opening a second tracker. Only a
 * live webcam qualifies: a recorded clip or the demo image is not "the person at the camera".
 */
import type { HeadPose } from '../types/index.ts';

export interface EnrollmentFrame {
  /** The webcam's video element (raw, un-mirrored frames). */
  video: HTMLVideoElement;
  faceVisible: boolean;
  /** Landmark-estimate head pose in the driver convention (mirrored display). */
  pose: HeadPose;
  /** Head pose from MediaPipe's transformation matrix in the same convention, null without a matrix. */
  matrixPose: HeadPose | null;
  mar: number;
  /** Mean of the two smile blendshapes, 0..1. */
  smile: number;
  browElevation: number;
  /** Face bounds in the source frame, normalised [x, y, width, height]; null without a face. */
  faceBox: [number, number, number, number] | null;
}

type Provider = () => EnrollmentFrame | null;

let provider: Provider | null = null;

/** Registered by the studio viewport while its engine is alive. */
export function setEnrollmentFrameProvider(p: Provider | null): void {
  provider = p;
}

/** The current live frame, or null when no webcam is running in the studio. */
export function getEnrollmentFrame(): EnrollmentFrame | null {
  try {
    return provider ? provider() : null;
  } catch {
    return null;
  }
}

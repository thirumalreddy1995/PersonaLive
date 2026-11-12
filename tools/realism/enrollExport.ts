/**
 * The review-only export of a guided enrollment (R5 §2), pure parts.
 *
 * `realism:enroll` drives the enrollment dialog and writes the shots it took to a gitignored folder
 * under realism-review/; `realism:capture --enrolled <dir>` loads them as a review persona with
 * reference keyframes. The export never carries the signed consent record: a persona loaded from it
 * runs with a pending record, which only a review build activates.
 */
export interface Pose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface EnrollmentShotSnapshot {
  stepId: string;
  label: string;
  dataUrl: string;
  sha256: string;
  pose: Pose;
  matrixPose: Pose | null;
  expression: { mar: number; smile: number; browElevation: number };
  quality: { sharpness: number; meanLuma: number; clippedShare: number };
}

export interface EnrollmentExportShot extends Omit<EnrollmentShotSnapshot, 'dataUrl'> {
  /** File name of the photo next to enrollment.json. */
  file: string;
}

/** A step the dialog did not take within the time allowed, with what its checks said. */
export interface EnrollmentRefusal {
  stepId: string;
  waitedMs: number;
  /** Share of the polled frames on which each check passed. */
  passShare: Record<string, number>;
  /** The dialog's hints while waiting, most frequent first. */
  hints: Array<{ hint: string; share: number }>;
  /** Largest mouth aperture and smile score seen while waiting. */
  maxMar: number;
  maxSmile: number;
}

export interface EnrollmentExport {
  kind: 'personalive-enrollment-export';
  /** Always true: the export is for the local realism review and carries no consent record. */
  reviewOnly: true;
  /** How the camera was fed: a person at a webcam, or a recording behind Chrome's fake device. */
  camera: 'live' | 'fake-device';
  /** The recording behind the fake device (file name only), null for a live camera. */
  cameraFile: string | null;
  name: string;
  category: 'men' | 'women';
  createdAt: string;
  /** True when every step of the plan has a shot and the dialog saved the persona. */
  complete: boolean;
  /** The steps of the plan, in order. */
  steps: string[];
  shots: EnrollmentExportShot[];
  refusals: EnrollmentRefusal[];
}

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,/;

export function shotFileName(stepId: string, dataUrl: string): string {
  const m = DATA_URL.exec(dataUrl);
  if (!m) throw new Error(`shot ${stepId} is not an image data URL`);
  if (!/^[a-z0-9-]+$/.test(stepId)) throw new Error(`unexpected step id ${stepId}`);
  return `${stepId}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
}

export function shotBytes(dataUrl: string): Buffer {
  if (!DATA_URL.test(dataUrl)) throw new Error('not an image data URL');
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/**
 * Builds the export from the dialog's shots: plan order (frontal first), one shot per step, no
 * consent record. Throws without a frontal shot: it is the persona's photo and the baseline of the others.
 */
export function buildEnrollmentExport(input: {
  steps: string[];
  shots: EnrollmentShotSnapshot[];
  refusals: EnrollmentRefusal[];
  saved: boolean;
  name: string;
  category: 'men' | 'women';
  camera: 'live' | 'fake-device';
  cameraFile: string | null;
  createdAt: string;
}): EnrollmentExport {
  const ordered: EnrollmentExportShot[] = [];
  for (const stepId of input.steps) {
    const shot = input.shots.find((s) => s.stepId === stepId);
    if (!shot) continue;
    const { dataUrl, ...rest } = shot;
    ordered.push({ ...rest, file: shotFileName(stepId, dataUrl) });
  }
  if (ordered[0]?.stepId !== 'frontal') throw new Error('the enrollment has no frontal shot');
  const complete = input.saved && input.steps.every((id) => ordered.some((s) => s.stepId === id));
  return {
    kind: 'personalive-enrollment-export',
    reviewOnly: true,
    camera: input.camera,
    cameraFile: input.cameraFile,
    name: input.name,
    category: input.category,
    createdAt: input.createdAt,
    complete,
    steps: [...input.steps],
    shots: ordered,
    refusals: input.refusals.filter((r) => !ordered.some((s) => s.stepId === r.stepId)),
  };
}

/** Running tally of the dialog's checks while one step waits. */
export class StepTally {
  private frames = 0;
  private passes: Record<string, number> = {};
  private hintCounts = new Map<string, number>();
  private maxMar = 0;
  private maxSmile = 0;

  push(checks: Record<string, boolean> | null, hint: string | null, live: { mar: number; smile: number } | null): void {
    if (!checks) return;
    this.frames++;
    for (const [k, ok] of Object.entries(checks)) this.passes[k] = (this.passes[k] ?? 0) + (ok ? 1 : 0);
    if (hint) this.hintCounts.set(hint, (this.hintCounts.get(hint) ?? 0) + 1);
    if (live) {
      this.maxMar = Math.max(this.maxMar, live.mar);
      this.maxSmile = Math.max(this.maxSmile, live.smile);
    }
  }

  refusal(stepId: string, waitedMs: number): EnrollmentRefusal {
    const n = Math.max(1, this.frames);
    const passShare: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.passes)) passShare[k] = v / n;
    const hints = [...this.hintCounts.entries()].sort((a, b) => b[1] - a[1]).map(([hint, c]) => ({ hint, share: c / n }));
    return { stepId, waitedMs, passShare, hints, maxMar: this.maxMar, maxSmile: this.maxSmile };
  }
}

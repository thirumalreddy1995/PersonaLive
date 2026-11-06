/**
 * Identity guard (R3b): runs tools/realism/identity.py (OpenCV Zoo YuNet + SFace) on face crops of
 * the output and driver frames against the persona photo. The crops are written next to the run's
 * frames (gitignored); only the numbers go into report.json.
 *
 * The numbers are a regression guard so the persona does not fade into the wearer. They are not a
 * score to maximise and are never compared with face-verification thresholds.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RgbaImage } from './metrics.ts';
import { ROOT } from './session.ts';

export interface IdentityFrame {
  toPersona: number | null;
  toDriver: number | null;
  /** toPersona − toDriver: positive when the output is closer to the persona than to the wearer. */
  margin: number | null;
  driverToPersona: number | null;
  outputFace: boolean;
  driverFace: boolean;
}

export interface IdentitySummary {
  frames: number;
  /** Frames where YuNet found a face on the output. */
  detected: number;
  toPersona: number | null;
  toDriver: number | null;
  margin: number | null;
  minMargin: number | null;
  /** The wearer's own similarity to the persona photo (the floor the margin is measured against). */
  driverToPersona: number | null;
}

const MODELS_DIR = path.join(ROOT, 'realism-review', 'models');
const VENV_PYTHON = path.join(ROOT, 'realism-review', '.venv', 'Scripts', 'python.exe');
const SCRIPT = path.join(ROOT, 'tools', 'realism', 'identity.py');

function mean(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Mean similarities over the frames with a detected output face, plus the lowest margin. */
export function summarizeIdentity(frames: IdentityFrame[]): IdentitySummary {
  const ok = frames.filter((f) => f.outputFace);
  const margins = ok.map((f) => f.margin).filter((m): m is number => m !== null);
  return {
    frames: frames.length,
    detected: ok.length,
    toPersona: mean(ok.map((f) => f.toPersona)),
    toDriver: mean(ok.map((f) => f.toDriver)),
    margin: mean(ok.map((f) => f.margin)),
    minMargin: margins.length ? Math.min(...margins) : null,
    driverToPersona: mean(frames.map((f) => f.driverToPersona)),
  };
}

/** True when the venv Python and both OpenCV Zoo models are present. */
export function identityAvailable(): boolean {
  return (
    fs.existsSync(VENV_PYTHON) &&
    fs.existsSync(path.join(MODELS_DIR, 'face_detection_yunet_2023mar.onnx')) &&
    fs.existsSync(path.join(MODELS_DIR, 'face_recognition_sface_2021dec.onnx'))
  );
}

/** Horizontal flip (the output and driver canvases are mirrored like a webcam preview). */
export function flipHorizontal(img: RgbaImage): RgbaImage {
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      const d = (y * img.width + (img.width - 1 - x)) * 4;
      out[d] = img.data[s];
      out[d + 1] = img.data[s + 1];
      out[d + 2] = img.data[s + 2];
      out[d + 3] = img.data[s + 3];
    }
  }
  return { width: img.width, height: img.height, data: out };
}

/** Runs the recogniser on the written crops. Returns null when the script fails. */
export function runIdentity(personaPhoto: string, pairs: Array<{ output: string; driver: string }>, workDir: string): IdentityFrame[] | null {
  if (!identityAvailable() || pairs.length === 0) return null;
  const pairsFile = path.join(workDir, 'pairs.json');
  fs.writeFileSync(pairsFile, JSON.stringify(pairs));
  const res = spawnSync(VENV_PYTHON, ['-I', SCRIPT, '--models', MODELS_DIR, '--persona', personaPhoto, '--pairs', pairsFile], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.warn(`identity.py failed: ${res.stderr?.slice(0, 500)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(res.stdout) as { personaFace: boolean; frames: IdentityFrame[] };
    if (!parsed.personaFace) console.warn('identity: no face found in the persona photo');
    return parsed.frames;
  } catch (err) {
    console.warn(`identity.py output unreadable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

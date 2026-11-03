/**
 * Thin wrapper around the MediaPipe Face Landmarker (478 landmarks + 52 blendshapes).
 *
 * The WASM runtime is served locally from /mediapipe/wasm (see vite.config.ts). The model file
 * is fetched once (with progress reporting), stored in the Cache Storage API, and then loaded
 * from a buffer so repeat launches are instant.
 */
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

export type TrackerBackend = 'GPU' | 'CPU';

export interface TrackerLoadProgress {
  phase: 'runtime' | 'model' | 'warmup' | 'ready';
  /** 0..1 */
  progress: number;
  message: string;
}

export interface TrackedFace {
  /** Normalized landmark coordinates, flat [x0, y0, x1, y1, ...] in [0,1] image space. */
  landmarks: Float32Array;
  /** Blendshape scores keyed by MediaPipe category name (e.g. "mouthSmileLeft"). */
  blendshapes: Record<string, number>;
}

const WASM_BASE_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const DEFAULT_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_CACHE = 'personalive-models-v1';

export const FACE_TESSELLATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
export const FACE_OVAL = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;
export const FACE_LIPS = FaceLandmarker.FACE_LANDMARKS_LIPS;
export const FACE_LEFT_EYE = FaceLandmarker.FACE_LANDMARKS_LEFT_EYE;
export const FACE_RIGHT_EYE = FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE;
export const FACE_LEFT_IRIS = FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS;
export const FACE_RIGHT_IRIS = FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS;

async function fetchModel(url: string, onProgress: (p: number) => void): Promise<Uint8Array> {
  // 1. Cache Storage (persists across launches, works offline after first run)
  let cache: Cache | null = null;
  try {
    if ('caches' in window) {
      cache = await caches.open(MODEL_CACHE);
      const hit = await cache.match(url);
      if (hit) {
        onProgress(1);
        return new Uint8Array(await hit.arrayBuffer());
      }
    }
  } catch {
    cache = null;
  }

  // 2. Network with streaming progress
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(total ? Math.min(0.99, received / total) : 0.5);
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  if (cache) {
    try {
      await cache.put(url, new Response(buf.slice(), { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch {
      /* quota exceeded – ignore */
    }
  }
  onProgress(1);
  return buf;
}

/**
 * Owns two landmarker instances: one in VIDEO mode (temporal tracking for the live feed) and a
 * lazily-created IMAGE mode instance used to analyse persona reference photos.
 */
export class FaceTracker {
  private videoLandmarker: FaceLandmarker | null = null;
  private imageLandmarker: FaceLandmarker | null = null;
  private wasmFileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private modelBuffer: Uint8Array | null = null;
  private lastVideoTimestamp = -1;
  public backend: TrackerBackend = 'GPU';
  public ready = false;

  constructor(private modelUrl: string = (import.meta.env?.VITE_FACE_MODEL_URL as string | undefined) || DEFAULT_MODEL_URL) {}

  async load(onProgress: (p: TrackerLoadProgress) => void): Promise<void> {
    if (this.ready) return;
    onProgress({ phase: 'runtime', progress: 0.05, message: 'Starting face tracking runtime…' });
    this.wasmFileset = await FilesetResolver.forVisionTasks(WASM_BASE_PATH);

    onProgress({ phase: 'model', progress: 0.1, message: 'Downloading face landmark model (one-time, 3.7 MB)…' });
    this.modelBuffer = await fetchModel(this.modelUrl, (p) =>
      onProgress({ phase: 'model', progress: 0.1 + p * 0.7, message: 'Downloading face landmark model…' })
    );

    onProgress({ phase: 'warmup', progress: 0.85, message: 'Initialising neural landmark tracker…' });
    this.videoLandmarker = await this.createLandmarker('VIDEO');
    this.ready = true;
    onProgress({ phase: 'ready', progress: 1, message: 'Face tracking ready' });
  }

  private async createLandmarker(runningMode: 'VIDEO' | 'IMAGE'): Promise<FaceLandmarker> {
    if (!this.wasmFileset || !this.modelBuffer) throw new Error('Tracker runtime not loaded');
    const make = (delegate: TrackerBackend) =>
      FaceLandmarker.createFromOptions(this.wasmFileset!, {
        baseOptions: { modelAssetBuffer: this.modelBuffer!, delegate },
        runningMode,
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      const lm = await make(this.backend);
      return lm;
    } catch (err) {
      if (this.backend === 'GPU') {
        console.warn('GPU delegate unavailable, falling back to CPU face tracking.', err);
        this.backend = 'CPU';
        return make('CPU');
      }
      throw err;
    }
  }

  /** Runs tracking on a live frame. Returns null when no face is present. */
  detectVideo(source: HTMLVideoElement | HTMLCanvasElement, timestampMs: number): TrackedFace | null {
    if (!this.videoLandmarker) return null;
    // MediaPipe requires strictly monotonically increasing timestamps.
    const ts = timestampMs <= this.lastVideoTimestamp ? this.lastVideoTimestamp + 1 : timestampMs;
    this.lastVideoTimestamp = ts;
    const result = this.videoLandmarker.detectForVideo(source, ts);
    return toTrackedFace(result);
  }

  /** Runs single-image detection (used to analyse persona reference portraits). */
  async detectImage(image: HTMLImageElement | HTMLCanvasElement): Promise<{ faces: TrackedFace[] }> {
    if (!this.imageLandmarker) this.imageLandmarker = await this.createLandmarker('IMAGE');
    const result = this.imageLandmarker.detect(image);
    const faces: TrackedFace[] = [];
    for (let i = 0; i < result.faceLandmarks.length; i++) {
      const face = toTrackedFace(result, i);
      if (face) faces.push(face);
    }
    return { faces };
  }

  dispose() {
    this.videoLandmarker?.close();
    this.imageLandmarker?.close();
    this.videoLandmarker = null;
    this.imageLandmarker = null;
    this.ready = false;
  }
}

function toTrackedFace(result: FaceLandmarkerResult, index = 0): TrackedFace | null {
  const lms = result.faceLandmarks[index];
  if (!lms || lms.length === 0) return null;
  const flat = new Float32Array(lms.length * 2);
  for (let i = 0; i < lms.length; i++) {
    flat[i * 2] = lms[i].x;
    flat[i * 2 + 1] = lms[i].y;
  }
  const blendshapes: Record<string, number> = {};
  const bs = result.faceBlendshapes?.[index];
  if (bs) for (const c of bs.categories) blendshapes[c.categoryName] = c.score;
  return { landmarks: flat, blendshapes };
}

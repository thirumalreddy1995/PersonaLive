/**
 * Main-thread proxy for the segmentation worker (R4 §1).
 *
 * Owns the worker, hands it 256 × 256 ImageBitmaps of the source (every `segmentEvery` frames,
 * at most one in flight) and persona photos (once per load), and packs the returned category
 * masks into PackedMasks with the EMA. The model is fetched once and cached like the face
 * landmarker's; the worker's own GPU readback never blocks the render loop.
 */
import { fetchModel } from './faceTracker.ts';
import { PackedMasks, SEG_SIZE, emptyMasks, packCategory } from './segmentation.ts';
import type { SegWorkerRequest, SegWorkerResponse } from './segmentWorker.ts';

const DEFAULT_SEGMENTER_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const WASM_BASE_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;

export class FaceSegmenter {
  private worker: Worker | null = null;
  private nextId = 1;
  private inflight = false;
  private imageWaiters = new Map<number, (m: PackedMasks | null) => void>();
  private disposed = false;
  public backend: 'GPU' | 'CPU' = 'GPU';
  public ready = false;
  public error: string | null = null;
  /** Wall time of the last video segmentation in the worker (ms), and the main-thread pack time. */
  public lastMs = 0;
  public lastPackMs = 0;
  /** Frames handed to the worker that came back. */
  public updates = 0;
  /** Timing diagnostics (ms): bitmap creation on the main thread, worker inference and readback, submit→mask round trip (EMA). */
  public bitmapMs = 0;
  public inferMs = 0;
  public readMs = 0;
  public roundTripMs = 0;
  public submits = 0;
  private submittedAt = 0;

  constructor(private modelUrl: string = (import.meta.env?.VITE_SEGMENTER_MODEL_URL as string | undefined) || DEFAULT_SEGMENTER_URL) {}

  /** Starts the worker; `onMasks` is called on the main thread after every video mask arrives. */
  async load(delegate: 'GPU' | 'CPU', target: PackedMasks, onMasks: () => void): Promise<void> {
    if (this.ready || this.worker) return;
    this.disposed = false;
    try {
      const model = await fetchModel(this.modelUrl, () => undefined);
      if (this.disposed) return;
      // Classic worker: MediaPipe's WASM loader uses importScripts, which module workers lack.
      const worker = new Worker(new URL('./segmentWorker.ts', import.meta.url), { type: 'classic' });
      this.worker = worker;
      worker.onmessage = (ev: MessageEvent<SegWorkerResponse>) => {
        const m = ev.data;
        if (m.type === 'ready') {
          this.backend = m.backend;
          this.ready = true;
        } else if (m.type === 'error') {
          this.error = m.message;
          this.inflight = false;
          console.warn('Segmenter worker error:', m.message);
        } else if (m.type === 'mask') {
          if (m.kind === 'video') {
            this.inflight = false;
            const t0 = performance.now();
            packCategory(target, m.category);
            this.lastPackMs = performance.now() - t0;
            this.lastMs = m.ms;
            this.inferMs = m.inferMs;
            this.readMs = m.readMs;
            const rt = performance.now() - this.submittedAt;
            this.roundTripMs = this.updates === 0 ? rt : this.roundTripMs + (rt - this.roundTripMs) * 0.2;
            this.updates++;
            onMasks();
          } else {
            const waiter = this.imageWaiters.get(m.id);
            this.imageWaiters.delete(m.id);
            const out = emptyMasks(m.width, m.height);
            packCategory(out, m.category);
            waiter?.(out);
          }
        }
      };
      worker.onerror = (e) => {
        this.error = e.message;
        console.warn('Segmenter worker failed:', e.message);
      };
      const wasmBase = new URL(WASM_BASE_PATH, location.href).toString();
      const buffer = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength) as ArrayBuffer;
      const init: SegWorkerRequest = { type: 'init', wasmBase, model: buffer, delegate };
      worker.postMessage(init, [buffer]);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.warn('Segmenter unavailable; the geometric hairline fallback stays on.', err);
    }
  }

  /** True when a frame can be submitted (ready and nothing in flight). */
  get idle(): boolean {
    return this.ready && !this.inflight && !!this.worker;
  }

  /** Submits a live frame (downscaled to SEG_SIZE²). Returns false when skipped. */
  submitVideo(source: HTMLVideoElement | HTMLCanvasElement, timestampMs: number): boolean {
    if (!this.idle) return false;
    this.inflight = true;
    this.submits++;
    const id = this.nextId++;
    this.submittedAt = performance.now();
    createImageBitmap(source, { resizeWidth: SEG_SIZE, resizeHeight: SEG_SIZE, resizeQuality: 'low' })
      .then((bitmap) => {
        this.bitmapMs = performance.now() - this.submittedAt;
        if (this.disposed || !this.worker) {
          bitmap.close();
          this.inflight = false;
          return;
        }
        const msg: SegWorkerRequest = { type: 'video', id, bitmap, timestamp: timestampMs };
        this.worker.postMessage(msg, [bitmap]);
      })
      .catch((err) => {
        this.inflight = false;
        console.warn('Segmenter frame could not be prepared:', err);
      });
    return true;
  }

  /** Segments a still (persona photo) into fresh masks at SEG_SIZE; null when unavailable. */
  async segmentImage(image: HTMLImageElement | HTMLCanvasElement): Promise<PackedMasks | null> {
    if (!this.ready || !this.worker) return null;
    const bitmap = await createImageBitmap(image, { resizeWidth: SEG_SIZE, resizeHeight: SEG_SIZE, resizeQuality: 'high' });
    if (this.disposed || !this.worker) {
      bitmap.close();
      return null;
    }
    const id = this.nextId++;
    return new Promise<PackedMasks | null>((resolve) => {
      this.imageWaiters.set(id, resolve);
      const msg: SegWorkerRequest = { type: 'image', id, bitmap, timestamp: 0 };
      this.worker!.postMessage(msg, [bitmap]);
      setTimeout(() => {
        if (this.imageWaiters.delete(id)) resolve(null);
      }, 15000);
    });
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.inflight = false;
    for (const w of this.imageWaiters.values()) w(null);
    this.imageWaiters.clear();
  }
}

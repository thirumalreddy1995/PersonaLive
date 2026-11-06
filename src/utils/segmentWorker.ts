/**
 * Web Worker for the MediaPipe multiclass selfie segmenter (R4 §1).
 *
 * The segmenter's GPU→CPU mask readback costs ~35 ms per frame on a laptop; in a worker it no
 * longer blocks the render loop. The main thread sends 256 × 256 ImageBitmaps (video frames every
 * `segmentEvery` frames, persona photos once) and receives the category mask as a Uint8Array
 * (one byte per pixel, SEG_CATEGORY values). Everything stays on the device.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

export interface SegWorkerInit {
  type: 'init';
  wasmBase: string;
  model: ArrayBuffer;
  delegate: 'GPU' | 'CPU';
}
export interface SegWorkerFrame {
  type: 'video' | 'image';
  id: number;
  bitmap: ImageBitmap;
  timestamp: number;
}
export type SegWorkerRequest = SegWorkerInit | SegWorkerFrame;
export interface SegWorkerReady {
  type: 'ready';
  backend: 'GPU' | 'CPU';
}
export interface SegWorkerError {
  type: 'error';
  message: string;
}
export interface SegWorkerMask {
  type: 'mask';
  id: number;
  kind: 'video' | 'image';
  width: number;
  height: number;
  category: Uint8Array;
  /** Wall time of the segmentation including the readback. */
  ms: number;
  /** Inference call and mask readback separately (ms). */
  inferMs: number;
  readMs: number;
}
export type SegWorkerResponse = SegWorkerReady | SegWorkerError | SegWorkerMask;

let video: ImageSegmenter | null = null;
let image: ImageSegmenter | null = null;
let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let model: ArrayBuffer | null = null;
let backend: 'GPU' | 'CPU' = 'GPU';
let lastTs = -1;

const post = (m: SegWorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

async function create(runningMode: 'VIDEO' | 'IMAGE'): Promise<ImageSegmenter> {
  if (!fileset || !model) throw new Error('segment worker not initialised');
  const make = (delegate: 'GPU' | 'CPU') =>
    ImageSegmenter.createFromOptions(fileset!, {
      baseOptions: { modelAssetBuffer: new Uint8Array(model!), delegate },
      runningMode,
      outputConfidenceMasks: false,
      outputCategoryMask: true,
    });
  try {
    return await make(backend);
  } catch (err) {
    if (backend === 'GPU') {
      backend = 'CPU';
      return make('CPU');
    }
    throw err;
  }
}

self.onmessage = async (ev: MessageEvent<SegWorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      fileset = await FilesetResolver.forVisionTasks(msg.wasmBase);
      model = msg.model;
      backend = msg.delegate;
      video = await create('VIDEO');
      post({ type: 'ready', backend });
      return;
    }
    const t0 = performance.now();
    let result;
    if (msg.type === 'video') {
      if (!video) throw new Error('segmenter not ready');
      const ts = msg.timestamp <= lastTs ? lastTs + 1 : msg.timestamp;
      lastTs = ts;
      result = video.segmentForVideo(msg.bitmap, ts);
    } else {
      if (!image) image = await create('IMAGE');
      result = image.segment(msg.bitmap);
    }
    const t1 = performance.now();
    try {
      const cat = result.categoryMask;
      if (!cat) throw new Error('no category mask');
      const bytes = cat.getAsUint8Array().slice();
      const t2 = performance.now();
      post({ type: 'mask', id: msg.id, kind: msg.type, width: cat.width, height: cat.height, category: bytes, ms: t2 - t0, inferMs: t1 - t0, readMs: t2 - t1 }, [bytes.buffer]);
    } finally {
      result.close();
      msg.bitmap.close();
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

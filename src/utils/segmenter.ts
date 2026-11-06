/**
 * MediaPipe multiclass selfie segmenter wrapper (R4 §1).
 *
 * Owns a VIDEO-mode segmenter for the live frame (run every `segmentEvery` frames on a 256 × 256
 * copy of the source) and a lazily created IMAGE-mode one for persona photos. Results are packed
 * into PackedMasks (see segmentation.ts). The model is fetched once and cached like the face
 * landmarker's. Everything stays on the device.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { fetchModel } from './faceTracker.ts';
import { PackedMasks, SEG_CATEGORY, SEG_SIZE, emptyMasks, packMasks } from './segmentation.ts';

const DEFAULT_SEGMENTER_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

export class FaceSegmenter {
  private video: ImageSegmenter | null = null;
  private image: ImageSegmenter | null = null;
  private imagePromise: Promise<ImageSegmenter> | null = null;
  private modelBuffer: Uint8Array | null = null;
  private fileset: Fileset | null = null;
  private lastTimestamp = -1;
  private disposed = false;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  public backend: 'GPU' | 'CPU' = 'GPU';
  public ready = false;
  public error: string | null = null;

  constructor(private modelUrl: string = (import.meta.env?.VITE_SEGMENTER_MODEL_URL as string | undefined) || DEFAULT_SEGMENTER_URL) {}

  async load(fileset: Fileset): Promise<void> {
    if (this.ready) return;
    this.disposed = false;
    this.fileset = fileset;
    try {
      this.modelBuffer = await fetchModel(this.modelUrl, () => undefined);
      this.video = await this.create('VIDEO');
      if (this.disposed) {
        this.video.close();
        this.video = null;
        return;
      }
      this.ready = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.warn('Segmenter unavailable; the geometric hairline fallback stays on.', err);
    }
  }

  private async create(runningMode: 'VIDEO' | 'IMAGE'): Promise<ImageSegmenter> {
    if (!this.fileset || !this.modelBuffer) throw new Error('Segmenter runtime not loaded');
    const make = (delegate: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(this.fileset!, {
        baseOptions: { modelAssetBuffer: this.modelBuffer!, delegate },
        runningMode,
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    try {
      return await make(this.backend);
    } catch (err) {
      if (this.backend === 'GPU') {
        console.warn('GPU delegate unavailable for the segmenter, falling back to CPU.', err);
        this.backend = 'CPU';
        return make('CPU');
      }
      throw err;
    }
  }

  private getImageSegmenter(): Promise<ImageSegmenter> {
    if (this.image) return Promise.resolve(this.image);
    if (!this.imagePromise) {
      this.imagePromise = this.create('IMAGE')
        .then((seg) => {
          if (this.disposed) {
            seg.close();
            throw new Error('Segmenter disposed');
          }
          this.image = seg;
          return seg;
        })
        .catch((err: unknown) => {
          this.imagePromise = null;
          throw err;
        });
    }
    return this.imagePromise;
  }

  /** The 256 × 256 working copy of a frame (aspect is not preserved; masks are addressed in normalised source coordinates). */
  private scratch(): CanvasRenderingContext2D {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = SEG_SIZE;
      this.canvas.height = SEG_SIZE;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: false })!;
    }
    return this.ctx!;
  }

  /** Segments a live frame into `target` (EMA against its previous content). False when unavailable. */
  segmentVideo(source: CanvasImageSource, timestampMs: number, target: PackedMasks): boolean {
    if (!this.video || !this.ready) return false;
    const ctx = this.scratch();
    ctx.drawImage(source, 0, 0, SEG_SIZE, SEG_SIZE);
    const ts = timestampMs <= this.lastTimestamp ? this.lastTimestamp + 1 : timestampMs;
    this.lastTimestamp = ts;
    const result = this.video.segmentForVideo(this.canvas!, ts);
    try {
      const masks = result.confidenceMasks;
      if (!masks || masks.length < 6) return false;
      packMasks(
        target,
        masks[SEG_CATEGORY.hair].getAsFloat32Array(),
        masks[SEG_CATEGORY.bodySkin].getAsFloat32Array(),
        masks[SEG_CATEGORY.faceSkin].getAsFloat32Array(),
        masks[SEG_CATEGORY.accessories].getAsFloat32Array()
      );
      return true;
    } finally {
      result.close();
    }
  }

  /** Segments a still (persona photo) into fresh masks at SEG_SIZE. */
  async segmentImage(image: HTMLImageElement | HTMLCanvasElement): Promise<PackedMasks | null> {
    if (!this.ready) return null;
    const seg = await this.getImageSegmenter();
    const ctx = this.scratch();
    ctx.drawImage(image, 0, 0, SEG_SIZE, SEG_SIZE);
    const result = seg.segment(this.canvas!);
    try {
      const masks = result.confidenceMasks;
      if (!masks || masks.length < 6) return null;
      const out = emptyMasks(SEG_SIZE, SEG_SIZE);
      packMasks(out, masks[SEG_CATEGORY.hair].getAsFloat32Array(), masks[SEG_CATEGORY.bodySkin].getAsFloat32Array(), masks[SEG_CATEGORY.faceSkin].getAsFloat32Array(), masks[SEG_CATEGORY.accessories].getAsFloat32Array());
      return out;
    } finally {
      result.close();
    }
  }

  dispose() {
    this.disposed = true;
    this.video?.close();
    this.image?.close();
    this.video = null;
    this.image = null;
    this.imagePromise = null;
    this.ready = false;
  }
}

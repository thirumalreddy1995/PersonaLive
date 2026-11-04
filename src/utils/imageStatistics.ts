/**
 * Pixel statistics used by the persona photo quality check.
 *
 * `computeImageStatistics` is pure (works on any RGBA byte array) so it can be unit-tested;
 * `measureImageStatistics` is the thin DOM wrapper that samples an `<img>` through a canvas.
 */

export interface ImageStatistics {
  /** Mean Rec. 709 luma, 0..255. */
  averageLuminance: number;
  /** Standard deviation of luma, 0..~128 (0 = flat image). */
  contrastStdDev: number;
  /** Focus estimate on a 0..100 scale (see {@link sharpnessScoreFromLaplacianVariance}). */
  estimatedSharpness: number;
  /** Raw variance of the 4-neighbour Laplacian of the luma; kept for calibration. */
  laplacianVariance: number;
}

/**
 * Laplacian variance of the down-sampled luma that maps to a sharpness score of 100.
 * Heuristic: on a 256 px edge, out-of-focus portraits sit below ~30 and crisp portraits above
 * ~300. The log curve keeps the 50/70 thresholds in `evaluateImageQuality` meaningful.
 */
export const SHARPNESS_REFERENCE_VARIANCE = 400;

/** Longest edge the image is scaled to before sampling; keeps the metric resolution-independent. */
export const MEASUREMENT_MAX_EDGE = 256;

/** Maps a Laplacian variance to the 0..100 sharpness scale on a logarithmic curve. */
export function sharpnessScoreFromLaplacianVariance(variance: number): number {
  if (!(variance > 0)) return 0;
  const score = (100 * Math.log1p(variance)) / Math.log1p(SHARPNESS_REFERENCE_VARIANCE);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Computes luminance, contrast and sharpness from RGBA pixel data (row-major, 4 bytes/pixel).
 * Alpha is ignored. Throws if the buffer does not hold `width * height` pixels.
 */
export function computeImageStatistics(data: ArrayLike<number>, width: number, height: number): ImageStatistics {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`Invalid image dimensions ${width}x${height}`);
  }
  const pixelCount = width * height;
  if (data.length < pixelCount * 4) {
    throw new RangeError(`Pixel buffer holds ${data.length} bytes, expected at least ${pixelCount * 4}`);
  }

  const luma = new Float32Array(pixelCount);
  let sum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const l = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    luma[i] = l;
    sum += l;
  }
  const averageLuminance = sum / pixelCount;

  let varianceSum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const d = luma[i] - averageLuminance;
    varianceSum += d * d;
  }
  const contrastStdDev = Math.sqrt(varianceSum / pixelCount);

  // Variance of the 4-neighbour Laplacian over interior pixels (Welford's online algorithm).
  let count = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      count++;
      const delta = lap - mean;
      mean += delta / count;
      m2 += delta * (lap - mean);
    }
  }
  const laplacianVariance = count > 1 ? m2 / count : 0;

  return {
    averageLuminance,
    contrastStdDev,
    estimatedSharpness: sharpnessScoreFromLaplacianVariance(laplacianVariance),
    laplacianVariance,
  };
}

/**
 * Samples a decoded image through an offscreen canvas and returns its statistics.
 * Throws a `SecurityError` DOMException for cross-origin images served without CORS headers.
 */
export function measureImageStatistics(image: HTMLImageElement, maxEdge: number = MEASUREMENT_MAX_EDGE): ImageStatistics {
  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  if (!srcW || !srcH) throw new RangeError('Image has no decoded dimensions');
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.drawImage(image, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return computeImageStatistics(data, width, height);
}

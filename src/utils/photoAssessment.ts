/**
 * Measured quality assessment of a persona photo, shared by the enrolment flow and the local
 * persona loader so no persona ever carries hand-typed resolution or sharpness numbers.
 */
import { evaluateImageQuality, QualityAssessmentResult } from './faceMath.ts';
import { measureImageStatistics } from './imageStatistics.ts';

export function loadImage(src: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The photo could not be decoded. Try a different JPG, PNG or WebP file.'));
    img.src = src;
  });
}

/**
 * Decodes the photo and scores it from measured luminance, contrast and sharpness. If the pixels
 * cannot be read (cross-origin image without CORS headers), the resolution-only score is returned
 * with an explicit warning rather than fabricated lighting/sharpness values.
 */
export async function assessPhoto(src: string, crossOrigin: boolean): Promise<QualityAssessmentResult> {
  const img = await loadImage(src, crossOrigin);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  try {
    const stats = measureImageStatistics(img);
    return evaluateImageQuality(width, height, stats.averageLuminance, stats.contrastStdDev, stats.estimatedSharpness);
  } catch (err) {
    console.warn('Photo statistics unavailable, scoring resolution only.', err);
    const result = evaluateImageQuality(width, height);
    result.warnings.push('Lighting and sharpness could not be measured for this image.');
    return result;
  }
}

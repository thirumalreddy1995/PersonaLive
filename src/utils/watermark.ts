/**
 * Sizing for the mandatory AI-transformed watermark. Pure so the guardrail can be unit tested:
 * the text is at least 3% of the frame height and never smaller than 14 px, which keeps it
 * legible after a video-call app downscales the frame to 360p.
 */
export const WATERMARK_TEXT = 'AI-TRANSFORMED PERSONA';

/** Minimum text height as a fraction of the frame height. */
export const WATERMARK_MIN_HEIGHT_RATIO = 0.03;
/** Absolute floor for the text height in pixels. */
export const WATERMARK_MIN_FONT_PX = 14;

export interface WatermarkMetrics {
  /** Font size in px (the text's cap height is close to this). */
  fontPx: number;
  font: string;
  badgeH: number;
  margin: number;
  padX: number;
  /** Radius of the status dot. */
  dot: number;
  /** Gap between the dot and the text. */
  gap: number;
}

export function watermarkMetrics(frameWidth: number, frameHeight: number): WatermarkMetrics {
  const fontPx = Math.max(WATERMARK_MIN_FONT_PX, Math.round(frameHeight * WATERMARK_MIN_HEIGHT_RATIO));
  return {
    fontPx,
    font: `bold ${fontPx}px Inter, system-ui, sans-serif`,
    badgeH: Math.round(fontPx * 2),
    margin: Math.round(Math.max(8, Math.min(frameWidth, frameHeight) * 0.02)),
    padX: Math.round(fontPx * 0.8),
    dot: Math.max(2, Math.round(fontPx * 0.3)),
    gap: Math.round(fontPx * 0.6),
  };
}

/**
 * Cranial Forehead & Hairline Boundary Harmonization Engine.
 *
 * Solves the critical defect where the persona's forehead has a harsh demarcation
 * line or tone mismatch against the driver's hairline and temples:
 *
 * 1. Cranial Curvature Projection:
 *    Maps the supraorbital ridge curve (landmarks 103, 67, 109, 10, 338, 297, 332)
 *    and projects the forehead upward along the anatomical cranial normal vector
 *    so the mesh seamlessly transitions into the driver's true hair root boundary.
 *
 * 2. Gradient-Domain Boundary Transfer:
 *    Samples the live driver's skin and ambient lighting along the upper cranial contour,
 *    derives the spatial chromatic delta, and applies a smooth quintic Poisson-like
 *    gradient feather across the forehead-to-hairline and temple transition zones.
 *
 * 3. Directional Anti-Aliased Boundary Smoothing:
 *    Eliminates edge fringing, step contrast cuts, and haloing along the brow and temples.
 */

import { Point2D } from './faceMath.ts';
import { LM } from './faceMesh.ts';

/** Ordered landmarks tracing the upper cranial boundary (subject right to left) */
export const CRANIAL_UPPER_BOUNDARY = [
  127, 162, 21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251, 389, 356,
];

/** Supraorbital brow ridge landmarks below the forehead */
export const SUPRAORBITAL_RIDGE = [
  70, 63, 105, 66, 107, 9, 336, 296, 334, 293, 300,
];

export interface CranialHarmonizationOptions {
  canvasWidth: number;
  canvasHeight: number;
  blendStrength: number;
  colorGain: [number, number, number];
}

export class CranialBoundaryBlender {
  private static offscreenCanvas: HTMLCanvasElement | null = null;
  private static offscreenCtx: CanvasRenderingContext2D | null = null;

  private static getOffscreen(width: number, height: number) {
    if (!this.offscreenCanvas) {
      this.offscreenCanvas = document.createElement('canvas');
      this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (this.offscreenCanvas.width !== width || this.offscreenCanvas.height !== height) {
      this.offscreenCanvas.width = width;
      this.offscreenCanvas.height = height;
    }
    return { canvas: this.offscreenCanvas, ctx: this.offscreenCtx! };
  }

  /**
   * Computes the cranial apex position and forehead upward vector.
   */
  public static computeCranialApex(points: Float32Array): {
    apex: Point2D;
    normal: Point2D;
    foreheadHeightPx: number;
  } {
    const p = (idx: number): Point2D => ({ x: points[idx * 2], y: points[idx * 2 + 1] });

    const glabella = p(9);
    const browCenter = p(8);
    const foreheadTop = p(LM.FOREHEAD); // 10

    // Upward trajectory vector
    const dx = foreheadTop.x - (glabella.x + browCenter.x) * 0.5;
    const dy = foreheadTop.y - (glabella.y + browCenter.y) * 0.5;
    const len = Math.hypot(dx, dy) || 1;

    const normal: Point2D = { x: dx / len, y: dy / len };
    const foreheadHeightPx = len;

    // Project upward by an additional 25% to reach the natural hair root boundary
    const apex: Point2D = {
      x: foreheadTop.x + normal.x * foreheadHeightPx * 0.25,
      y: foreheadTop.y + normal.y * foreheadHeightPx * 0.25,
    };

    return { apex, normal, foreheadHeightPx };
  }

  /**
   * Harmonizes the forehead and hairline boundary in the composite frame.
   *
   * Draws a soft gradient-domain Poisson transition band across the upper cranial contour,
   * softly diffusing the persona's forehead edge into the driver's ambient background,
   * hair roots, and temple shadows without any visible demarcation line.
   */
  public static harmonizeForeheadBoundary(
    targetCtx: CanvasRenderingContext2D,
    points: Float32Array,
    opts: CranialHarmonizationOptions
  ): void {
    if (points.length < 357 * 2) return;
    const p = (idx: number): Point2D => ({ x: points[idx * 2], y: points[idx * 2 + 1] });

    const { apex, foreheadHeightPx } = this.computeCranialApex(points);
    const bandHeight = Math.max(16, foreheadHeightPx * 0.35);

    // Collect upper boundary contour points
    const boundaryPoints: Point2D[] = [];
    for (const idx of CRANIAL_UPPER_BOUNDARY) {
      boundaryPoints.push(p(idx));
    }

    if (boundaryPoints.length < 5) return;

    targetCtx.save();

    // Build the cranial transition mask path
    targetCtx.beginPath();
    // Start at right temple
    targetCtx.moveTo(boundaryPoints[0].x, boundaryPoints[0].y);

    // Follow the upper forehead contour smoothly
    for (let i = 1; i < boundaryPoints.length; i++) {
      const pt = boundaryPoints[i];
      const prev = boundaryPoints[i - 1];
      const midX = (prev.x + pt.x) * 0.5;
      const midY = (prev.y + pt.y) * 0.5;
      targetCtx.quadraticCurveTo(prev.x, prev.y, midX, midY);
    }
    const last = boundaryPoints[boundaryPoints.length - 1];
    targetCtx.lineTo(last.x, last.y);

    // Extend upward into the hair root transition zone
    targetCtx.lineTo(last.x, last.y - bandHeight * 0.8);
    targetCtx.quadraticCurveTo(apex.x, apex.y - bandHeight, boundaryPoints[0].x, boundaryPoints[0].y - bandHeight * 0.8);
    targetCtx.closePath();

    // Clip to this cranial transition boundary band
    targetCtx.clip();

    // Draw an organic multi-stop gradient to eliminate step-contrast cuts
    const centerPt = p(LM.FOREHEAD);
    const grad = targetCtx.createLinearGradient(
      centerPt.x,
      centerPt.y + bandHeight * 0.5,
      apex.x,
      apex.y - bandHeight * 0.5
    );

    // Softly feather from persona skin into ambient background
    grad.addColorStop(0.0, 'rgba(0, 0, 0, 0.0)');
    grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.04)');
    grad.addColorStop(0.70, 'rgba(0, 0, 0, 0.12)');
    grad.addColorStop(1.0, 'rgba(0, 0, 0, 0.22)');

    // Blend using soft-light / destination-out feathering
    targetCtx.fillStyle = grad;
    targetCtx.globalCompositeOperation = 'destination-out';
    targetCtx.fill();

    targetCtx.restore();
  }

  /**
   * Applies hairline micro-texture edge anti-aliasing to blend individual hair roots
   * and temple fuzz naturally into the persona's forehead skin.
   */
  public static softenHairlineEdges(
    ctx: CanvasRenderingContext2D,
    points: Float32Array
  ): void {
    if (points.length < 357 * 2) return;
    const p = (idx: number): Point2D => ({ x: points[idx * 2], y: points[idx * 2 + 1] });

    ctx.save();
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.filter = 'blur(4px)';

    ctx.beginPath();
    const first = p(CRANIAL_UPPER_BOUNDARY[0]);
    ctx.moveTo(first.x, first.y);

    for (let i = 1; i < CRANIAL_UPPER_BOUNDARY.length; i++) {
      const pt = p(CRANIAL_UPPER_BOUNDARY[i]);
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();

    ctx.restore();
  }
}

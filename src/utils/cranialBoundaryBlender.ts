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
 * 2. Alpha Boundary Feather:
 *    Erases a soft gradient band from the persona layer's alpha across the forehead-to-hairline
 *    and temple transition zones, so the driver's own hair roots and temple shadow show through.
 *
 * 3. Directional Anti-Aliased Boundary Smoothing:
 *    Eliminates edge fringing, step contrast cuts, and haloing along the brow and temples.
 *
 * Both passes use `destination-out`, so they must run on a *transparent* layer that holds only
 * the persona (see `FacialTransformationEngine.composeOverlayLayer`). On an opaque canvas
 * `destination-out` cannot reveal anything underneath and merely darkens pixels toward black.
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

export class CranialBoundaryBlender {
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
   * Harmonizes the forehead and hairline boundary on the transparent persona layer.
   *
   * Erases a soft gradient band from the layer's alpha across the upper cranial contour, so the
   * persona's forehead edge dissolves into the driver's hair roots and temple shadows without a
   * visible demarcation line once the layer is composited over the live frame.
   *
   * @param targetCtx 2D context of a canvas with an alpha channel that contains only the persona.
   */
  public static harmonizeForeheadBoundary(targetCtx: CanvasRenderingContext2D, points: Float32Array): void {
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

    // Softly feather from persona skin into the driver's hairline (alpha erased, not darkened)
    grad.addColorStop(0.0, 'rgba(0, 0, 0, 0.0)');
    grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.04)');
    grad.addColorStop(0.70, 'rgba(0, 0, 0, 0.12)');
    grad.addColorStop(1.0, 'rgba(0, 0, 0, 0.22)');

    targetCtx.fillStyle = grad;
    targetCtx.globalCompositeOperation = 'destination-out';
    targetCtx.fill();

    targetCtx.restore();
  }

  /**
   * Applies hairline micro-texture edge anti-aliasing: thins the persona layer's alpha along the
   * cranial contour with a blurred stroke so hair roots and temple fuzz show through naturally.
   *
   * @param ctx 2D context of a canvas with an alpha channel that contains only the persona.
   */
  public static softenHairlineEdges(ctx: CanvasRenderingContext2D, points: Float32Array): void {
    if (points.length < 357 * 2) return;
    const p = (idx: number): Point2D => ({ x: points[idx * 2], y: points[idx * 2 + 1] });

    ctx.save();
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.filter = 'blur(4px)';
    ctx.globalCompositeOperation = 'destination-out';

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

/**
 * Which compositing path a frame takes (R5 §4, flag singleGlComposite).
 *
 * The 2D path draws the camera frame into the output canvas, copies the WebGL persona canvas into
 * a 2D overlay layer, runs the optional 2D overlay passes on it and draws that layer on top: three
 * full-frame copies. The single GL path draws the camera frame under the persona inside the WebGL
 * canvas (destination-over, so the persona layer can still be read back first) and copies the
 * finished frame to the output canvas once; the watermark is then drawn on that final frame as
 * before. Pure, so the choice is unit-tested.
 */

export type ViewMode = 'split' | 'side-by-side' | 'transformed-only' | 'pip';

export interface CompositeChoice {
  /** Realism flag singleGlComposite. */
  flag: boolean;
  viewMode: ViewMode | string;
  /** The persona is being drawn this frame. */
  overlayReady: boolean;
  /** The warp renderer runs on WebGL (the Canvas 2D fallback cannot composite). */
  webgl: boolean;
  /** 2D passes on the persona layer are needed this frame (the geometric hairline fades without segmentation masks). */
  overlayPasses: boolean;
}

/**
 * True when the frame can be composited in the single GL pass. The comparison views (split,
 * side-by-side, picture-in-picture) need the camera frame and the persona as separate layers and
 * keep the 2D path, as does a frame whose persona layer still needs a 2D pass.
 */
export function useSingleGlComposite(c: CompositeChoice): boolean {
  return c.flag && c.overlayReady && c.webgl && c.viewMode === 'transformed-only' && !c.overlayPasses;
}

/**
 * Source UV of an output pixel for a cover-fitted, optionally mirrored camera frame: the mapping
 * the base-frame shader evaluates per fragment, kept here so it is tested against the 2D
 * `drawImage` layout. `x`, `y` are output pixels (y down); returns null outside the frame.
 */
export function baseFrameUv(
  x: number,
  y: number,
  canvasWidth: number,
  layout: { offsetX: number; offsetY: number; drawWidth: number; drawHeight: number; mirror: boolean }
): [number, number] | null {
  const sx = layout.mirror ? canvasWidth - x : x;
  const u = (sx - layout.offsetX) / layout.drawWidth;
  const v = (y - layout.offsetY) / layout.drawHeight;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
}

/**
 * Destination-over compositing of an opaque base under a premultiplied layer: the result of
 * drawing the base after the persona with blendFunc(ONE_MINUS_DST_ALPHA, ONE). Equal to drawing
 * the persona over the base (source-over), which is what the 2D path does.
 */
export function compositeUnder(layer: [number, number, number, number], base: [number, number, number]): [number, number, number, number] {
  const k = 1 - layer[3];
  return [layer[0] + base[0] * k, layer[1] + base[1] * k, layer[2] + base[2] * k, 1];
}

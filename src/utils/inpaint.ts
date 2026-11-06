/**
 * Persona photo inpainting (R4, flag personaInpaint): fills masked pixels (glasses frames, hair
 * strands over the face skin) from the surrounding skin so they never enter the persona texture.
 *
 * Pull-push: a pyramid of weighted averages is built from the valid pixels (pull), then each
 * level fills its invalid pixels from the coarser one (push); a few Jacobi smoothing passes
 * over the masked region remove the block structure. Pure and unit-testable.
 */

export interface InpaintResult {
  /** Pixels that were filled. */
  filled: number;
  /** Pyramid levels used. */
  levels: number;
}

/** `mask[i] = 1` marks a pixel to be replaced. Operates on RGBA in place; alpha is left alone. */
export function inpaintMasked(data: Uint8ClampedArray | Uint8Array, width: number, height: number, mask: Uint8Array, smoothingPasses = 6): InpaintResult {
  let filled = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) filled++;
  if (!filled) return { filled: 0, levels: 0 };

  // Level 0: premultiplied-by-validity colour sums.
  type Level = { w: number; h: number; rgb: Float32Array; wt: Float32Array };
  const base: Level = { w: width, h: height, rgb: new Float32Array(width * height * 3), wt: new Float32Array(width * height) };
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) continue;
    base.rgb[i * 3] = data[i * 4];
    base.rgb[i * 3 + 1] = data[i * 4 + 1];
    base.rgb[i * 3 + 2] = data[i * 4 + 2];
    base.wt[i] = 1;
  }
  // Pull: 2× downsample of weighted sums until everything is covered or the level is tiny.
  const levels: Level[] = [base];
  for (;;) {
    const prev = levels[levels.length - 1];
    if (prev.w <= 2 || prev.h <= 2) break;
    const w = Math.ceil(prev.w / 2), h = Math.ceil(prev.h / 2);
    const lvl: Level = { w, h, rgb: new Float32Array(w * h * 3), wt: new Float32Array(w * h) };
    for (let y = 0; y < prev.h; y++) {
      for (let x = 0; x < prev.w; x++) {
        const s = y * prev.w + x, d = (y >> 1) * w + (x >> 1);
        lvl.rgb[d * 3] += prev.rgb[s * 3];
        lvl.rgb[d * 3 + 1] += prev.rgb[s * 3 + 1];
        lvl.rgb[d * 3 + 2] += prev.rgb[s * 3 + 2];
        lvl.wt[d] += prev.wt[s];
      }
    }
    levels.push(lvl);
    let allCovered = true;
    for (let i = 0; i < w * h; i++) if (lvl.wt[i] === 0) { allCovered = false; break; }
    if (allCovered) break;
  }
  // Push: fill empty cells of each level from the coarser level (nearest cell; coarse averages are already smooth).
  for (let li = levels.length - 2; li >= 0; li--) {
    const fine = levels[li], coarse = levels[li + 1];
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x;
        if (fine.wt[i] > 0) continue;
        const c = (y >> 1) * coarse.w + (x >> 1);
        const cw = coarse.wt[c];
        if (cw <= 0) continue;
        fine.rgb[i * 3] = coarse.rgb[c * 3] / cw;
        fine.rgb[i * 3 + 1] = coarse.rgb[c * 3 + 1] / cw;
        fine.rgb[i * 3 + 2] = coarse.rgb[c * 3 + 2] / cw;
        fine.wt[i] = 1;
      }
    }
  }
  // Write the filled pixels back, then smooth them a few times from their neighbours.
  for (let i = 0; i < width * height; i++) {
    if (!mask[i] || base.wt[i] <= 0) continue;
    data[i * 4] = base.rgb[i * 3] / base.wt[i];
    data[i * 4 + 1] = base.rgb[i * 3 + 1] / base.wt[i];
    data[i * 4 + 2] = base.rgb[i * 3 + 2] / base.wt[i];
  }
  const tmp = new Float32Array(width * height * 3);
  for (let pass = 0; pass < smoothingPasses; pass++) {
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        for (let ch = 0; ch < 3; ch++) {
          tmp[i * 3 + ch] = (data[(i - 1) * 4 + ch] + data[(i + 1) * 4 + ch] + data[(i - width) * 4 + ch] + data[(i + width) * 4 + ch]) * 0.25;
        }
      }
    }
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        data[i * 4] = tmp[i * 3];
        data[i * 4 + 1] = tmp[i * 3 + 1];
        data[i * 4 + 2] = tmp[i * 3 + 2];
      }
    }
  }
  return { filled, levels: levels.length };
}

/** Grows a binary mask by `radius` pixels (square dilation), so thin frames take their blurred edge along. */
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dx = -radius; dx <= radius && !v; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < width && mask[y * width + xx]) v = 1;
      }
      tmp[y * width + x] = v;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dy = -radius; dy <= radius && !v; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < height && tmp[yy * width + x]) v = 1;
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

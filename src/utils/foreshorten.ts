/**
 * Foreshortened-triangle fade (R4 §4, flag foreshortenFade).
 *
 * During head turns the far-side triangles compress to slivers or flip back-facing; the persona
 * texture stretched across them reads as a smear. Per frame every triangle's screen area is
 * compared with its rest area (persona UV area scaled by the mesh's overall screen/UV ratio) and
 * the persona alpha fades out smoothly on strongly compressed or back-facing triangles. The
 * per-vertex weight is the minimum over the vertex's triangles. Pure and unit-testable.
 */

/** Fade starts when a triangle is compressed below this share of its rest area and is complete below FADE_END. */
export const FORESHORTEN_FADE_START = 0.4;
export const FORESHORTEN_FADE_END = 0.12;

function signedArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ax = p[a * 2], ay = p[a * 2 + 1];
  return ((p[b * 2] - ax) * (p[c * 2 + 1] - ay) - (p[c * 2] - ax) * (p[b * 2 + 1] - ay)) / 2;
}

/**
 * Per-vertex weights in [0, 1]: 1 where the mesh is flat to the camera, 0 on back-facing or
 * strongly compressed triangles. `screen` are the warp positions (pixels), `uv` the persona
 * landmarks (normalised), `tris` the topology's triangle index list; `out` is reused when given.
 */
export function foreshortenWeights(screen: ArrayLike<number>, uv: ArrayLike<number>, tris: ArrayLike<number>, vertexCount: number, out?: Float32Array): Float32Array {
  const w = out && out.length === vertexCount ? out : new Float32Array(vertexCount);
  w.fill(1);
  // Global screen/UV area ratio (sign tells which winding the front-facing mesh has).
  let sumS = 0, sumU = 0;
  for (let i = 0; i < tris.length; i += 3) {
    sumS += signedArea(screen, tris[i], tris[i + 1], tris[i + 2]);
    sumU += signedArea(uv, tris[i], tris[i + 1], tris[i + 2]);
  }
  if (sumU === 0 || sumS === 0) return w;
  const scale = sumS / sumU;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    const rest = signedArea(uv, a, b, c) * scale;
    if (rest === 0) continue;
    const ratio = signedArea(screen, a, b, c) / rest;
    const t = (ratio - FORESHORTEN_FADE_END) / (FORESHORTEN_FADE_START - FORESHORTEN_FADE_END);
    const f = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    if (f < w[a]) w[a] = f;
    if (f < w[b]) w[b] = f;
    if (f < w[c]) w[c] = f;
  }
  return w;
}

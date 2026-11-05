/**
 * GPU piecewise-affine mesh warp.
 *
 * The persona portrait is uploaded once as a texture. Every frame the wearer's 468 tracked
 * landmark positions become vertex positions while the persona's landmark positions (captured
 * at enrollment) are the texture coordinates. Drawing the MediaPipe tessellation as a triangle
 * list warps the persona's skin onto the wearer's face geometry, so the persona follows head
 * pose, jaw movement, brow raises and lip shapes in real time.
 *
 * Eye and inner-mouth regions are holes in the mesh, so the wearer's real eyes (blinks, gaze)
 * and mouth interior (teeth, tongue) show through naturally. Persona eyes can optionally be
 * painted back in with triangle fans.
 *
 * WebGL2 (GLSL ES 3.00, highp, mipmapped and anisotropic persona texture, asynchronous pixel
 * readback for the camera-match loop) is preferred when the `webgl2` realism flag is on; WebGL1
 * is the fallback, then a Canvas 2D per-triangle affine warp. The renderer survives WebGL
 * context loss (GPU reset, tab backgrounding) by rebuilding its GPU resources on restore.
 */
import { closedLipMaskForZone, type FaceTopology } from './faceMesh.ts';

export interface FacialLightingZones {
  forehead: [number, number, number];
  leftCheek: [number, number, number];
  rightCheek: [number, number, number];
  nose: [number, number, number];
  chin: [number, number, number];
}

export interface CameraMatchOptions {
  /** Mip level-of-detail bias (≥ 0 blurs the persona by sampling coarser mip levels). */
  lodBias: number;
  /** Unsharp-mask amount (≥ 0 sharpens the persona with a texel-sized kernel). */
  sharpen: number;
  /** Per-frame luminance noise sigma in 0..1 units (0 = none). */
  noiseSigma: number;
  /** Frame counter that changes the noise pattern every frame. */
  frame: number;
}

export interface WarpFrameOptions {
  /** Flat [x, y, ...] pixel positions for 468+ vertices in output canvas space. */
  positions: Float32Array;
  /** Overall opacity 0..1 (transformation strength). */
  opacity: number;
  /** Global per-channel RGB multiplier for lighting adaptation. */
  colorGain: [number, number, number];
  /** Multi-zone directional lighting adaptation across 5 facial regions. */
  zoneLighting?: FacialLightingZones;
  /** Bounding box of the face [minX, minY, width, height] for spatial lighting interpolation. */
  faceBounds?: [number, number, number, number];
  /** Paint persona eyes over the wearer's eyes (otherwise the wearer's real eyes show). */
  drawPersonaEyes: boolean;
  /** 0..1: how much of the lip band to fade out this frame (see lipFadeForMar). */
  lipFade?: number;
  /** 0..1: scale of the eye pass-through ring set with setEyeFade (0 disables it, e.g. while blinking). */
  eyeFade?: number;
  /** 0..1: closed-lip mask strength (persona removed just outside the wearer's lip contour while the mouth is closed). */
  closedLipMask?: number;
  /** Shader "beautification" stages; all on reproduces the pre-R1 look. */
  shader?: { unsharp: boolean; subsurface: boolean; sebum: boolean };
  /** Camera-matched sharpness and noise (R2 §4); omitted = off. */
  cameraMatch?: CameraMatchOptions;
}

/** Face-region pixel statistics from an asynchronous readback. */
export interface FaceStats {
  /** Variance of the 4-neighbour Laplacian of luma (0..255 scale) over the sampled region. */
  laplacianVariance: number;
  /** Median absolute deviation of a 3×3 high-pass of luma: sensor-noise sigma estimate. */
  noiseMad: number;
  /** Pixels that went into the estimate. */
  samples: number;
}

type PersonaSource = HTMLImageElement | HTMLCanvasElement;

const VERTEX_SHADER_ES1 = `
attribute vec2 aPosition;
attribute vec2 aUv;
attribute float aFeather;
attribute float aLip;
attribute float aLipZone;
attribute float aEyeFade;

uniform vec2 uResolution;
uniform vec4 uFaceBounds;
uniform vec3 uGainForehead;
uniform vec3 uGainLeftCheek;
uniform vec3 uGainRightCheek;
uniform vec3 uGainNose;
uniform vec3 uGainChin;

varying vec2 vUv;
varying float vFeather;
varying vec3 vLighting;
varying vec2 vNormPos;
varying float vLip;
varying float vLipZone;
varying float vEyeFade;

void main() {
  vec2 clip = vec2(aPosition.x / uResolution.x * 2.0 - 1.0, 1.0 - aPosition.y / uResolution.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aUv;
  vFeather = aFeather;
  vLip = aLip;
  vLipZone = aLipZone;
  vEyeFade = aEyeFade;

  // Normalized position relative to face bounding box [0, 1]
  vec2 nPos = clamp((aPosition - uFaceBounds.xy) / max(uFaceBounds.zw, vec2(1.0)), 0.0, 1.0);
  vNormPos = nPos;

  // Smooth spatial basis functions across forehead, cheeks, nose, and chin/jaw
  float wForehead = clamp((0.45 - nPos.y) / 0.45, 0.0, 1.0);
  float wChin = clamp((nPos.y - 0.65) / 0.35, 0.0, 1.0);
  float midY = clamp(1.0 - abs(nPos.y - 0.5) / 0.35, 0.0, 1.0);
  float wLeftCheek = midY * clamp((0.45 - nPos.x) / 0.45, 0.0, 1.0);
  float wRightCheek = midY * clamp((nPos.x - 0.55) / 0.45, 0.0, 1.0);
  float wNose = clamp(1.0 - length((nPos - vec2(0.5, 0.5)) * vec2(2.5, 2.5)), 0.0, 1.0);

  float totalW = wForehead + wChin + wLeftCheek + wRightCheek + wNose + 0.001;
  vLighting = (wForehead * uGainForehead +
               wLeftCheek * uGainLeftCheek +
               wRightCheek * uGainRightCheek +
               wNose * uGainNose +
               wChin * uGainChin) / totalW;
}`;

const FRAGMENT_SHADER_ES1 = `
precision highp float;
uniform sampler2D uTexture;
uniform float uOpacity;
uniform float uUnsharp;
uniform float uSubsurface;
uniform float uSebum;
uniform float uLipFade;
uniform float uEyeFade;
uniform float uClosedLipMask;
uniform vec2 uTexelSize;
uniform float uLodBias;
uniform float uSharpen;
uniform float uNoiseSigma;
uniform float uFrame;

varying vec2 vUv;
varying float vFeather;
varying vec3 vLighting;
varying vec2 vNormPos;
varying float vLip;
varying float vLipZone;
varying float vEyeFade;

// Per-pixel, per-frame hash in [0, 1).
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  // Camera match: a mip LOD bias blurs the persona toward the camera's softness (R2 §4).
  vec4 c = texture2D(uTexture, vUv, uLodBias);
  if (c.a < 0.02) discard;

  // 1. Unsharp mask with a texel-sized kernel: the fixed-offset R0 version (flag shaderUnsharp)
  //    and the camera-match sharpen amount share it.
  vec2 d = uTexelSize;
  vec4 t0 = texture2D(uTexture, vUv + vec2(-d.x, 0.0), uLodBias);
  vec4 t1 = texture2D(uTexture, vUv + vec2( d.x, 0.0), uLodBias);
  vec4 t2 = texture2D(uTexture, vUv + vec2(0.0, -d.y), uLodBias);
  vec4 t3 = texture2D(uTexture, vUv + vec2(0.0,  d.y), uLodBias);
  vec3 blurred = (t0.rgb + t1.rgb + t2.rgb + t3.rgb) * 0.25;
  vec3 highPass = c.rgb - blurred;
  vec3 microSkin = c.rgb + highPass * (0.35 * uUnsharp + uSharpen);

  // 2. Multi-zone directional lighting adaptation
  vec3 lit = clamp(microSkin, 0.0, 1.0) * vLighting;

  // 3. Warm "subdermal" tint on mid-tones (realism flag shaderSubsurface)
  float lum = dot(lit, vec3(0.299, 0.587, 0.114));
  vec3 subdermal = lit * vec3(1.10, 0.94, 0.86);
  float sssWeight = clamp((0.42 - abs(lum - 0.44)) * 0.55, 0.0, 0.28) * uSubsurface;
  vec3 sssSkin = mix(lit, subdermal, sssWeight);

  // 4. Synthetic sebum sheen where the lighting gain is high (realism flag shaderSebum)
  float specLum = max(0.0, dot(vLighting, vec3(0.333)) - 0.88);
  vec3 specSheen = vec3(0.09, 0.11, 0.13) * specLum * pow(lum, 1.8) * uSebum;
  vec3 naturalSkin = clamp(sssSkin + specSheen, 0.0, 1.0);

  // 5. Camera-matched sensor noise: temporally varying luminance noise with a small chroma part.
  if (uNoiseSigma > 0.0) {
    vec2 seed = gl_FragCoord.xy + vec2(uFrame * 7.31, uFrame * 3.17);
    float n = hash12(seed) - 0.5;
    float nc = hash12(seed + vec2(19.7, 41.3)) - 0.5;
    naturalSkin = clamp(naturalSkin + n * uNoiseSigma * 2.0 + vec3(nc, -nc * 0.5, nc * 0.25) * uNoiseSigma * 0.6, 0.0, 1.0);
  }

  // 6. Quintic smootherstep feathering curve for outer facial boundary
  float t = clamp(vFeather, 0.0, 1.0);
  float f = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);

  // 7. Cranial hairline feathering: smoothly dissolves the upper forehead boundary
  // into the driver's hairline and temple shadow, eliminating horizontal seam cuts
  float cranialFalloff = smoothstep(0.0, 0.15, vNormPos.y);

  // 8. Keep my real mouth / eye pass-through / closed-lip mask.
  float closedMask = smoothstep(1.0, 1.3, vLipZone) * (1.0 - smoothstep(2.0, 3.0, vLipZone)) * uClosedLipMask * (1.0 - uLipFade);
  float lipHole = max(clamp(vLip * uLipFade, 0.0, 1.0), closedMask);
  float holes = (1.0 - lipHole) * (1.0 - clamp(vEyeFade * uEyeFade, 0.0, 1.0));

  float a = uOpacity * f * cranialFalloff * c.a * holes;

  gl_FragColor = vec4(naturalSkin * a, a);
}`;

/** Simple textured quad, used to downsample a source into a small framebuffer for readback. */
const COPY_VERTEX_ES1 = `
attribute vec2 aPosition;
varying vec2 vUv;
uniform vec4 uSrcRect;
void main() {
  vUv = uSrcRect.xy + (aPosition * 0.5 + 0.5) * uSrcRect.zw;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
const COPY_FRAGMENT_ES1 = `
precision highp float;
uniform sampler2D uTexture;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTexture, vUv); }`;

/** Converts GLSL ES 1.00 shader source to GLSL ES 3.00 for WebGL2. */
export function toGlslEs3(source: string, stage: 'vertex' | 'fragment'): string {
  let s = source.replace(/\btexture2D\(/g, 'texture(').replace(/\battribute\b/g, 'in');
  s = s.replace(/\bvarying\b/g, stage === 'vertex' ? 'out' : 'in');
  if (stage === 'fragment') s = s.replace(/\bgl_FragColor\b/g, 'fragColor').replace(/precision highp float;/, 'precision highp float;\nout vec4 fragColor;');
  return `#version 300 es\n${s}`;
}

interface GLResources {
  program: WebGLProgram;
  positionBuffer: WebGLBuffer;
  uvBuffer: WebGLBuffer;
  featherBuffer: WebGLBuffer;
  lipBuffer: WebGLBuffer;
  lipZoneBuffer: WebGLBuffer;
  eyeFadeBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  eyeIndexBuffer: WebGLBuffer;
  texture: WebGLTexture;
  locations: {
    aPosition: number;
    aUv: number;
    aFeather: number;
    aLip: number;
    aLipZone: number;
    aEyeFade: number;
    uResolution: WebGLUniformLocation | null;
    uTexture: WebGLUniformLocation | null;
    uFaceBounds: WebGLUniformLocation | null;
    uGainForehead: WebGLUniformLocation | null;
    uGainLeftCheek: WebGLUniformLocation | null;
    uGainRightCheek: WebGLUniformLocation | null;
    uGainNose: WebGLUniformLocation | null;
    uGainChin: WebGLUniformLocation | null;
    uOpacity: WebGLUniformLocation | null;
    uUnsharp: WebGLUniformLocation | null;
    uSubsurface: WebGLUniformLocation | null;
    uSebum: WebGLUniformLocation | null;
    uLipFade: WebGLUniformLocation | null;
    uEyeFade: WebGLUniformLocation | null;
    uClosedLipMask: WebGLUniformLocation | null;
    uTexelSize: WebGLUniformLocation | null;
    uLodBias: WebGLUniformLocation | null;
    uSharpen: WebGLUniformLocation | null;
    uNoiseSigma: WebGLUniformLocation | null;
    uFrame: WebGLUniformLocation | null;
  };
  /** WebGL2 only: downsample + asynchronous readback resources. */
  readback: {
    program: WebGLProgram;
    aPosition: number;
    uTexture: WebGLUniformLocation | null;
    uSrcRect: WebGLUniformLocation | null;
    quad: WebGLBuffer;
    sourceTexture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    target: WebGLTexture;
  } | null;
}

/**
 * Side of the square readback framebuffer. The readbacks sample a window of this many display
 * pixels at 1:1 from the middle of the face box (upsampling only when the face is smaller), so the
 * Laplacian measures the same single-pixel band as the review metric. Downsampling the whole face
 * into it (R2 first cut, 96 px) measured a coarser band that camera blur hardly touches and left
 * the loop believing a 2x sharper persona was matched.
 */
export const READBACK_SIZE = 160;

/** Side, in pixels, of the readback window for a w×h face region: 1:1 up to READBACK_SIZE. */
export function readbackWindow(w: number, h: number): number {
  return Math.max(1, Math.min(READBACK_SIZE, w, h));
}

/** The sub-rectangle of `rect` (x, y, w, h) with the given size, centred, clipped to `rect`. */
export function centredRect(rect: [number, number, number, number], size: [number, number]): [number, number, number, number] {
  const w = Math.min(rect[2], size[0]);
  const h = Math.min(rect[3], size[1]);
  return [rect[0] + (rect[2] - w) / 2, rect[1] + (rect[3] - h) / 2, w, h];
}

interface PendingReadback {
  buffer: WebGLBuffer;
  sync: WebGLSync;
  resolve: (stats: FaceStats | null) => void;
}

function sourceSize(image: PersonaSource): { width: number; height: number } {
  return image instanceof HTMLImageElement
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Laplacian variance and high-pass MAD of an RGBA buffer (0..255 luma). Pixels below `minAlpha`
 * and their neighbours are skipped: the persona layer is premultiplied, so its feathered edges
 * (mask, eye and mouth holes) darken towards transparent and would read as strong edges that no
 * camera blur removes. Pure, shared by the GPU readback path and the tests.
 */
export function faceStatsFromPixels(data: ArrayLike<number>, width: number, height: number, minAlpha = 240): FaceStats {
  const luma = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (data[o + 3] < minAlpha) continue;
    valid[i] = 1;
    luma[i] = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  }
  let n = 0, mean = 0, m2 = 0;
  // Histogram of the high-pass magnitude (0.25 steps up to 64) so the median costs no sort.
  const bins = new Uint32Array(HP_BINS);
  let hpCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!valid[i] || !valid[i - 1] || !valid[i + 1] || !valid[i - width] || !valid[i + width]) continue;
      const lap = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      n++;
      const delta = lap - mean;
      mean += delta / n;
      m2 += delta * (lap - mean);
      // 3×3 mean high-pass for the noise estimate.
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += luma[i + dy * width + dx];
      bins[Math.min(HP_BINS - 1, Math.floor(Math.abs(luma[i] - s / 9) / HP_BIN_WIDTH))]++;
      hpCount++;
    }
  }
  let median = 0;
  for (let b = 0, seen = 0; b < HP_BINS; b++) {
    seen += bins[b];
    if (seen > hpCount >> 1) {
      // Bin centre; the first bin reports 0 so a noise-free image measures as such.
      median = b === 0 ? 0 : (b + 0.5) * HP_BIN_WIDTH;
      break;
    }
  }
  return { laplacianVariance: n > 1 ? m2 / n : 0, noiseMad: hpCount ? median * 1.4826 : 0, samples: n };
}

const HP_BIN_WIDTH = 0.25;
const HP_BINS = 256;

export class MeshWarpRenderer {
  private _canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private gl2: WebGL2RenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private resources: GLResources | null = null;
  private contextLost = false;
  private anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;

  private topology: FaceTopology | null = null;
  private eyeFadeWeights: Float32Array | null = null;
  private personaImage: PersonaSource | null = null;
  private personaUv: Float32Array | null = null;
  private personaSize = { width: 1, height: 1 };
  private pending: PendingReadback[] = [];

  /**
   * @param preferWebGL2 try WebGL2 first (realism flag `webgl2`); WebGL1 otherwise, then Canvas 2D
   */
  constructor(width: number, height: number, preferWebGL2 = false) {
    this._canvas = document.createElement('canvas');
    this._canvas.width = width;
    this._canvas.height = height;

    const attrs = { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false };
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    if (preferWebGL2) gl = this._canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
    if (!gl) {
      gl =
        (this._canvas.getContext('webgl', attrs) as WebGLRenderingContext | null) ||
        (this._canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    }

    if (gl) {
      try {
        this.gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl : null;
        const ext = gl.getExtension('EXT_texture_filter_anisotropic');
        if (ext) this.anisotropy = { ext, max: Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) };
        this.resources = this.createResources(gl);
        this.gl = gl;
        this._canvas.addEventListener('webglcontextlost', this.handleContextLost);
        this._canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
        return;
      } catch (err) {
        // Shader/program creation failed (driver quirk, blocked GPU). A canvas that already has a
        // WebGL context cannot hand out a 2D one, so start over with a fresh canvas.
        console.warn('WebGL mesh warp unavailable, falling back to Canvas 2D warp.', err);
        this.gl2 = null;
        this.anisotropy = null;
        this._canvas = document.createElement('canvas');
        this._canvas.width = width;
        this._canvas.height = height;
      }
    }
    this.ctx2d = this._canvas.getContext('2d');
  }

  /** Transparent canvas holding the warped persona for the current frame. */
  get canvas(): HTMLCanvasElement {
    return this._canvas;
  }

  get usesWebGL(): boolean {
    return this.gl !== null;
  }

  get usesWebGL2(): boolean {
    return this.gl2 !== null;
  }

  /** Persona texture size in pixels (for texel-size-aware kernels and LOD maths). */
  get textureSize(): { width: number; height: number } {
    return this.personaSize;
  }

  resize(width: number, height: number) {
    if (this._canvas.width === width && this._canvas.height === height) return;
    this._canvas.width = width;
    this._canvas.height = height;
    this.gl?.viewport(0, 0, width, height);
  }

  // ---------------------------------------------------------------------------------------------
  // WebGL resource lifecycle
  // ---------------------------------------------------------------------------------------------

  private compileProgram(gl: WebGLRenderingContext, vertex: string, fragment: string): WebGLProgram {
    const es3 = this.gl2 !== null;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Could not create WebGL shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) || 'Shader compile failed';
        gl.deleteShader(shader);
        throw new Error(log);
      }
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error('Could not create WebGL program');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, es3 ? toGlslEs3(vertex, 'vertex') : vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, es3 ? toGlslEs3(fragment, 'fragment') : fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'Program link failed';
      gl.deleteProgram(program);
      throw new Error(log);
    }
    return program;
  }

  private createResources(gl: WebGLRenderingContext | WebGL2RenderingContext): GLResources {
    const program = this.compileProgram(gl, VERTEX_SHADER_ES1, FRAGMENT_SHADER_ES1);
    const buffer = (): WebGLBuffer => {
      const b = gl.createBuffer();
      if (!b) throw new Error('Could not create WebGL buffer');
      return b;
    };
    const texture = gl.createTexture();
    if (!texture) throw new Error('Could not create WebGL texture');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);

    const u = (name: string) => gl.getUniformLocation(program, name);
    let readback: GLResources['readback'] = null;
    if (this.gl2) {
      const gl2 = this.gl2;
      const copy = this.compileProgram(gl2, COPY_VERTEX_ES1, COPY_FRAGMENT_ES1);
      const quad = buffer();
      gl2.bindBuffer(gl2.ARRAY_BUFFER, quad);
      gl2.bufferData(gl2.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl2.STATIC_DRAW);
      const sourceTexture = gl2.createTexture()!;
      const target = gl2.createTexture()!;
      gl2.bindTexture(gl2.TEXTURE_2D, target);
      gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, READBACK_SIZE, READBACK_SIZE, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, null);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
      const framebuffer = gl2.createFramebuffer()!;
      gl2.bindFramebuffer(gl2.FRAMEBUFFER, framebuffer);
      gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, target, 0);
      gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
      readback = {
        program: copy,
        aPosition: gl2.getAttribLocation(copy, 'aPosition'),
        uTexture: gl2.getUniformLocation(copy, 'uTexture'),
        uSrcRect: gl2.getUniformLocation(copy, 'uSrcRect'),
        quad,
        sourceTexture,
        framebuffer,
        target,
      };
    }

    return {
      program,
      positionBuffer: buffer(),
      uvBuffer: buffer(),
      featherBuffer: buffer(),
      lipBuffer: buffer(),
      lipZoneBuffer: buffer(),
      eyeFadeBuffer: buffer(),
      indexBuffer: buffer(),
      eyeIndexBuffer: buffer(),
      texture,
      locations: {
        aPosition: gl.getAttribLocation(program, 'aPosition'),
        aUv: gl.getAttribLocation(program, 'aUv'),
        aFeather: gl.getAttribLocation(program, 'aFeather'),
        aLip: gl.getAttribLocation(program, 'aLip'),
        aLipZone: gl.getAttribLocation(program, 'aLipZone'),
        aEyeFade: gl.getAttribLocation(program, 'aEyeFade'),
        uResolution: u('uResolution'),
        uTexture: u('uTexture'),
        uFaceBounds: u('uFaceBounds'),
        uGainForehead: u('uGainForehead'),
        uGainLeftCheek: u('uGainLeftCheek'),
        uGainRightCheek: u('uGainRightCheek'),
        uGainNose: u('uGainNose'),
        uGainChin: u('uGainChin'),
        uOpacity: u('uOpacity'),
        uUnsharp: u('uUnsharp'),
        uSubsurface: u('uSubsurface'),
        uSebum: u('uSebum'),
        uLipFade: u('uLipFade'),
        uEyeFade: u('uEyeFade'),
        uClosedLipMask: u('uClosedLipMask'),
        uTexelSize: u('uTexelSize'),
        uLodBias: u('uLodBias'),
        uSharpen: u('uSharpen'),
        uNoiseSigma: u('uNoiseSigma'),
        uFrame: u('uFrame'),
      },
      readback,
    };
  }

  private deleteResources(gl: WebGLRenderingContext | WebGL2RenderingContext, r: GLResources) {
    gl.deleteBuffer(r.positionBuffer);
    gl.deleteBuffer(r.uvBuffer);
    gl.deleteBuffer(r.featherBuffer);
    gl.deleteBuffer(r.lipBuffer);
    gl.deleteBuffer(r.lipZoneBuffer);
    gl.deleteBuffer(r.eyeFadeBuffer);
    gl.deleteBuffer(r.indexBuffer);
    gl.deleteBuffer(r.eyeIndexBuffer);
    gl.deleteTexture(r.texture);
    gl.deleteProgram(r.program);
    if (r.readback) {
      gl.deleteProgram(r.readback.program);
      gl.deleteBuffer(r.readback.quad);
      gl.deleteTexture(r.readback.sourceTexture);
      gl.deleteTexture(r.readback.target);
      gl.deleteFramebuffer(r.readback.framebuffer);
    }
    for (const p of this.pending) {
      gl.deleteBuffer(p.buffer);
      p.resolve(null);
    }
    this.pending = [];
  }

  /** True when GPU resources are usable this frame. */
  private get glReady(): boolean {
    return this.gl !== null && this.resources !== null && !this.contextLost;
  }

  private handleContextLost = (event: Event) => {
    // preventDefault() tells the browser we intend to restore; without it no restore event fires.
    event.preventDefault();
    this.contextLost = true;
    this.resources = null;
    for (const p of this.pending) p.resolve(null);
    this.pending = [];
    console.warn('WebGL context lost; persona overlay paused until the context is restored.');
  };

  private handleContextRestored = () => {
    const gl = this.gl;
    if (!gl) return;
    try {
      this.resources = this.createResources(gl);
      this.contextLost = false;
      if (this.topology) this.uploadTopology(gl, this.resources, this.topology);
      if (this.eyeFadeWeights) this.uploadEyeFade(gl, this.resources, this.eyeFadeWeights);
      if (this.personaImage) this.uploadTexture(gl, this.resources, this.personaImage);
      if (this.personaUv) this.uploadUvs(gl, this.resources, this.personaUv, gl.STATIC_DRAW);
      console.info('WebGL context restored; persona overlay resumed.');
    } catch (err) {
      console.error('Could not rebuild WebGL resources after context restore.', err);
    }
  };

  private uploadTopology(gl: WebGLRenderingContext, r: GLResources, topology: FaceTopology) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, topology.triangles, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.eyeIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, topology.eyeTriangles, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.featherBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, topology.featherWeights, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.lipBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, topology.lipWeights, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.lipZoneBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, topology.lipZones, gl.STATIC_DRAW);
    if (!this.eyeFadeWeights || this.eyeFadeWeights.length !== topology.vertexCount) {
      this.eyeFadeWeights = new Float32Array(topology.vertexCount);
    }
    this.uploadEyeFade(gl, r, this.eyeFadeWeights);
  }

  private uploadEyeFade(gl: WebGLRenderingContext, r: GLResources, weights: Float32Array) {
    gl.bindBuffer(gl.ARRAY_BUFFER, r.eyeFadeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, weights, gl.STATIC_DRAW);
  }

  /**
   * Uploads the persona with mipmaps (WebGL2, or power-of-two sizes on WebGL1) and anisotropic
   * filtering, so minified skin texture is sampled instead of aliased and the camera-match LOD
   * bias has levels to blur into.
   */
  private uploadTexture(gl: WebGLRenderingContext, r: GLResources, image: PersonaSource) {
    const { width, height } = sourceSize(image);
    gl.bindTexture(gl.TEXTURE_2D, r.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const mipmaps = this.gl2 !== null || (isPowerOfTwo(width) && isPowerOfTwo(height));
    if (mipmaps) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.ext.TEXTURE_MAX_ANISOTROPY_EXT, this.anisotropy.max);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }

  private uploadUvs(gl: WebGLRenderingContext, r: GLResources, uv: Float32Array, usage: number) {
    gl.bindBuffer(gl.ARRAY_BUFFER, r.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uv, usage);
  }

  // ---------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------

  setTopology(topology: FaceTopology) {
    this.topology = topology;
    if (this.gl && this.resources && this.glReady) this.uploadTopology(this.gl, this.resources, topology);
  }

  /** Per-vertex eye pass-through weights (see eyeFadeWeights); scaled per frame by WarpFrameOptions.eyeFade. */
  setEyeFade(weights: Float32Array) {
    this.eyeFadeWeights = weights;
    if (this.gl && this.resources && this.glReady) this.uploadEyeFade(this.gl, this.resources, weights);
  }

  /**
   * @param image persona portrait (or its preprocessed crop)
   * @param uv flat normalized [u, v, ...] landmark positions inside the image (y down, 0..1)
   */
  setPersona(image: PersonaSource, uv: Float32Array) {
    this.personaImage = image;
    this.personaUv = uv;
    this.personaSize = sourceSize(image);
    if (this.gl && this.resources && this.glReady) {
      this.uploadTexture(this.gl, this.resources, image);
      this.uploadUvs(this.gl, this.resources, uv, this.gl.STATIC_DRAW);
    }
  }

  clearPersona() {
    this.personaImage = null;
    this.personaUv = null;
  }

  /**
   * Fast dynamic UV coordinate update without re-uploading texture pixels.
   * Used when switching between multi-angle reference keyframes.
   */
  updateUVs(uv: Float32Array) {
    this.personaUv = uv;
    if (this.gl && this.resources && this.glReady) this.uploadUvs(this.gl, this.resources, uv, this.gl.DYNAMIC_DRAW);
  }

  /** Fast texture re-bind when switching keyframe source images. */
  updateTexture(image: PersonaSource) {
    if (this.personaImage === image) return;
    this.personaImage = image;
    this.personaSize = sourceSize(image);
    if (this.gl && this.resources && this.glReady) this.uploadTexture(this.gl, this.resources, image);
  }

  get hasPersona() {
    return this.personaImage !== null && this.personaUv !== null && this.topology !== null;
  }

  /** Renders the warped persona into this.canvas (transparent background). */
  render(opts: WarpFrameOptions) {
    if (!this.hasPersona) return;
    if (this.gl) {
      if (!this.resources || this.contextLost || this.gl.isContextLost()) return;
      this.renderGL(this.gl, this.resources, opts);
    } else if (this.ctx2d) {
      this.render2D(this.ctx2d, opts);
    }
  }

  private renderGL(gl: WebGLRenderingContext | WebGL2RenderingContext, r: GLResources, opts: WarpFrameOptions) {
    const topo = this.topology!;
    const loc = r.locations;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(r.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, r.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, opts.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, r.uvBuffer);
    gl.enableVertexAttribArray(loc.aUv);
    gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, r.featherBuffer);
    gl.enableVertexAttribArray(loc.aFeather);
    gl.vertexAttribPointer(loc.aFeather, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, r.lipBuffer);
    gl.enableVertexAttribArray(loc.aLip);
    gl.vertexAttribPointer(loc.aLip, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, r.lipZoneBuffer);
    gl.enableVertexAttribArray(loc.aLipZone);
    gl.vertexAttribPointer(loc.aLipZone, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, r.eyeFadeBuffer);
    gl.enableVertexAttribArray(loc.aEyeFade);
    gl.vertexAttribPointer(loc.aEyeFade, 1, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.texture);
    gl.uniform1i(loc.uTexture, 0);
    gl.uniform2f(loc.uResolution, this._canvas.width, this._canvas.height);

    // Multi-zone directional lighting
    const z = opts.zoneLighting;
    const base = opts.colorGain;
    const fGain = z?.forehead ?? base;
    const lGain = z?.leftCheek ?? base;
    const rGain = z?.rightCheek ?? base;
    const nGain = z?.nose ?? base;
    const cGain = z?.chin ?? base;

    gl.uniform3f(loc.uGainForehead, fGain[0], fGain[1], fGain[2]);
    gl.uniform3f(loc.uGainLeftCheek, lGain[0], lGain[1], lGain[2]);
    gl.uniform3f(loc.uGainRightCheek, rGain[0], rGain[1], rGain[2]);
    gl.uniform3f(loc.uGainNose, nGain[0], nGain[1], nGain[2]);
    gl.uniform3f(loc.uGainChin, cGain[0], cGain[1], cGain[2]);

    const bounds = opts.faceBounds ?? [0, 0, this._canvas.width, this._canvas.height];
    gl.uniform4f(loc.uFaceBounds, bounds[0], bounds[1], bounds[2], bounds[3]);
    gl.uniform1f(loc.uOpacity, opts.opacity);
    const shader = opts.shader ?? { unsharp: true, subsurface: true, sebum: true };
    gl.uniform1f(loc.uUnsharp, shader.unsharp ? 1 : 0);
    gl.uniform1f(loc.uSubsurface, shader.subsurface ? 1 : 0);
    gl.uniform1f(loc.uSebum, shader.sebum ? 1 : 0);
    gl.uniform1f(loc.uLipFade, opts.lipFade ?? 0);
    gl.uniform1f(loc.uEyeFade, opts.eyeFade ?? 0);
    gl.uniform1f(loc.uClosedLipMask, opts.closedLipMask ?? 0);
    // The R0 unsharp mask used a fixed 0.0011 offset; a texel-sized kernel is resolution-aware.
    const texel: [number, number] = shader.unsharp && !opts.cameraMatch ? [0.0011, 0.0011] : [1 / this.personaSize.width, 1 / this.personaSize.height];
    gl.uniform2f(loc.uTexelSize, texel[0], texel[1]);
    const cm = opts.cameraMatch;
    gl.uniform1f(loc.uLodBias, cm ? Math.max(0, cm.lodBias) : 0);
    gl.uniform1f(loc.uSharpen, cm ? Math.max(0, cm.sharpen) : 0);
    gl.uniform1f(loc.uNoiseSigma, cm ? Math.max(0, cm.noiseSigma) : 0);
    gl.uniform1f(loc.uFrame, cm ? cm.frame % 4096 : 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.indexBuffer);
    gl.drawElements(gl.TRIANGLES, topo.triangles.length, gl.UNSIGNED_SHORT, 0);

    if (opts.drawPersonaEyes && topo.eyeTriangles.length) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.eyeIndexBuffer);
      gl.drawElements(gl.TRIANGLES, topo.eyeTriangles.length, gl.UNSIGNED_SHORT, 0);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Asynchronous readback (WebGL2): face-region statistics without stalling the GPU
  // ---------------------------------------------------------------------------------------------

  /** True when readFaceStats / readSourceFaceStats can be used (WebGL2 context, not lost). */
  get supportsReadback(): boolean {
    return this.gl2 !== null && this.resources?.readback != null && !this.contextLost;
  }

  /**
   * Copies the given region of the current warp output and starts an asynchronous readback of
   * the READBACK_SIZE-pixel window at its centre (1:1; the whole region, upsampled, when it is
   * smaller). Resolves with the statistics a few frames later (or null if the context was lost).
   * Call right after render() while the drawing buffer still holds the frame.
   */
  readFaceStats(region: [number, number, number, number]): Promise<FaceStats | null> {
    const gl = this.gl2;
    const r = this.resources?.readback;
    if (!gl || !r || this.contextLost) return Promise.resolve(null);
    // Copy the face region of the drawing buffer into the source texture, then downsample it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, r.sourceTexture);
    const x = Math.max(0, Math.floor(region[0]));
    const y = Math.max(0, Math.floor(this._canvas.height - region[1] - region[3]));
    const w = Math.max(1, Math.min(this._canvas.width - x, Math.ceil(region[2])));
    const h = Math.max(1, Math.min(this._canvas.height - y, Math.ceil(region[3])));
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, x, y, w, h, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const win = readbackWindow(w, h);
    return this.downsampleAndRead(gl, r, centredRect([0, 0, 1, 1], [win / w, win / h]));
  }

  /**
   * Uploads a video or canvas frame as a texture and starts an asynchronous readback of the given
   * normalized region (the driver face box for the camera-match estimate). `window`, in the same
   * normalized units, limits the sample to a centred window of the region so it covers the same
   * display pixels as readFaceStats does on the output.
   */
  readSourceFaceStats(source: TexImageSource, region: [number, number, number, number], window?: [number, number]): Promise<FaceStats | null> {
    const gl = this.gl2;
    const r = this.resources?.readback;
    if (!gl || !r || this.contextLost) return Promise.resolve(null);
    gl.bindTexture(gl.TEXTURE_2D, r.sourceTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return this.downsampleAndRead(gl, r, window ? centredRect(region, window) : region);
  }

  private downsampleAndRead(gl: WebGL2RenderingContext, r: NonNullable<GLResources['readback']>, rect: [number, number, number, number]): Promise<FaceStats | null> {
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.framebuffer);
    gl.viewport(0, 0, READBACK_SIZE, READBACK_SIZE);
    gl.disable(gl.BLEND);
    gl.useProgram(r.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.quad);
    gl.enableVertexAttribArray(r.aPosition);
    gl.vertexAttribPointer(r.aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.sourceTexture);
    gl.uniform1i(r.uTexture, 0);
    gl.uniform4f(r.uSrcRect, rect[0], rect[1], rect[2], rect[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, READBACK_SIZE * READBACK_SIZE * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, READBACK_SIZE, READBACK_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.flush();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    gl.enable(gl.BLEND);
    return new Promise((resolve) => this.pending.push({ buffer, sync, resolve }));
  }

  /** Polls pending readbacks (call once per frame); resolved ones hand their statistics over. */
  pollReadbacks() {
    const gl = this.gl2;
    if (!gl || !this.pending.length || this.contextLost) return;
    const still: PendingReadback[] = [];
    for (const p of this.pending) {
      const status = gl.clientWaitSync(p.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) {
        still.push(p);
        continue;
      }
      gl.deleteSync(p.sync);
      if (status === gl.WAIT_FAILED) {
        gl.deleteBuffer(p.buffer);
        p.resolve(null);
        continue;
      }
      const data = new Uint8Array(READBACK_SIZE * READBACK_SIZE * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(p.buffer);
      p.resolve(faceStatsFromPixels(data, READBACK_SIZE, READBACK_SIZE));
    }
    this.pending = still;
  }

  /** CPU fallback: affine-map every triangle individually. */
  private render2D(ctx: CanvasRenderingContext2D, opts: WarpFrameOptions) {
    const topo = this.topology!;
    const uv = this.personaUv!;
    const img = this.personaImage!;
    const { width: iw, height: ih } = this.personaSize;
    const pos = opts.positions;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    ctx.globalAlpha = opts.opacity;
    const lipFade = opts.lipFade ?? 0;
    const eyeFade = opts.eyeFade ?? 0;
    const closedMask = (opts.closedLipMask ?? 0) * (1 - lipFade);
    const eyeW = this.eyeFadeWeights;
    // Per-vertex hole fades become a per-triangle alpha here (no per-pixel interpolation in 2D).
    const holeAlpha = (v: number) =>
      (1 - Math.max(topo.lipWeights[v] * lipFade, closedLipMaskForZone(topo.lipZones[v]) * closedMask)) * (1 - (eyeW ? eyeW[v] : 0) * eyeFade);

    const drawList = (indices: Uint16Array) => {
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        const triAlpha = (holeAlpha(a) + holeAlpha(b) + holeAlpha(c)) / 3;
        if (triAlpha < 0.02) continue;
        ctx.globalAlpha = opts.opacity * triAlpha;
        const x0 = pos[a * 2], y0 = pos[a * 2 + 1];
        const x1 = pos[b * 2], y1 = pos[b * 2 + 1];
        const x2 = pos[c * 2], y2 = pos[c * 2 + 1];
        const u0 = uv[a * 2] * iw, v0 = uv[a * 2 + 1] * ih;
        const u1 = uv[b * 2] * iw, v1 = uv[b * 2 + 1] * ih;
        const u2 = uv[c * 2] * iw, v2 = uv[c * 2 + 1] * ih;

        // Solve affine transform mapping (u,v) -> (x,y)
        const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
        if (Math.abs(det) < 1e-6) continue;
        const ma = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
        const mb = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
        const mc = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
        const md = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
        const me = x0 - ma * u0 - mc * v0;
        const mf = y0 - mb * u0 - md * v0;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.closePath();
        ctx.clip();
        ctx.transform(ma, mb, mc, md, me, mf);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
      }
    };
    drawList(topo.triangles);
    if (opts.drawPersonaEyes) drawList(topo.eyeTriangles);
    ctx.globalAlpha = 1;
  }

  dispose() {
    const gl = this.gl;
    if (gl) {
      this._canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      this._canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
      if (this.resources && !gl.isContextLost()) this.deleteResources(gl, this.resources);
      // Release the GPU context eagerly instead of waiting for garbage collection.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.resources = null;
      this.gl = null;
      this.gl2 = null;
    }
    this.ctx2d = null;
    this.clearPersona();
  }
}

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
 * Falls back to a Canvas 2D per-triangle affine warp when WebGL is unavailable or cannot be
 * initialised, and survives WebGL context loss (GPU reset, tab backgrounding) by rebuilding its
 * GPU resources when the context is restored.
 */
import type { FaceTopology } from './faceMesh.ts';

export interface FacialLightingZones {
  forehead: [number, number, number];
  leftCheek: [number, number, number];
  rightCheek: [number, number, number];
  nose: [number, number, number];
  chin: [number, number, number];
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
  /** Shader "beautification" stages; all on reproduces the pre-R1 look. */
  shader?: { unsharp: boolean; subsurface: boolean; sebum: boolean };
}

type PersonaSource = HTMLImageElement | HTMLCanvasElement;

const VERTEX_SHADER = `
attribute vec2 aPosition;
attribute vec2 aUv;
attribute float aFeather;
attribute float aLip;
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
varying float vEyeFade;

void main() {
  vec2 clip = vec2(aPosition.x / uResolution.x * 2.0 - 1.0, 1.0 - aPosition.y / uResolution.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aUv;
  vFeather = aFeather;
  vLip = aLip;
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

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTexture;
uniform float uOpacity;
uniform float uUnsharp;
uniform float uSubsurface;
uniform float uSebum;
uniform float uLipFade;
uniform float uEyeFade;

varying vec2 vUv;
varying float vFeather;
varying vec3 vLighting;
varying vec2 vNormPos;
varying float vLip;
varying float vEyeFade;

void main() {
  vec4 c = texture2D(uTexture, vUv);
  if (c.a < 0.02) discard;

  // 1. Fixed-offset unsharp mask (realism flag shaderUnsharp; R2 replaces it with a resolution-aware one)
  vec2 d = vec2(0.0011, 0.0011);
  vec4 t0 = texture2D(uTexture, vUv + vec2(-d.x, 0.0));
  vec4 t1 = texture2D(uTexture, vUv + vec2( d.x, 0.0));
  vec4 t2 = texture2D(uTexture, vUv + vec2(0.0, -d.y));
  vec4 t3 = texture2D(uTexture, vUv + vec2(0.0,  d.y));
  vec3 blurred = (t0.rgb + t1.rgb + t2.rgb + t3.rgb) * 0.25;
  vec3 highPass = c.rgb - blurred;
  vec3 microSkin = c.rgb + highPass * 0.35 * uUnsharp;

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

  // 5. Quintic smootherstep feathering curve for outer facial boundary
  float t = clamp(vFeather, 0.0, 1.0);
  float f = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);

  // 6. Cranial hairline feathering: smoothly dissolves the upper forehead boundary
  // into the driver's hairline and temple shadow, eliminating horizontal seam cuts
  float cranialFalloff = smoothstep(0.0, 0.15, vNormPos.y);

  // 7. Keep my real mouth / eye pass-through: fade the persona on the lip band as the mouth opens
  // and in a ring around the eye holes, so the wearer's own lips, lids and lashes show.
  float holes = (1.0 - clamp(vLip * uLipFade, 0.0, 1.0)) * (1.0 - clamp(vEyeFade * uEyeFade, 0.0, 1.0));

  float a = uOpacity * f * cranialFalloff * c.a * holes;

  gl_FragColor = vec4(naturalSkin * a, a);
}`;

interface GLResources {
  program: WebGLProgram;
  positionBuffer: WebGLBuffer;
  uvBuffer: WebGLBuffer;
  featherBuffer: WebGLBuffer;
  lipBuffer: WebGLBuffer;
  eyeFadeBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  eyeIndexBuffer: WebGLBuffer;
  texture: WebGLTexture;
  locations: {
    aPosition: number;
    aUv: number;
    aFeather: number;
    aLip: number;
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
  };
}

function sourceSize(image: PersonaSource): { width: number; height: number } {
  return image instanceof HTMLImageElement
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };
}

export class MeshWarpRenderer {
  private _canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private resources: GLResources | null = null;
  private contextLost = false;

  private topology: FaceTopology | null = null;
  private eyeFadeWeights: Float32Array | null = null;
  private personaImage: PersonaSource | null = null;
  private personaUv: Float32Array | null = null;
  private personaSize = { width: 1, height: 1 };

  constructor(width: number, height: number) {
    this._canvas = document.createElement('canvas');
    this._canvas.width = width;
    this._canvas.height = height;

    const gl =
      (this._canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false }) as WebGLRenderingContext | null) ||
      (this._canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

    if (gl) {
      try {
        this.resources = this.createResources(gl);
        this.gl = gl;
        this._canvas.addEventListener('webglcontextlost', this.handleContextLost);
        this._canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
        return;
      } catch (err) {
        // Shader/program creation failed (driver quirk, blocked GPU). A canvas that already has a
        // WebGL context cannot hand out a 2D one, so start over with a fresh canvas.
        console.warn('WebGL mesh warp unavailable, falling back to Canvas 2D warp.', err);
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

  resize(width: number, height: number) {
    if (this._canvas.width === width && this._canvas.height === height) return;
    this._canvas.width = width;
    this._canvas.height = height;
    this.gl?.viewport(0, 0, width, height);
  }

  // ---------------------------------------------------------------------------------------------
  // WebGL resource lifecycle
  // ---------------------------------------------------------------------------------------------

  private createResources(gl: WebGLRenderingContext): GLResources {
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
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'Program link failed';
      gl.deleteProgram(program);
      throw new Error(log);
    }

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

    return {
      program,
      positionBuffer: buffer(),
      uvBuffer: buffer(),
      featherBuffer: buffer(),
      lipBuffer: buffer(),
      eyeFadeBuffer: buffer(),
      indexBuffer: buffer(),
      eyeIndexBuffer: buffer(),
      texture,
      locations: {
        aPosition: gl.getAttribLocation(program, 'aPosition'),
        aUv: gl.getAttribLocation(program, 'aUv'),
        aFeather: gl.getAttribLocation(program, 'aFeather'),
        aLip: gl.getAttribLocation(program, 'aLip'),
        aEyeFade: gl.getAttribLocation(program, 'aEyeFade'),
        uResolution: gl.getUniformLocation(program, 'uResolution'),
        uTexture: gl.getUniformLocation(program, 'uTexture'),
        uFaceBounds: gl.getUniformLocation(program, 'uFaceBounds'),
        uGainForehead: gl.getUniformLocation(program, 'uGainForehead'),
        uGainLeftCheek: gl.getUniformLocation(program, 'uGainLeftCheek'),
        uGainRightCheek: gl.getUniformLocation(program, 'uGainRightCheek'),
        uGainNose: gl.getUniformLocation(program, 'uGainNose'),
        uGainChin: gl.getUniformLocation(program, 'uGainChin'),
        uOpacity: gl.getUniformLocation(program, 'uOpacity'),
        uUnsharp: gl.getUniformLocation(program, 'uUnsharp'),
        uSubsurface: gl.getUniformLocation(program, 'uSubsurface'),
        uSebum: gl.getUniformLocation(program, 'uSebum'),
        uLipFade: gl.getUniformLocation(program, 'uLipFade'),
        uEyeFade: gl.getUniformLocation(program, 'uEyeFade'),
      },
    };
  }

  private deleteResources(gl: WebGLRenderingContext, r: GLResources) {
    gl.deleteBuffer(r.positionBuffer);
    gl.deleteBuffer(r.uvBuffer);
    gl.deleteBuffer(r.featherBuffer);
    gl.deleteBuffer(r.lipBuffer);
    gl.deleteBuffer(r.eyeFadeBuffer);
    gl.deleteBuffer(r.indexBuffer);
    gl.deleteBuffer(r.eyeIndexBuffer);
    gl.deleteTexture(r.texture);
    gl.deleteProgram(r.program);
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
    if (!this.eyeFadeWeights || this.eyeFadeWeights.length !== topology.vertexCount) {
      this.eyeFadeWeights = new Float32Array(topology.vertexCount);
    }
    this.uploadEyeFade(gl, r, this.eyeFadeWeights);
  }

  private uploadEyeFade(gl: WebGLRenderingContext, r: GLResources, weights: Float32Array) {
    gl.bindBuffer(gl.ARRAY_BUFFER, r.eyeFadeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, weights, gl.STATIC_DRAW);
  }

  private uploadTexture(gl: WebGLRenderingContext, r: GLResources, image: PersonaSource) {
    gl.bindTexture(gl.TEXTURE_2D, r.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
   * @param image persona portrait
   * @param uv flat normalized [u, v, ...] landmark positions inside the portrait (y down, 0..1)
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

  private renderGL(gl: WebGLRenderingContext, r: GLResources, opts: WarpFrameOptions) {
    const topo = this.topology!;
    const loc = r.locations;
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

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.indexBuffer);
    gl.drawElements(gl.TRIANGLES, topo.triangles.length, gl.UNSIGNED_SHORT, 0);

    if (opts.drawPersonaEyes && topo.eyeTriangles.length) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.eyeIndexBuffer);
      gl.drawElements(gl.TRIANGLES, topo.eyeTriangles.length, gl.UNSIGNED_SHORT, 0);
    }
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
    const eyeW = this.eyeFadeWeights;
    // Per-vertex hole fades become a per-triangle alpha here (no per-pixel interpolation in 2D).
    const holeAlpha = (v: number) => (1 - topo.lipWeights[v] * lipFade) * (1 - (eyeW ? eyeW[v] : 0) * eyeFade);

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
    }
    this.ctx2d = null;
    this.clearPersona();
  }
}

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
 * Falls back to a Canvas 2D per-triangle affine warp when WebGL is unavailable.
 */
import type { FaceTopology } from './faceMesh.ts';

export interface WarpFrameOptions {
  /** Flat [x, y, ...] pixel positions for 468+ vertices in output canvas space. */
  positions: Float32Array;
  /** Overall opacity 0..1 (transformation strength). */
  opacity: number;
  /** Per-channel RGB multiplier for lighting adaptation. */
  colorGain: [number, number, number];
  /** Paint persona eyes over the wearer's eyes (otherwise the wearer's real eyes show). */
  drawPersonaEyes: boolean;
}

const VERTEX_SHADER = `
attribute vec2 aPosition;
attribute vec2 aUv;
attribute float aFeather;
uniform vec2 uResolution;
varying vec2 vUv;
varying float vFeather;
void main() {
  vec2 clip = vec2(aPosition.x / uResolution.x * 2.0 - 1.0, 1.0 - aPosition.y / uResolution.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aUv;
  vFeather = aFeather;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTexture;
uniform vec3 uGain;
uniform float uOpacity;
varying vec2 vUv;
varying float vFeather;
void main() {
  vec4 c = texture2D(uTexture, vUv);
  vec3 rgb = clamp(c.rgb * uGain, 0.0, 1.0);
  float a = uOpacity * vFeather * c.a;
  gl_FragColor = vec4(rgb * a, a);
}`;

export class MeshWarpRenderer {
  public readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;

  private program: WebGLProgram | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private uvBuffer: WebGLBuffer | null = null;
  private featherBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private eyeIndexBuffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private locations: {
    aPosition: number;
    aUv: number;
    aFeather: number;
    uResolution: WebGLUniformLocation | null;
    uTexture: WebGLUniformLocation | null;
    uGain: WebGLUniformLocation | null;
    uOpacity: WebGLUniformLocation | null;
  } | null = null;

  private topology: FaceTopology | null = null;
  private personaImage: CanvasImageSource | null = null;
  private personaUv: Float32Array | null = null;
  private personaSize = { width: 1, height: 1 };

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const gl =
      (this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false }) as WebGLRenderingContext | null) ||
      (this.canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (gl) {
      this.gl = gl;
      this.initGL(gl);
    } else {
      this.ctx2d = this.canvas.getContext('2d');
    }
  }

  get usesWebGL() {
    return this.gl !== null;
  }

  resize(width: number, height: number) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl?.viewport(0, 0, width, height);
  }

  private initGL(gl: WebGLRenderingContext) {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || 'Shader compile failed');
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Program link failed');
    }
    this.program = program;
    this.locations = {
      aPosition: gl.getAttribLocation(program, 'aPosition'),
      aUv: gl.getAttribLocation(program, 'aUv'),
      aFeather: gl.getAttribLocation(program, 'aFeather'),
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uTexture: gl.getUniformLocation(program, 'uTexture'),
      uGain: gl.getUniformLocation(program, 'uGain'),
      uOpacity: gl.getUniformLocation(program, 'uOpacity'),
    };
    this.positionBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    this.featherBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.eyeIndexBuffer = gl.createBuffer();
    this.texture = gl.createTexture();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  setTopology(topology: FaceTopology) {
    this.topology = topology;
    const gl = this.gl;
    if (!gl) return;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, topology.triangles, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.eyeIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, topology.eyeTriangles, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.featherBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, topology.featherWeights, gl.STATIC_DRAW);
  }

  /**
   * @param image persona portrait
   * @param uv flat normalized [u, v, ...] landmark positions inside the portrait (y down, 0..1)
   */
  setPersona(image: HTMLImageElement | HTMLCanvasElement, uv: Float32Array) {
    this.personaImage = image;
    this.personaUv = uv;
    this.personaSize = {
      width: image instanceof HTMLImageElement ? image.naturalWidth : image.width,
      height: image instanceof HTMLImageElement ? image.naturalHeight : image.height,
    };
    const gl = this.gl;
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  }

  clearPersona() {
    this.personaImage = null;
    this.personaUv = null;
  }

  get hasPersona() {
    return this.personaImage !== null && this.personaUv !== null && this.topology !== null;
  }

  /** Renders the warped persona into this.canvas (transparent background). */
  render(opts: WarpFrameOptions) {
    if (!this.hasPersona) return;
    if (this.gl) this.renderGL(this.gl, opts);
    else if (this.ctx2d) this.render2D(this.ctx2d, opts);
  }

  private renderGL(gl: WebGLRenderingContext, opts: WarpFrameOptions) {
    const topo = this.topology!;
    const loc = this.locations!;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, opts.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.enableVertexAttribArray(loc.aUv);
    gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.featherBuffer);
    gl.enableVertexAttribArray(loc.aFeather);
    gl.vertexAttribPointer(loc.aFeather, 1, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(loc.uTexture, 0);
    gl.uniform2f(loc.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform3f(loc.uGain, opts.colorGain[0], opts.colorGain[1], opts.colorGain[2]);
    gl.uniform1f(loc.uOpacity, opts.opacity);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.drawElements(gl.TRIANGLES, topo.triangles.length, gl.UNSIGNED_SHORT, 0);

    if (opts.drawPersonaEyes && topo.eyeTriangles.length) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.eyeIndexBuffer);
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
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalAlpha = opts.opacity;

    const drawList = (indices: Uint16Array) => {
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
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
      gl.deleteBuffer(this.positionBuffer);
      gl.deleteBuffer(this.uvBuffer);
      gl.deleteBuffer(this.featherBuffer);
      gl.deleteBuffer(this.indexBuffer);
      gl.deleteBuffer(this.eyeIndexBuffer);
      gl.deleteTexture(this.texture);
      if (this.program) gl.deleteProgram(this.program);
    }
  }
}

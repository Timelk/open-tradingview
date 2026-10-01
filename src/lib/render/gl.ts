/**
 * WebGL2 后端：只画图元（矩形/线段/三角），不画文字。
 * 调用方按 pane 把像素坐标算好塞进来；flush 时两次 draw call 画完全部。
 */

export interface PaneLayout {
  top: number; // device px（本类内部统一用 device px）
  height: number;
  min: number;
  max: number;
}

export const UP = '#26a69a';
export const DOWN = '#ef5350';

const rgbCache = new Map<string, readonly [number, number, number]>();

/** Parses `#rgb`/`#rrggbb` to 0..1 channels. Memoized: the scene uses a small,
 * repeating palette and this runs for every primitive of every frame. */
export function hexRgb(hex: string): readonly [number, number, number] {
  let rgb = rgbCache.get(hex);
  if (rgb) return rgb;
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  rgb = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  if (rgbCache.size > 4096) rgbCache.clear();
  rgbCache.set(hex, rgb);
  return rgb;
}

/** Quarter-arc segments for a corner radius in device px. */
function segmentsFor(radius: number): number {
  return radius < 1.5 ? 1 : radius < 3 ? 2 : radius < 6 ? 3 : 4;
}

/** Clockwise outline points (x,y pairs) of a rounded rectangle; each corner
 * contributes segments+1 points, so inner/outer rings pair up index by index. */
export function roundedOutline(x0: number, y0: number, x1: number, y1: number, radius: number, segments = segmentsFor(radius)): number[] {
  const points: number[] = [];
  const corners: Array<[number, number, number]> = [[x1 - radius, y0 + radius, -Math.PI / 2], [x1 - radius, y1 - radius, 0], [x0 + radius, y1 - radius, Math.PI / 2], [x0 + radius, y0 + radius, Math.PI]];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segments; i++) {
      const angle = start + (i / segments) * (Math.PI / 2);
      points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
  }
  return points;
}

const VS = `#version 300 es
in vec2 aPos;
in vec4 aCol;
uniform vec2 uRes;
out vec4 vCol;
void main() {
  vCol = aCol;
  vec2 p = vec2(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 oCol;
void main() { oCol = vCol; }`;

const FLOATS_PER_VERT = 6; // x, y, r, g, b, a

/** Heatmap instance: left, right, top, bottom (CSS px, anchor-relative), signed quantity. */
export const HEATMAP_FLOATS = 5;

// One quad per instance from gl_VertexID. Cells below the threshold are culled
// on the GPU; the quadratic-ish ramp and alpha mirror resolveHeatmapCellColor.
const HEATMAP_VS = `#version 300 es
in vec4 aRect;
in float aQty;
uniform vec2 uRes;
uniform float uDpr;
uniform vec2 uTranslate;
uniform vec2 uIntensity;
uniform float uOpacity;
uniform sampler2D uLut;
out vec4 vCol;
out vec2 vLocal;
out vec2 vSize;
out float vBead;
void main() {
  float q = abs(aQty);
  if (q <= 0.0 || (uIntensity.x > 0.0 && q < uIntensity.x)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vCol = vec4(0.0);
    vLocal = vec2(0.0);
    vSize = vec2(0.0);
    vBead = 0.0;
    return;
  }
  float lin = clamp((q - uIntensity.x) * uIntensity.y, 0.0, 1.0);
  vec4 c = texture(uLut, vec2((lin * 255.0 + 0.5) / 256.0, aQty > 0.0 ? 0.25 : 0.75));
  float l = aRect.x + uTranslate.x;
  float r = max(aRect.y + uTranslate.x, l + 1.0);
  float t = aRect.z + uTranslate.y;
  float b = max(aRect.w + uTranslate.y, t + 1.0);
  // Bead morph: rows tall enough to read as shapes become soft capsules that
  // bulge slightly past their bin; thin rows stay crisp rectangles.
  float bead = smoothstep(2.5, 4.5, b - t);
  float grow = (b - t) * 0.16 * bead;
  t -= grow;
  b += grow;
  int id = gl_VertexID;
  float cx = (id == 1 || id == 2 || id == 4) ? 1.0 : 0.0;
  float cy = (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0;
  vec2 px = vec2(mix(l, r, cx), mix(t, b, cy)) * uDpr;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  float base = clamp(uOpacity, 0.0, 1.0) * 0.3;
  vCol = vec4(c.rgb, min(1.0, base + (1.0 - base) * c.a));
  vLocal = vec2(cx, cy);
  vSize = vec2(r - l, b - t) * uDpr;
  vBead = bead;
}`;

const HEATMAP_FS = `#version 300 es
precision mediump float;
in vec4 vCol;
in vec2 vLocal;
in vec2 vSize;
in float vBead;
out vec4 oCol;
void main() {
  if (vBead <= 0.001) { oCol = vCol; return; }
  vec2 halfSize = vSize * 0.5;
  vec2 p = (vLocal - 0.5) * vSize;
  // Small horizontal gap separates consecutive beads of one wall.
  vec2 box = max(halfSize - vec2(min(halfSize.x * 0.2, 1.5) * vBead, 0.0), vec2(0.5));
  float radius = vBead * min(box.x, box.y);
  vec2 d = abs(p) - (box - vec2(radius));
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
  float soft = mix(0.6, 1.6, vBead);
  oCol = vec4(vCol.rgb, vCol.a * (1.0 - smoothstep(-soft, soft, dist)));
}`;

interface HeatmapProgram {
  prog: WebGLProgram; vao: WebGLVertexArrayObject; buf: WebGLBuffer; tex: WebGLTexture;
  uploaded: Float32Array | null; uploadedCount: number; lutTheme: string;
  uRes: WebGLUniformLocation | null; uDpr: WebGLUniformLocation | null; uTranslate: WebGLUniformLocation | null;
  uIntensity: WebGLUniformLocation | null; uOpacity: WebGLUniformLocation | null; uLut: WebGLUniformLocation | null;
}

export class GLRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private contextControl: WEBGL_lose_context | null = null;
  private prog: WebGLProgram | null = null;
  private uRes: WebGLUniformLocation | null = null;
  private aPosLoc = -1;
  private aColLoc = -1;
  private triBuf: WebGLBuffer | null = null;
  private lineBuf: WebGLBuffer | null = null;
  private triGpuCap = 0;
  private lineGpuCap = 0;
  private triData = new Float32Array(1 << 20);
  private lineData = new Float32Array(1 << 18);
  private triCount = 0;
  private lineCount = 0;
  private vao: WebGLVertexArrayObject | null = null;
  private hm: HeatmapProgram | null = null;
  devW = 1;
  devH = 1;
  failed = false;
  private lostHandler: (e: Event) => void;
  private restoredHandler: () => void;

  constructor(canvas: HTMLCanvasElement, opts: { onContextLost?: () => void; onContextRestored?: () => void } = {}) {
    this.canvas = canvas;
    this.lostHandler = (e) => {
      e.preventDefault();
      this.failed = true;
      opts.onContextLost?.();
    };
    this.restoredHandler = () => { this.failed = false; this.init(); opts.onContextRestored?.(); };
    canvas.addEventListener('webglcontextlost', this.lostHandler);
    canvas.addEventListener('webglcontextrestored', this.restoredHandler);
    this.init();
  }

  get ok(): boolean {
    return !!this.gl && !this.failed;
  }

  /** 重建上下文（上下文丢失恢复按钮用）。 */
  reinit(): boolean {
    if (this.gl?.isContextLost()) {
      this.contextControl?.restoreContext();
      return false;
    }
    this.release();
    this.failed = false;
    this.init();
    return this.ok;
  }

  private init(): void {
    const gl = this.canvas.getContext('webgl2', {
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      this.gl = null;
      return;
    }
    this.gl = gl;
    this.contextControl = gl.getExtension('WEBGL_lose_context');
    const prog = linkProgram(gl, VS, FS);
    if (!prog) {
      this.gl = null;
      return;
    }
    this.prog = prog;
    this.uRes = gl.getUniformLocation(prog, 'uRes');
    this.aPosLoc = gl.getAttribLocation(prog, 'aPos');
    this.aColLoc = gl.getAttribLocation(prog, 'aCol');
    this.triBuf = gl.createBuffer();
    this.lineBuf = gl.createBuffer();
    this.triGpuCap = 0;
    this.lineGpuCap = 0;
    this.hm = null;
    this.vao = gl.createVertexArray();
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.resizeViewport();
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.devW = Math.max(1, Math.round(cssW * dpr));
    this.devH = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== this.devW || this.canvas.height !== this.devH) {
      this.canvas.width = this.devW;
      this.canvas.height = this.devH;
    }
    this.resizeViewport();
  }

  private resizeViewport(): void {
    if (this.gl) this.gl.viewport(0, 0, this.devW, this.devH);
  }

  begin(bg: string, alpha = 1): void {
    this.triCount = 0;
    this.lineCount = 0;
    const gl = this.gl;
    if (!gl || !this.prog) return;
    const [r, g, b] = hexRgb(bg);
    gl.clearColor(r * alpha, g * alpha, b * alpha, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  rect(x0: number, y0: number, x1: number, y1: number, hex: string, alpha = 1): void {
    const [r, g, b] = hexRgb(hex);
    this.pushTri(x0, y0, x1, y0, x1, y1, r, g, b, alpha);
    this.pushTri(x0, y0, x1, y1, x0, y1, r, g, b, alpha);
  }

  /**
   * Rounded rectangle as a convex triangle fan (device px). Corner arcs use
   * 1–4 segments by radius, so a 1px radius costs a handful of triangles and
   * sub-pixel radii fall back to the plain two-triangle rect.
   */
  roundRect(x0: number, y0: number, x1: number, y1: number, radius: number, hex: string, alpha = 1): void {
    const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
    if (!(r > 0.6)) { this.rect(x0, y0, x1, y1, hex, alpha); return; }
    const [cr, cg, cb] = hexRgb(hex), outline = roundedOutline(x0, y0, x1, y1, r);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, n = outline.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.pushTri(cx, cy, outline[i * 2], outline[i * 2 + 1], outline[j * 2], outline[j * 2 + 1], cr, cg, cb, alpha);
    }
  }

  /** Rounded outline of `width` (device px): hollow candles and bordered bodies. */
  roundRing(x0: number, y0: number, x1: number, y1: number, radius: number, width: number, hex: string, alpha = 1): void {
    const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
    if (x1 - x0 <= width * 2 || y1 - y0 <= width * 2) { this.roundRect(x0, y0, x1, y1, r, hex, alpha); return; }
    if (!(r > 0.6)) {
      this.rect(x0, y0, x1, y0 + width, hex, alpha); this.rect(x0, y1 - width, x1, y1, hex, alpha);
      this.rect(x0, y0 + width, x0 + width, y1 - width, hex, alpha); this.rect(x1 - width, y0 + width, x1, y1 - width, hex, alpha);
      return;
    }
    const [cr, cg, cb] = hexRgb(hex);
    const outer = roundedOutline(x0, y0, x1, y1, r), inner = roundedOutline(x0 + width, y0 + width, x1 - width, y1 - width, Math.max(0.001, r - width), segmentsFor(r));
    const n = outer.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.pushTri(outer[i * 2], outer[i * 2 + 1], outer[j * 2], outer[j * 2 + 1], inner[j * 2], inner[j * 2 + 1], cr, cg, cb, alpha);
      this.pushTri(outer[i * 2], outer[i * 2 + 1], inner[j * 2], inner[j * 2 + 1], inner[i * 2], inner[i * 2 + 1], cr, cg, cb, alpha);
    }
  }

  /** {@link rect} with pre-parsed 0..1 channels (no hex parsing per call). */
  rectRgb(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, alpha = 1): void {
    this.pushTri(x0, y0, x1, y0, x1, y1, r, g, b, alpha);
    this.pushTri(x0, y0, x1, y1, x0, y1, r, g, b, alpha);
  }

  hline(x0: number, x1: number, y: number, hex: string, alpha = 1): void {
    const [r, g, b] = hexRgb(hex);
    const gl = this.gl;
    void gl;
    this.pushLine(x0, y, x1, y, r, g, b, alpha);
  }

  vline(x: number, y0: number, y1: number, hex: string, alpha = 1): void {
    const [r, g, b] = hexRgb(hex);
    this.pushLine(x, y0, x, y1, r, g, b, alpha);
  }

  seg(x0:number,y0:number,x1:number,y1:number,hex:string,alpha=1,width=1):void {
    const [r,g,b]=hexRgb(hex),length=Math.hypot(x1-x0,y1-y0);
    if(length<1e-9)return;
    const dx=-(y1-y0)/length*width*.5,dy=(x1-x0)/length*width*.5;
    this.pushTri(x0+dx,y0+dy,x0-dx,y0-dy,x1+dx,y1+dy,r,g,b,alpha);
    this.pushTri(x1+dx,y1+dy,x0-dx,y0-dy,x1-dx,y1-dy,r,g,b,alpha);
  }

  /** 买▲卖▼ 标记三角。 */
  marker(x: number, y: number, size: number, up: boolean, hex: string, alpha = 1): void {
    const [r, g, b] = hexRgb(hex);
    if (up) this.pushTri(x - size, y + size, x + size, y + size, x, y, r, g, b, alpha);
    else this.pushTri(x - size, y - size, x + size, y - size, x, y, r, g, b, alpha);
  }

  flush(): void {
    const gl = this.gl;
    if (!gl || !this.prog || !this.vao || !this.triBuf || !this.lineBuf) return;
    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, this.devW, this.devH);
    gl.bindVertexArray(this.vao);
    if (this.triCount > 0) {
      this.triGpuCap = upload(gl, this.triBuf, this.triData, this.triCount * FLOATS_PER_VERT, this.triGpuCap);
      bindAttribs(gl, this.prog, this.aPosLoc, this.aColLoc);
      gl.drawArrays(gl.TRIANGLES, 0, this.triCount);
    }
    if (this.lineCount > 0) {
      this.lineGpuCap = upload(gl, this.lineBuf, this.lineData, this.lineCount * FLOATS_PER_VERT, this.lineGpuCap);
      bindAttribs(gl, this.prog, this.aPosLoc, this.aColLoc);
      gl.drawArrays(gl.LINES, 0, this.lineCount);
    }
    gl.bindVertexArray(null);
    this.triCount = 0; this.lineCount = 0;
  }

  /**
   * Instanced depth heatmap. `instances` holds (left, right, top, bottom,
   * signedQuantity) per cell in CSS px relative to a world anchor; positive
   * quantity is bid, negative is ask. The buffer is uploaded only when the
   * array identity changes, so panning (translate) and sensitivity/theme
   * changes (uniforms + a 256×2 LUT texture) never re-upload cell data.
   */
  heatmap(
    instances: Float32Array, count: number,
    translateX: number, translateY: number, dpr: number,
    threshold: number, ceiling: number, opacity: number,
    palette: { theme: string; bytes: Uint8Array },
  ): boolean {
    const gl = this.gl;
    if (!gl || count <= 0) return false;
    if (!this.hm && !this.initHeatmap()) return false;
    const hm = this.hm!;
    this.flush();
    gl.useProgram(hm.prog);
    gl.bindVertexArray(hm.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, hm.buf);
    if (hm.uploaded !== instances || hm.uploadedCount !== count) {
      gl.bufferData(gl.ARRAY_BUFFER, instances.subarray(0, count * HEATMAP_FLOATS), gl.STATIC_DRAW);
      hm.uploaded = instances; hm.uploadedCount = count;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hm.tex);
    if (hm.lutTheme !== palette.theme) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, palette.bytes.length / 8, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, palette.bytes);
      hm.lutTheme = palette.theme;
    }
    gl.uniform2f(hm.uRes, this.devW, this.devH);
    gl.uniform1f(hm.uDpr, dpr);
    gl.uniform2f(hm.uTranslate, translateX, translateY);
    const span = Math.max(1e-9, ceiling - threshold);
    gl.uniform2f(hm.uIntensity, Math.max(0, threshold), 1 / span);
    gl.uniform1f(hm.uOpacity, opacity);
    gl.uniform1i(hm.uLut, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
    return true;
  }

  private initHeatmap(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const prog = linkProgram(gl, HEATMAP_VS, HEATMAP_FS);
    if (!prog) return false;
    const vao = gl.createVertexArray(), buf = gl.createBuffer(), tex = gl.createTexture();
    if (!vao || !buf || !tex) return false;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = HEATMAP_FLOATS * 4, aRect = gl.getAttribLocation(prog, 'aRect'), aQty = gl.getAttribLocation(prog, 'aQty');
    gl.enableVertexAttribArray(aRect);
    gl.vertexAttribPointer(aRect, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(aRect, 1);
    gl.enableVertexAttribArray(aQty);
    gl.vertexAttribPointer(aQty, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(aQty, 1);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.hm = {
      prog, vao, buf, tex, uploaded: null, uploadedCount: 0, lutTheme: '',
      uRes: gl.getUniformLocation(prog, 'uRes'), uDpr: gl.getUniformLocation(prog, 'uDpr'),
      uTranslate: gl.getUniformLocation(prog, 'uTranslate'), uIntensity: gl.getUniformLocation(prog, 'uIntensity'),
      uOpacity: gl.getUniformLocation(prog, 'uOpacity'), uLut: gl.getUniformLocation(prog, 'uLut'),
    };
    return true;
  }

  clip(x: number, y: number, w: number, h: number): void {
    this.flush();
    this.gl?.enable(this.gl.SCISSOR_TEST);
    this.gl?.scissor(Math.round(x), Math.round(this.devH-y-h), Math.round(w), Math.round(h));
  }
  clearClip(): void { this.flush(); this.gl?.disable(this.gl.SCISSOR_TEST); }
  private release(): void {
    const gl = this.gl; if (!gl) return;
    gl.deleteBuffer(this.triBuf); gl.deleteBuffer(this.lineBuf); gl.deleteVertexArray(this.vao); gl.deleteProgram(this.prog);
    if (this.hm) { gl.deleteBuffer(this.hm.buf); gl.deleteVertexArray(this.hm.vao); gl.deleteTexture(this.hm.tex); gl.deleteProgram(this.hm.prog); }
    this.hm = null;
    this.triGpuCap = 0; this.lineGpuCap = 0;
  }
  destroy(): void {
    this.canvas.removeEventListener('webglcontextlost',this.lostHandler);
    this.canvas.removeEventListener('webglcontextrestored',this.restoredHandler);
    this.release();
  }

  private pushTri(
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
    r: number, g: number, b: number, a: number,
  ): void {
    let o = this.triCount * FLOATS_PER_VERT;
    if (o + 18 > this.triData.length) this.triData = grow(this.triData);
    const d = this.triData;
    d[o++] = x0; d[o++] = y0; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
    d[o++] = x1; d[o++] = y1; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
    d[o++] = x2; d[o++] = y2; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
    this.triCount += 3;
  }

  private pushLine(
    x0: number, y0: number, x1: number, y1: number,
    r: number, g: number, b: number, a: number,
  ): void {
    let o = this.lineCount * FLOATS_PER_VERT;
    if (o + 12 > this.lineData.length) this.lineData = grow(this.lineData);
    const d = this.lineData;
    d[o++] = x0; d[o++] = y0; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
    d[o++] = x1; d[o++] = y1; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
    this.lineCount += 2;
  }
}

/** Streams `floats` of `data` into `buffer`, reallocating GPU storage only when
 * it must grow. Returns the allocated byte capacity. */
function upload(gl: WebGL2RenderingContext, buffer: WebGLBuffer, data: Float32Array, floats: number, capacity: number): number {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const bytes = floats * 4;
  if (bytes > capacity) {
    // Allocate for the whole CPU staging array so steady-state frames reuse it.
    capacity = Math.max(bytes, data.byteLength);
    gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
  }
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, floats);
  return capacity;
}

function grow(a: Float32Array): Float32Array {
  const n = new Float32Array(a.length * 2);
  n.set(a);
  return n;
}

function bindAttribs(gl: WebGL2RenderingContext, prog: WebGLProgram, cachedPos = -1, cachedCol = -1): void {
  const stride = FLOATS_PER_VERT * 4;
  const aPos = cachedPos >= 0 ? cachedPos : gl.getAttribLocation(prog, 'aPos');
  const aCol = cachedCol >= 0 ? cachedCol : gl.getAttribLocation(prog, 'aCol');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, stride, 8);
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

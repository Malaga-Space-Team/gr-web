// WebGL2 plots for the web GUI sinks.
//
// All plots share one WebGL context (browsers only allow a handful): each plot
// owns a 2D canvas; the data layer is rendered by the shared context into its
// drawing buffer and copied with drawImage, then axes/grid/labels are drawn
// with the 2D API on top. Rendering only happens when something changed.
'use strict';

import { el, icon, cssVar } from '../common/ui.js';

// ---------------------------------------------------------------- colours
const QT_COLORS = ['#1f77ff', '#ff3b30', '#2ecc40', '#000000', '#00d0e0', '#ff40ff', '#ffd400', '#a00000', '#007a20', '#0030a0'];

export function traceColor(color, index) {
  let c = color || QT_COLORS[index % QT_COLORS.length];
  if (document.documentElement.dataset.theme === 'dark') {
    if (c === '#000000' || c === 'black') c = '#e8e8e8';
    else if (c === '#0030a0') c = '#6f8dff';
    else if (c === '#a00000') c = '#ff6a6a';
    else if (c === '#007a20') c = '#4fd16f';
  }
  return c;
}

function parseColor(css) {
  const ctx = parseColor.ctx || (parseColor.ctx = document.createElement('canvas').getContext('2d'));
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;
  const v = ctx.fillStyle;
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const m = v.match(/[\d.]+/g) || [0, 0, 0];
  return [m[0] / 255, m[1] / 255, m[2] / 255];
}

// colormaps (qtgui: 0 multi-color, 1 white hot, 2 black hot, 3 incandescent, 5 sunset, 6 cool)
const COLORMAPS = {
  0: [[0, '#000000'], [0.2, '#0000c8'], [0.4, '#00b4ff'], [0.6, '#00ff50'], [0.8, '#ffff00'], [1, '#ff0000']],
  1: [[0, '#000000'], [1, '#ffffff']],
  2: [[0, '#ffffff'], [1, '#000000']],
  3: [[0, '#000000'], [0.33, '#a00000'], [0.66, '#ffa000'], [1, '#ffffff']],
  5: [[0, '#1a0a30'], [0.35, '#8a1e5a'], [0.65, '#f05a28'], [1, '#ffe08a']],
  6: [[0, '#00ffff'], [1, '#ff00ff']],
  turbo: [[0, '#30123b'], [0.15, '#4669e0'], [0.3, '#28bceb'], [0.45, '#32f298'], [0.6, '#a4fc3c'], [0.75, '#f9ba38'], [0.9, '#e4460a'], [1, '#7a0403']],
  viridis: [[0, '#440154'], [0.25, '#3b528b'], [0.5, '#21918c'], [0.75, '#5ec962'], [1, '#fde725']],
};
export const COLORMAP_NAMES = { 0: 'Multi-color', 1: 'White hot', 2: 'Black hot', 3: 'Incandescent', 5: 'Sunset', 6: 'Cool', turbo: 'Turbo', viridis: 'Viridis' };

function colormapData(key) {
  const stops = COLORMAPS[key] || COLORMAPS[0];
  const out = new Uint8Array(256 * 4);
  const rgb = stops.map(([p, c]) => [p, parseColor(c)]);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < rgb.length - 2 && t > rgb[j + 1][0]) j++;
    const [p0, c0] = rgb[j];
    const [p1, c1] = rgb[j + 1];
    const f = p1 > p0 ? Math.min(1, Math.max(0, (t - p0) / (p1 - p0))) : 0;
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round((c0[k] + (c1[k] - c0[k]) * f) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ----------------------------------------------------------- shared WebGL
const VS_SERIES = `#version 300 es
in float a_y;
uniform float u_x0, u_dx;
uniform vec4 u_view;
uniform vec2 u_off;
uniform float u_size;
void main() {
  float x = u_x0 + float(gl_VertexID) * u_dx;
  gl_Position = vec4((x - u_view.x) / (u_view.y - u_view.x) * 2.0 - 1.0 + u_off.x,
                     (a_y - u_view.z) / (u_view.w - u_view.z) * 2.0 - 1.0 + u_off.y, 0.0, 1.0);
  gl_PointSize = u_size;
}`;
const VS_XY = `#version 300 es
in vec2 a_xy;
uniform vec4 u_view;
uniform vec2 u_off;
uniform float u_size;
void main() {
  gl_Position = vec4((a_xy.x - u_view.x) / (u_view.y - u_view.x) * 2.0 - 1.0 + u_off.x,
                     (a_xy.y - u_view.z) / (u_view.w - u_view.z) * 2.0 - 1.0 + u_off.y, 0.0, 1.0);
  gl_PointSize = u_size;
}`;
const FS_COLOR = `#version 300 es
precision mediump float;
uniform vec4 u_color;
uniform int u_shape;
out vec4 o;
void main() {
  if (u_shape == 1) {
    vec2 p = gl_PointCoord - 0.5;
    if (dot(p, p) > 0.25) discard;
  }
  o = u_color;
}`;
const VS_QUAD = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const FS_HEAT = `#version 300 es
precision highp float;
uniform highp sampler2D u_data;
uniform sampler2D u_cmap;
uniform float u_head, u_rows, u_zmin, u_zmax, u_x0, u_x1;
uniform int u_layout; // 0: newest row at the top (waterfall), 1: rows top->bottom (raster)
in vec2 v_uv;
out vec4 o;
void main() {
  float x = mix(u_x0, u_x1, v_uv.x);
  if (x < 0.0 || x > 1.0) { o = vec4(0.0); return; }
  float age = (1.0 - v_uv.y) * u_rows;
  float row = u_layout == 0 ? mod(u_head - floor(age) + u_rows, u_rows) : floor(age);
  float v = texture(u_data, vec2(x, (row + 0.5) / u_rows)).r;
  if (v < -1e29) { o = vec4(0.0); return; }
  float t = clamp((v - u_zmin) / (u_zmax - u_zmin), 0.0, 1.0);
  o = texture(u_cmap, vec2(t, 0.5));
}`;

class Renderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 256;
    const gl = this.canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.series = this._program(VS_SERIES, FS_COLOR);
    this.xy = this._program(VS_XY, FS_COLOR);
    this.heat = this._program(VS_QUAD, FS_HEAT);
    this.buffer = gl.createBuffer();
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vaoSeries = this._vao(this.series, 'a_y', 1, this.buffer);
    this.vaoXY = this._vao(this.xy, 'a_xy', 2, this.buffer);
    this.vaoQuad = this._vao(this.heat, 'a_pos', 2, this.quad);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  _program(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  _vao(prog, attr, size, buffer) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const loc = gl.getAttribLocation(prog.p, attr);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  begin(w, h, bg) {
    const gl = this.gl;
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, Math.ceil(w));
      this.canvas.height = Math.max(this.canvas.height, Math.ceil(h));
    }
    this.w = w;
    this.h = h;
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, w, h);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // draw the rendered area onto a 2D context
  blit(ctx, x, y) {
    ctx.drawImage(this.canvas, 0, this.canvas.height - this.h, this.w, this.h, x, y, this.w, this.h);
  }

  _lineOffsets(width) {
    const out = [[0, 0]];
    const k = 2 / Math.max(1, this.h);
    const kx = 2 / Math.max(1, this.w);
    for (let i = 1; i < width; i++) {
      const s = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.5;
      out.push([0, s * k], [s * kx, 0]);
    }
    return out;
  }

  // y values at uniform x positions
  drawSeries(data, x0, dx, view, color, { width = 1, points = 0, lines = true, alpha = 1 } = {}) {
    const gl = this.gl;
    const { p, u } = this.series;
    gl.useProgram(p);
    gl.bindVertexArray(this.vaoSeries);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.uniform1f(u.u_x0, x0);
    gl.uniform1f(u.u_dx, dx);
    gl.uniform4f(u.u_view, view.x0, view.x1, view.y0, view.y1);
    gl.uniform4f(u.u_color, color[0], color[1], color[2], alpha);
    if (lines) {
      gl.uniform1i(u.u_shape, 0);
      gl.uniform1f(u.u_size, 1);
      for (const [ox, oy] of this._lineOffsets(Math.round(width))) {
        gl.uniform2f(u.u_off, ox, oy);
        gl.drawArrays(gl.LINE_STRIP, 0, data.length);
      }
    }
    if (points) {
      gl.uniform2f(u.u_off, 0, 0);
      gl.uniform1i(u.u_shape, points === 2 ? 0 : 1);
      gl.uniform1f(u.u_size, points === 2 ? 5 : 6);
      gl.drawArrays(gl.POINTS, 0, data.length);
    }
  }

  drawXY(data, view, color, { mode = 'points', size = 4, width = 1, alpha = 1, first = 0, count } = {}) {
    const gl = this.gl;
    const { p, u } = this.xy;
    gl.useProgram(p);
    gl.bindVertexArray(this.vaoXY);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.uniform4f(u.u_view, view.x0, view.x1, view.y0, view.y1);
    gl.uniform4f(u.u_color, color[0], color[1], color[2], alpha);
    const n = count === undefined ? data.length / 2 : count;
    if (mode === 'points') {
      gl.uniform2f(u.u_off, 0, 0);
      gl.uniform1i(u.u_shape, 1);
      gl.uniform1f(u.u_size, size);
      gl.drawArrays(gl.POINTS, first, n);
    } else {
      gl.uniform1i(u.u_shape, 0);
      gl.uniform1f(u.u_size, 1);
      for (const [ox, oy] of this._lineOffsets(Math.round(width))) {
        gl.uniform2f(u.u_off, ox, oy);
        gl.drawArrays(mode === 'segments' ? gl.LINES : gl.LINE_STRIP, first, n);
      }
    }
  }

  drawStrips(data, segLen, nseg, view, color, alpha) {
    const gl = this.gl;
    const { p, u } = this.xy;
    gl.useProgram(p);
    gl.bindVertexArray(this.vaoXY);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.uniform4f(u.u_view, view.x0, view.x1, view.y0, view.y1);
    gl.uniform4f(u.u_color, color[0], color[1], color[2], alpha);
    gl.uniform1i(u.u_shape, 0);
    gl.uniform2f(u.u_off, 0, 0);
    for (let s = 0; s < nseg; s++) gl.drawArrays(gl.LINE_STRIP, s * segLen, segLen);
  }

  heatmap(tex, cmap, { head, rows, zmin, zmax, x0, x1, layout }) {
    const gl = this.gl;
    const { p, u } = this.heat;
    gl.useProgram(p);
    gl.bindVertexArray(this.vaoQuad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.u_data, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, cmap);
    gl.uniform1i(u.u_cmap, 1);
    gl.uniform1f(u.u_head, head);
    gl.uniform1f(u.u_rows, rows);
    gl.uniform1f(u.u_zmin, zmin);
    gl.uniform1f(u.u_zmax, zmax);
    gl.uniform1f(u.u_x0, x0);
    gl.uniform1f(u.u_x1, x1);
    gl.uniform1i(u.u_layout, layout);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  createDataTexture(cols, rows) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fill = new Float32Array(cols * rows).fill(-1e30);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, cols, rows, 0, gl.RED, gl.FLOAT, fill);
    return tex;
  }

  uploadRows(tex, row, cols, nrows, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, cols, nrows, gl.RED, gl.FLOAT, data);
  }

  createColormap(key) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colormapData(key));
    return tex;
  }

  deleteTexture(tex) {
    if (tex) this.gl.deleteTexture(tex);
  }
}

// Same API with the 2D canvas, for browsers or remote desktops without WebGL2.
class Canvas2DRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d');
    this.image = null;
  }

  begin(w, h, bg) {
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, Math.ceil(w));
      this.canvas.height = Math.max(this.canvas.height, Math.ceil(h));
    }
    this.w = w;
    this.h = h;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, this.canvas.height - h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgb(${bg.map((c) => Math.round(c * 255)).join(',')})`;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
  }

  blit(ctx, x, y) {
    this.ctx.restore();
    ctx.drawImage(this.canvas, 0, this.canvas.height - this.h, this.w, this.h, x, y, this.w, this.h);
  }

  _style(color, alpha) {
    const css = `rgb(${color.map((c) => Math.round(c * 255)).join(',')})`;
    this.ctx.strokeStyle = css;
    this.ctx.fillStyle = css;
    this.ctx.globalAlpha = alpha;
  }

  drawSeries(data, x0, dx, view, color, { width = 1, points = 0, lines = true, alpha = 1 } = {}) {
    const ctx = this.ctx;
    const sx = this.w / (view.x1 - view.x0);
    const sy = this.h / (view.y1 - view.y0);
    const n = data.length;
    this._style(color, alpha);
    if (lines && n) {
      ctx.lineWidth = width;
      ctx.beginPath();
      const perPixel = Math.abs(dx * sx);
      if (perPixel < 0.5) {
        // more samples than pixels: draw the min/max of each pixel column
        let col = null, lo = 0, hi = 0;
        const flush = () => {
          const px = (col + 0.5);
          ctx.moveTo(px, this.h - (lo - view.y0) * sy);
          ctx.lineTo(px, this.h - (hi - view.y0) * sy + 0.5);
        };
        for (let i = 0; i < n; i++) {
          const c = Math.floor((x0 + i * dx - view.x0) * sx);
          const v = data[i];
          if (c !== col) {
            if (col !== null) flush();
            col = c; lo = v; hi = v;
          } else {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        if (col !== null) flush();
      } else {
        for (let i = 0; i < n; i++) {
          const px = (x0 + i * dx - view.x0) * sx;
          const py = this.h - (data[i] - view.y0) * sy;
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
      }
      ctx.stroke();
    }
    if (points) {
      const s = points === 2 ? 5 : 4;
      for (let i = 0; i < n; i++) {
        const px = (x0 + i * dx - view.x0) * sx;
        const py = this.h - (data[i] - view.y0) * sy;
        ctx.fillRect(px - s / 2, py - s / 2, s, s);
      }
    }
  }

  drawXY(data, view, color, { mode = 'points', size = 4, width = 1, alpha = 1, first = 0, count } = {}) {
    const ctx = this.ctx;
    const sx = this.w / (view.x1 - view.x0);
    const sy = this.h / (view.y1 - view.y0);
    const n = count === undefined ? data.length / 2 : count;
    this._style(color, alpha);
    const X = (i) => (data[2 * i] - view.x0) * sx;
    const Y = (i) => this.h - (data[2 * i + 1] - view.y0) * sy;
    if (mode === 'points') {
      for (let i = first; i < first + n; i++) ctx.fillRect(X(i) - size / 2, Y(i) - size / 2, size, size);
      return;
    }
    ctx.lineWidth = width;
    ctx.beginPath();
    if (mode === 'segments') {
      for (let i = first; i + 1 < first + n; i += 2) { ctx.moveTo(X(i), Y(i)); ctx.lineTo(X(i + 1), Y(i + 1)); }
    } else {
      for (let i = first; i < first + n; i++) { if (i === first) ctx.moveTo(X(i), Y(i)); else ctx.lineTo(X(i), Y(i)); }
    }
    ctx.stroke();
  }

  drawStrips(data, segLen, nseg, view, color, alpha) {
    for (let s = 0; s < nseg; s++) this.drawXY(data, view, color, { mode: 'strip', alpha, first: s * segLen, count: segLen });
  }

  heatmap(tex, cmap, { head, rows, zmin, zmax, x0, x1, layout }) {
    const w = Math.max(1, Math.floor(this.w));
    const h = Math.max(1, Math.floor(this.h));
    if (!this.image || this.image.width !== w || this.image.height !== h) this.image = this.ctx.createImageData(w, h);
    const px = this.image.data;
    const cols = tex.cols;
    const colIndex = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      const u = x0 + (x + 0.5) / w * (x1 - x0);
      colIndex[x] = u < 0 || u > 1 ? -1 : Math.min(cols - 1, Math.floor(u * cols));
    }
    const k = 255 / ((zmax - zmin) || 1);
    for (let y = 0; y < h; y++) {
      const age = Math.floor(y / h * rows);
      const row = layout === 0 ? (head - age + rows) % rows : age;
      const base = row * cols;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, o += 4) {
        const c = colIndex[x];
        const v = c < 0 ? -1e30 : tex.data[base + c];
        if (v < -1e29) { px[o + 3] = 0; continue; }
        const t = Math.max(0, Math.min(255, Math.round((v - zmin) * k))) * 4;
        px[o] = cmap[t]; px[o + 1] = cmap[t + 1]; px[o + 2] = cmap[t + 2]; px[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.image, 0, this.canvas.height - this.h);
  }

  createDataTexture(cols, rows) {
    return { cols, rows, data: new Float32Array(cols * rows).fill(-1e30) };
  }

  uploadRows(tex, row, cols, nrows, data) {
    tex.data.set(data.subarray(0, cols * nrows), row * cols);
  }

  createColormap(key) { return colormapData(key); }

  deleteTexture() {}
}

let renderer = null;
function getRenderer() {
  if (!renderer) {
    let forced = '';
    try { forced = localStorage.getItem('grcweb.renderer') || ''; } catch (e) { /* ignore */ }
    if (forced !== '2d') {
      try { renderer = new Renderer(); } catch (err) { console.warn('WebGL2 unavailable, using 2D plots:', err.message); }
    }
    if (!renderer) renderer = new Canvas2DRenderer();
  }
  return renderer;
}

export function rendererName() {
  return getRenderer() instanceof Renderer ? 'WebGL2' : 'Canvas 2D';
}

// ------------------------------------------------------------- axes/ticks
const PREFIXES = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];

export function unitScale(maxAbs, unit) {
  if (!unit || !isFinite(maxAbs) || maxAbs === 0) return [1, unit || ''];
  for (const [f, s] of PREFIXES) if (maxAbs >= f) return [f, s + unit];
  return [1e-12, 'p' + unit];
}

export function niceTicks(min, max, approx) {
  const range = max - min;
  if (!(range > 0) || !isFinite(range)) return { ticks: [min], step: 1 };
  const raw = range / Math.max(1, approx);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return { ticks, step };
}

function fmtTick(v, step, scale) {
  const s = step / scale;
  const decimals = Math.max(0, Math.min(9, -Math.floor(Math.log10(s) + 1e-9)));
  return (v / scale).toFixed(decimals);
}

export function fmtValue(v, unit = '', digits = 5) {
  if (!isFinite(v)) return String(v);
  const [f, u] = unitScale(Math.abs(v), unit);
  return `${+(v / f).toPrecision(digits)}${u ? ' ' + u : ''}`;
}

// ------------------------------------------------------------- base plot
export class Plot {
  constructor({ title = '', xunit = '', yunit = '', xlabel = '', ylabel = '', grid = true, legend = true, axislabels = true } = {}) {
    this.cfg = { title, xunit, yunit, xlabel, ylabel, grid, legend, axislabels };
    this.canvas = el('canvas', { class: 'plot-canvas' });
    this.readout = el('div', { class: 'plot-readout' });
    this.legendEl = el('div', { class: 'plot-legend' });
    this.tools = el('div', { class: 'plot-tools' });
    this.titleEl = el('div', { class: 'plot-title' }, title);
    this.area = el('div', { class: 'plot-area' }, this.canvas, this.legendEl, this.readout);
    this.root = el('div', { class: 'plot' }, el('div', { class: 'plot-head' }, this.titleEl, this.tools), this.area);
    this.ctx = this.canvas.getContext('2d');
    this.margin = { l: 58, r: 12, t: 8, b: 30 };
    this.view = { x0: 0, x1: 1, y0: -1, y1: 1 };
    this.home = { x0: 0, x1: 1, y0: -1, y1: 1 };
    this.zoomed = false;
    this.autoY = false;
    this.paused = false;
    this.dirty = true;
    this.cursor = null;
    this.onEvent = null;
    this._raf = 0;
    this._resize = new ResizeObserver(() => this.invalidate());
    this._resize.observe(this.area);
    this._bindMouse();
    window.addEventListener('themechange', () => { this.themeChanged(); this.invalidate(); });
    this.pauseBtn = this.tool('pause', 'Pause / resume', () => this.setPaused(!this.paused));
    this.tool('fit', 'Reset zoom (or right click)', () => this.resetZoom());
    this.gridBtn = this.tool('grid', 'Grid', () => { this.cfg.grid = !this.cfg.grid; this.gridBtn.classList.toggle('on', this.cfg.grid); this.invalidate(); });
    this.gridBtn.classList.toggle('on', !!grid);
    this.tool('camera', 'Save as PNG', () => this.snapshot());
  }

  tool(name, title, fn) {
    const b = el('button', { class: 'pt-btn', type: 'button', title }, icon(name));
    b.addEventListener('click', fn);
    this.tools.append(b);
    return b;
  }

  setPaused(paused) {
    this.paused = paused;
    this.pauseBtn.textContent = '';
    this.pauseBtn.append(icon(paused ? 'play' : 'pause'));
    this.pauseBtn.classList.toggle('on', paused);
    if (this.onEvent) this.onEvent('pause', paused);
    this.invalidate();
  }

  setTitle(title) {
    this.cfg.title = title;
    this.titleEl.textContent = title;
  }

  themeChanged() {}

  invalidate() {
    this.dirty = true;
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  plotRect() {
    const w = this.area.clientWidth;
    const h = this.area.clientHeight;
    const m = this.margin;
    return { x: m.l, y: m.t, w: Math.max(10, w - m.l - m.r), h: Math.max(10, h - m.t - m.b), W: w, H: h };
  }

  _draw() {
    if (!this.root.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const r = this.plotRect();
    if (r.W < 20 || r.H < 20) return;
    const cw = Math.round(r.W * dpr);
    const ch = Math.round(r.H * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    this.beforeDraw();
    const R = getRenderer();
    const bg = parseColor(cssVar('--plot-bg') || '#000');
    R.begin(Math.round(r.w * dpr), Math.round(r.h * dpr), bg);
    this.drawData(R);
    R.blit(ctx, Math.round(r.x * dpr), Math.round(r.y * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawAxes(ctx, r);
    this.drawOverlay(ctx, r);
    this.dirty = false;
  }

  beforeDraw() {}

  drawData() {}

  drawOverlay() {}

  xToPx(x, r) { return r.x + (x - this.view.x0) / (this.view.x1 - this.view.x0) * r.w; }

  yToPx(y, r) { return r.y + r.h - (y - this.view.y0) / (this.view.y1 - this.view.y0) * r.h; }

  pxToX(px, r) { return this.view.x0 + (px - r.x) / r.w * (this.view.x1 - this.view.x0); }

  pxToY(py, r) { return this.view.y0 + (r.y + r.h - py) / r.h * (this.view.y1 - this.view.y0); }

  xAxisFormat() {
    const [scale, unit] = unitScale(Math.max(Math.abs(this.view.x0), Math.abs(this.view.x1)), this.cfg.xunit);
    return { scale, unit };
  }

  yAxisFormat() {
    if (this.cfg.yunit === 'dB' || !this.cfg.yunit) return { scale: 1, unit: this.cfg.yunit || '' };
    const [scale, unit] = unitScale(Math.max(Math.abs(this.view.y0), Math.abs(this.view.y1)), this.cfg.yunit);
    return { scale, unit };
  }

  drawAxes(ctx, r) {
    const text = cssVar('--plot-text');
    const gridColor = cssVar('--plot-grid');
    const axis = cssVar('--plot-axis');
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const xf = this.xAxisFormat();
    const yf = this.yAxisFormat();
    const xt = niceTicks(this.view.x0, this.view.x1, Math.max(2, r.w / 90));
    const yt = niceTicks(this.view.y0, this.view.y1, Math.max(2, r.h / 45));
    ctx.strokeStyle = gridColor;
    ctx.beginPath();
    if (this.cfg.grid) {
      for (const t of xt.ticks) { const x = Math.round(this.xToPx(t, r)) + 0.5; ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); }
      for (const t of yt.ticks) { const y = Math.round(this.yToPx(t, r)) + 0.5; ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); }
    }
    ctx.stroke();
    ctx.strokeStyle = axis;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastRight = -Infinity;
    for (const t of xt.ticks) {
      const x = this.xToPx(t, r);
      const label = fmtTick(t, xt.step, xf.scale);
      const w = ctx.measureText(label).width;
      if (x - w / 2 < lastRight + 6) continue;
      ctx.fillText(label, x, r.y + r.h + 4);
      lastRight = x + w / 2;
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yt.ticks) ctx.fillText(fmtTick(t, yt.step, yf.scale), r.x - 5, this.yToPx(t, r));
    if (this.cfg.axislabels) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      const xl = [this.cfg.xlabel, xf.unit ? `(${xf.unit})` : ''].filter(Boolean).join(' ');
      if (xl) ctx.fillText(xl, r.x + r.w, r.y + r.h + 29);
      ctx.save();
      ctx.translate(11, r.y + r.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      const yl = [this.cfg.ylabel, yf.unit ? `(${yf.unit})` : ''].filter(Boolean).join(' ');
      if (yl) ctx.fillText(yl, 0, 0);
      ctx.restore();
    }
    if (this.paused) {
      ctx.fillStyle = cssVar('--warn');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('❚❚ paused', r.x + 6, r.y + 4);
    }
  }

  setHome(home) {
    this.home = { ...this.home, ...home };
    if (!this.zoomed) {
      this.view = { ...this.view, ...home };
      this.invalidate();
    }
  }

  resetZoom() {
    this.zoomed = false;
    this.view = { ...this.home };
    this.invalidate();
  }

  readoutAt() { return ''; }

  _bindMouse() {
    const area = this.area;
    let drag = null;
    let box = null;
    area.addEventListener('contextmenu', (e) => { e.preventDefault(); this.resetZoom(); });
    area.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.plot-legend')) return;
      const r = this.plotRect();
      const rect = area.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        drag = { mode: 'pan', px, py, view: { ...this.view } };
      } else if (e.button === 0) {
        drag = { mode: 'box', px, py };
        box = el('div', { class: 'zoom-box' });
        area.append(box);
      } else return;
      area.setPointerCapture(e.pointerId);
      e.preventDefault();
      drag.r = r;
    });
    area.addEventListener('pointermove', (e) => {
      const rect = area.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const r = this.plotRect();
      if (drag && drag.mode === 'pan') {
        const dx = (px - drag.px) / r.w * (drag.view.x1 - drag.view.x0);
        const dy = (py - drag.py) / r.h * (drag.view.y1 - drag.view.y0);
        this.view = { x0: drag.view.x0 - dx, x1: drag.view.x1 - dx, y0: drag.view.y0 + dy, y1: drag.view.y1 + dy };
        this.zoomed = true;
        this.invalidate();
      } else if (drag && drag.mode === 'box') {
        Object.assign(box.style, {
          left: Math.min(px, drag.px) + 'px', top: Math.min(py, drag.py) + 'px',
          width: Math.abs(px - drag.px) + 'px', height: Math.abs(py - drag.py) + 'px',
        });
      }
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        this.cursor = { x: this.pxToX(px, r), y: this.pxToY(py, r) };
        this.readout.textContent = this.readoutAt(this.cursor.x, this.cursor.y);
        this.readout.style.display = 'block';
      } else {
        this.cursor = null;
        this.readout.style.display = 'none';
      }
    });
    area.addEventListener('pointerleave', () => { this.readout.style.display = 'none'; });
    area.addEventListener('pointerup', (e) => {
      if (!drag) return;
      if (drag.mode === 'box') {
        box.remove();
        const rect = area.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const r = drag.r;
        if (Math.abs(px - drag.px) > 6 && Math.abs(py - drag.py) > 6) {
          const xa = this.pxToX(Math.min(px, drag.px), r);
          const xb = this.pxToX(Math.max(px, drag.px), r);
          const ya = this.pxToY(Math.max(py, drag.py), r);
          const yb = this.pxToY(Math.min(py, drag.py), r);
          this.view = { x0: xa, x1: xb, y0: ya, y1: yb };
          this.zoomed = true;
          this.invalidate();
        } else {
          this.click(this.pxToX(px, r), this.pxToY(py, r), e);
        }
      }
      drag = null;
    });
    area.addEventListener('dblclick', (e) => {
      const rect = area.getBoundingClientRect();
      const r = this.plotRect();
      this.dblclick(this.pxToX(e.clientX - rect.left, r), this.pxToY(e.clientY - rect.top, r));
    });
    area.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = area.getBoundingClientRect();
      const r = this.plotRect();
      const f = Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015));
      if (e.shiftKey || e.ctrlKey) {
        const y = this.pxToY(e.clientY - rect.top, r);
        this.view.y0 = y - (y - this.view.y0) * f;
        this.view.y1 = y + (this.view.y1 - y) * f;
      } else {
        const x = this.pxToX(e.clientX - rect.left, r);
        this.view.x0 = x - (x - this.view.x0) * f;
        this.view.x1 = x + (this.view.x1 - x) * f;
      }
      this.zoomed = true;
      this.invalidate();
    }, { passive: false });
  }

  click() {}

  dblclick() {}

  snapshot() {
    this._draw();
    const a = el('a', { href: this.canvas.toDataURL('image/png'), download: (this.cfg.title || 'plot') + '.png' });
    a.click();
  }

  destroy() {
    this._resize.disconnect();
    cancelAnimationFrame(this._raf);
  }
}

// ---------------------------------------------------------- line plots
export class LinePlot extends Plot {
  constructor(opts = {}) {
    super(opts);
    this.lines = [];
    this.data = null;     // Float32Array per trace
    this.x0 = 0;
    this.dx = 1;
    this.n = 0;
    this.autoY = !!opts.autoscale;
    this.stem = false;
    this.hold = { max: null, min: null };
    this.tags = [];
    this.markers = [];
    this.autoBtn = this.tool('autoscale', 'Autoscale Y', () => this.setAutoY(!this.autoY));
    this.autoBtn.classList.toggle('on', this.autoY);
  }

  setAutoY(on) {
    this.autoY = on;
    this.autoBtn.classList.toggle('on', on);
    if (!on) { this.view.y0 = this.home.y0; this.view.y1 = this.home.y1; }
    this.invalidate();
  }

  setLines(lines) {
    this.lines = lines.map((l, i) => ({ ...l, visible: this.lines[i] ? this.lines[i].visible : true }));
    this._legend();
    this.invalidate();
  }

  _legend() {
    this.legendEl.textContent = '';
    if (!this.cfg.legend || this.lines.length < 1) { this.legendEl.style.display = 'none'; return; }
    this.legendEl.style.display = '';
    this.lines.forEach((line, i) => {
      if (this.data && i >= this.data.length) return;
      const item = el('span', { class: 'lg' + (line.visible ? '' : ' off') },
        el('i', { style: { background: traceColor(line.color, i) } }), line.label || `Data ${i}`);
      item.addEventListener('click', () => { line.visible = !line.visible; this._legend(); this.invalidate(); });
      this.legendEl.append(item);
    });
  }

  themeChanged() { this._legend(); }

  setData(traces, x0, dx) {
    if (this.paused) return;
    const n = traces.length ? traces[0].length : 0;
    const changed = n !== this.n || x0 !== this.x0 || dx !== this.dx || !this.data || this.data.length !== traces.length;
    this.data = traces;
    this.n = n;
    this.x0 = x0;
    this.dx = dx;
    if (this.hold.max) this._updateHold('max', (a, b) => Math.max(a, b), changed);
    if (this.hold.min) this._updateHold('min', (a, b) => Math.min(a, b), changed);
    if (changed) {
      this.setHome({ x0, x1: x0 + dx * Math.max(1, n - 1) });
      this._legend();
    }
    this.invalidate();
  }

  _updateHold(kind, fn, reset) {
    const hold = this.hold[kind];
    this.data.forEach((trace, i) => {
      if (reset || !hold[i] || hold[i].length !== trace.length) { hold[i] = Float32Array.from(trace); return; }
      const h = hold[i];
      for (let k = 0; k < trace.length; k++) h[k] = fn(h[k], trace[k]);
    });
  }

  setHold(kind, on) {
    this.hold[kind] = on ? [] : null;
    if (on && this.data) this._updateHold(kind, null, true);
    this.invalidate();
  }

  beforeDraw() {
    if (!this.autoY || this.zoomed || !this.data) return;
    let lo = Infinity, hi = -Infinity;
    this.data.forEach((trace, i) => {
      if (this.lines[i] && this.lines[i].visible === false) return;
      for (let k = 0; k < trace.length; k++) {
        const v = trace[k];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    });
    if (!isFinite(lo)) return;
    if (this.stem) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
    const t0 = lo - pad, t1 = hi + pad;
    // expand at once, shrink smoothly (avoids a jumpy axis)
    this.view.y0 = t0 < this.view.y0 ? t0 : this.view.y0 + (t0 - this.view.y0) * 0.15;
    this.view.y1 = t1 > this.view.y1 ? t1 : this.view.y1 + (t1 - this.view.y1) * 0.15;
    if (Math.abs(this.view.y0 - t0) > 1e-6 * (t1 - t0) || Math.abs(this.view.y1 - t1) > 1e-6 * (t1 - t0)) this.invalidate();
  }

  drawData(R) {
    if (!this.data) return;
    const view = this.view;
    this.data.forEach((trace, i) => {
      const line = this.lines[i] || {};
      if (line.visible === false || !trace.length) return;
      const color = parseColor(traceColor(line.color, i));
      const alpha = line.alpha === undefined ? 1 : line.alpha;
      for (const kind of ['max', 'min']) {
        const h = this.hold[kind];
        if (h && h[i]) R.drawSeries(h[i], this.x0, this.dx, view, color, { alpha: alpha * 0.45 });
      }
      if (this.stem) {
        const xy = new Float32Array(trace.length * 4);
        for (let k = 0; k < trace.length; k++) {
          const x = this.x0 + k * this.dx;
          xy.set([x, 0, x, trace[k]], k * 4);
        }
        R.drawXY(xy, view, color, { mode: 'segments', alpha });
        R.drawSeries(trace, this.x0, this.dx, view, color, { lines: false, points: 1, alpha });
        return;
      }
      const lines = line.style === undefined || line.style > 0;
      const points = line.marker >= 0 ? (line.marker === 1 ? 2 : 1) : 0;
      R.drawSeries(trace, this.x0, this.dx, view, color, { width: line.width || 1, lines, points, alpha });
    });
  }

  drawOverlay(ctx, r) {
    if (this.tags.length) {
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.strokeStyle = cssVar('--warn');
      ctx.fillStyle = cssVar('--warn');
      ctx.setLineDash([3, 3]);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      let row = 0;
      for (const [idx, chan, key, val] of this.tags) {
        const x = this.xToPx(this.x0 + idx * this.dx, r);
        if (x < r.x || x > r.x + r.w) continue;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, r.y);
        ctx.lineTo(x + 0.5, r.y + r.h);
        ctx.stroke();
        ctx.fillText(`${key}: ${val}`, x + 3, r.y + 4 + (row++ % 4) * 12);
      }
      ctx.restore();
    }
    for (const m of this.markers) {
      ctx.save();
      ctx.strokeStyle = m.color || cssVar('--accent');
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      if (m.y !== undefined) { const y = Math.round(this.yToPx(m.y, r)) + 0.5; ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); }
      if (m.x !== undefined) { const x = Math.round(this.xToPx(m.x, r)) + 0.5; ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); }
      ctx.stroke();
      ctx.restore();
    }
  }

  readoutAt(x, y) {
    const xs = fmtValue(x, this.cfg.xunit);
    if (!this.data || !this.n) return `x ${xs}   y ${fmtValue(y, this.cfg.yunit === 'dB' ? '' : this.cfg.yunit)}`;
    const k = Math.round((x - this.x0) / this.dx);
    const parts = [`x ${xs}`];
    if (k >= 0 && k < this.n) {
      this.data.forEach((trace, i) => {
        if (this.lines[i] && this.lines[i].visible === false) return;
        const unit = this.cfg.yunit === 'dB' ? ' dB' : '';
        parts.push(`${(this.lines[i] && this.lines[i].label) || 'y' + i}: ${+trace[k].toPrecision(5)}${unit}`);
      });
    }
    return parts.join('   ');
  }
}

// ------------------------------------------------- XY plots (constellation)
export class XYPlot extends Plot {
  constructor(opts = {}) {
    super(opts);
    this.lines = [];
    this.data = null; // Float32Array of interleaved x,y per trace
    this.autoY = !!opts.autoscale;
    this.autoBtn = this.tool('autoscale', 'Autoscale', () => { this.autoY = !this.autoY; this.autoBtn.classList.toggle('on', this.autoY); if (!this.autoY) this.resetZoom(); this.invalidate(); });
    this.autoBtn.classList.toggle('on', this.autoY);
  }

  setLines(lines) {
    this.lines = lines.map((l, i) => ({ ...l, visible: this.lines[i] ? this.lines[i].visible : true }));
    LinePlot.prototype._legend.call(this);
  }

  themeChanged() { LinePlot.prototype._legend.call(this); }

  setData(traces) {
    if (this.paused) return;
    const first = !this.data || this.data.length !== traces.length;
    this.data = traces;
    if (first) LinePlot.prototype._legend.call(this);
    this.invalidate();
  }

  beforeDraw() {
    if (!this.autoY || this.zoomed || !this.data) return;
    let m = 0;
    for (const t of this.data) for (let k = 0; k < t.length; k++) m = Math.max(m, Math.abs(t[k]));
    if (!m) return;
    const target = m * 1.1;
    const cur = this.view.x1;
    const next = target > cur ? target : cur + (target - cur) * 0.15;
    this.view = { x0: -next, x1: next, y0: -next, y1: next };
    if (Math.abs(next - target) > 1e-6 * target) this.invalidate();
  }

  _fitAspect(r) {
    // keep the constellation square
    const sx = (this.view.x1 - this.view.x0) / r.w;
    const sy = (this.view.y1 - this.view.y0) / r.h;
    if (this.zoomed) return;
    if (sx > sy) {
      const c = (this.view.y0 + this.view.y1) / 2;
      const half = sx * r.h / 2;
      this.view.y0 = c - half; this.view.y1 = c + half;
    } else {
      const c = (this.view.x0 + this.view.x1) / 2;
      const half = sy * r.w / 2;
      this.view.x0 = c - half; this.view.x1 = c + half;
    }
  }

  drawData(R) {
    if (!this.data) return;
    if (this.square) this._fitAspect(this.plotRect());
    this.data.forEach((trace, i) => {
      const line = this.lines[i] || {};
      if (line.visible === false) return;
      const color = parseColor(traceColor(line.color, i));
      const alpha = line.alpha === undefined ? 1 : line.alpha;
      if (line.style > 0) R.drawXY(trace, this.view, color, { mode: 'strip', width: line.width || 1, alpha });
      if (line.marker === undefined || line.marker >= 0 || !(line.style > 0)) {
        R.drawXY(trace, this.view, color, { mode: 'points', size: 3 + (line.width || 1), alpha });
      }
    });
  }

  readoutAt(x, y) {
    const mag = Math.hypot(x, y);
    const ph = Math.atan2(y, x) * 180 / Math.PI;
    return `I ${+x.toPrecision(4)}   Q ${+y.toPrecision(4)}   |z| ${+mag.toPrecision(4)}   ∠ ${ph.toFixed(1)}°`;
  }
}

// ----------------------------------------------- eye diagram (segments)
export class EyePlot extends Plot {
  constructor(opts = {}) {
    super(opts);
    this.color = null;
    this.segs = null;
    this.autoY = !!opts.autoscale;
  }

  setData(segs, segLen, nseg, dx, color, alpha) {
    if (this.paused) return;
    this.segs = segs;
    this.segLen = segLen;
    this.nseg = nseg;
    this.color = color;
    this.alpha = alpha;
    this.setHome({ x0: 0, x1: dx * (segLen - 1) });
    if (this.autoY && !this.zoomed) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 1; k < segs.length; k += 2) { lo = Math.min(lo, segs[k]); hi = Math.max(hi, segs[k]); }
      const pad = (hi - lo) * 0.08 || 1;
      this.view.y0 = lo - pad;
      this.view.y1 = hi + pad;
    }
    this.invalidate();
  }

  drawData(R) {
    if (!this.segs) return;
    R.drawStrips(this.segs, this.segLen, this.nseg, this.view, parseColor(this.color), Math.max(0.15, Math.min(1, 6 / Math.sqrt(this.nseg))) * (this.alpha || 1));
  }

  readoutAt(x, y) { return `t ${fmtValue(x, 's')}   y ${+y.toPrecision(4)}`; }
}

// ------------------------------------------------ waterfall / raster
export class HeatPlot extends Plot {
  constructor(opts = {}) {
    super(opts);
    this.layout = opts.layout === 'raster' ? 1 : 0;
    this.rows = opts.rows || 300;
    this.cols = 0;
    this.head = -1;
    this.tex = null;
    this.colormap = opts.colormap === undefined ? 0 : opts.colormap;
    this.cmapTex = null;
    this.zmin = opts.zmin === undefined ? -140 : opts.zmin;
    this.zmax = opts.zmax === undefined ? 10 : opts.zmax;
    this.x0 = 0;
    this.dx = 1;
    this.rowPeriod = opts.rowPeriod || 0.1;
    this.recent = [];
    this.margin.r = 46;
    this.cmapSel = el('select', { class: 'pt-sel', title: 'Colour map' });
    for (const [k, name] of Object.entries(COLORMAP_NAMES)) this.cmapSel.append(el('option', { value: k }, name));
    this.cmapSel.value = String(this.colormap);
    this.cmapSel.addEventListener('change', () => this.setColormap(this.cmapSel.value));
    this.tools.prepend(this.cmapSel);
    this.tool('autoscale', 'Auto intensity range', () => this.autoRange());
  }

  setColormap(key) {
    this.colormap = key;
    if (this.cmapTex) { getRenderer().deleteTexture(this.cmapTex); this.cmapTex = null; }
    this.invalidate();
  }

  setRange(zmin, zmax) {
    this.zmin = zmin;
    this.zmax = zmax;
    this.invalidate();
  }

  autoRange() {
    if (!this.recent.length) return;
    const all = [];
    for (const row of this.recent) for (let k = 0; k < row.length; k += 4) all.push(row[k]);
    all.sort((a, b) => a - b);
    const lo = all[Math.floor(all.length * 0.05)];
    const hi = all[Math.floor(all.length * 0.999)];
    if (isFinite(lo) && isFinite(hi) && hi > lo) this.setRange(lo, hi + (hi - lo) * 0.05);
  }

  // rows: Float32Array(nrows * cols)
  addRows(rows, nrows, cols, x0, dx) {
    if (this.paused) return;
    const R = getRenderer();
    let reset = false;
    if (cols !== this.cols || !this.tex) {
      R.deleteTexture(this.tex);
      this.cols = cols;
      this.tex = R.createDataTexture(cols, this.rows);
      this.head = -1;
      this.recent = [];
      reset = true;
    }
    if (reset || x0 !== this.x0 || dx !== this.dx) {
      this.x0 = x0;
      this.dx = dx;
      this.setHome({ x0, x1: x0 + dx * cols });
    }
    if (this.layout === 1) {
      // raster: the newest block of rows replaces the picture from the top
      const n = Math.min(nrows, this.rows);
      const start = (this.head + 1) % this.rows;
      for (let i = 0; i < n; i++) {
        const row = (start + i) % this.rows;
        R.uploadRows(this.tex, row, cols, 1, rows.subarray((nrows - n + i) * cols, (nrows - n + i + 1) * cols));
      }
      this.head = (start + n - 1) % this.rows;
    } else {
      for (let i = 0; i < nrows; i++) {
        this.head = (this.head + 1) % this.rows;
        R.uploadRows(this.tex, this.head, cols, 1, rows.subarray(i * cols, (i + 1) * cols));
      }
    }
    this.recent.push(rows.subarray((nrows - 1) * cols, nrows * cols));
    if (this.recent.length > 20) this.recent.shift();
    this.invalidate();
  }

  beforeDraw() {
    if (!this.zoomed) { this.view.y0 = this.layout === 0 ? -this.rows * this.rowPeriod : this.rows; this.view.y1 = 0; }
  }

  yAxisFormat() { return { scale: 1, unit: this.layout === 0 ? 's' : '' }; }

  drawData(R) {
    if (!this.tex) return;
    if (!this.cmapTex) this.cmapTex = R.createColormap(this.colormap);
    const total = this.dx * this.cols || 1;
    const x0 = (this.view.x0 - this.x0) / total;
    const x1 = (this.view.x1 - this.x0) / total;
    R.heatmap(this.tex, this.cmapTex, { head: this.head, rows: this.rows, zmin: this.zmin, zmax: this.zmax, x0, x1, layout: this.layout });
  }

  drawOverlay(ctx, r) {
    // intensity scale bar
    const x = r.x + r.w + 8;
    const grad = ctx.createLinearGradient(0, r.y + r.h, 0, r.y);
    const data = colormapData(this.colormap);
    for (let i = 0; i <= 8; i++) {
      const k = Math.round(i / 8 * 255) * 4;
      grad.addColorStop(i / 8, `rgb(${data[k]},${data[k + 1]},${data[k + 2]})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(x, r.y, 10, r.h);
    ctx.fillStyle = cssVar('--plot-text');
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(+this.zmax.toPrecision(3)), x - 2, r.y - 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(+this.zmin.toPrecision(3)), x - 2, r.y + r.h + 12);
  }

  readoutAt(x, y) {
    return `x ${fmtValue(x, this.cfg.xunit)}   ${this.layout === 0 ? 't ' + fmtValue(-y, 's') : 'row ' + Math.round(y)}`;
  }
}

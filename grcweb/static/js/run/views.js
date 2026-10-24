// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// Run window components for the plot sinks.
'use strict';

import { el, toast } from '../common/ui.js';
import { LinePlot, XYPlot, EyePlot, HeatPlot, traceColor, fmtValue } from './plots.js';

function splitTraces(buffer, traces, n) {
  const all = new Float32Array(buffer);
  const out = [];
  for (let i = 0; i < traces; i++) out.push(all.subarray(i * n, (i + 1) * n));
  return out;
}

function dequantize(buffer, header, input) {
  // payload: rows x inputs x cols (uint8), scale: [min, max] per (row, input)
  const q = new Uint8Array(buffer);
  const { rows, cols } = header;
  const inputs = header.inputs || 1;
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const s = header.scale[r * inputs + input] || [0, 1];
    const k = (s[1] - s[0]) / 255;
    const src = (r * inputs + input) * cols;
    const dst = r * cols;
    for (let c = 0; c < cols; c++) out[dst + c] = s[0] + q[src + c] * k;
  }
  return out;
}

class View {
  constructor(ctx, name) {
    this.ctx = ctx;
    this.name = name;
    this.cfg = {};
  }

  send(event, data) { this.ctx.send(this.name, event, data); }

  config(cfg) { this.cfg = cfg; }

  frame() {}

  value() {}

  destroy() {}
}

class PlotView extends View {
  attach(plot) {
    this.plot = plot;
    this.node = el('div', { class: 'item plot-item' }, plot.root);
    plot.onEvent = (event, data) => this.send(event, data);
  }

  applyCommon(cfg) {
    const p = this.plot;
    p.setTitle(cfg.title || '');
    p.cfg.grid = !!cfg.grid;
    p.gridBtn.classList.toggle('on', p.cfg.grid);
    p.cfg.legend = cfg.legend !== false;
    p.cfg.axislabels = cfg.axislabels !== false;
  }

  destroy() { this.plot.destroy(); }
}

// ------------------------------------------------------------------- time
export class TimeView extends PlotView {
  constructor(ctx, name) {
    super(ctx, name);
    this.attach(new LinePlot({ xunit: 's', xlabel: 'Time', ylabel: 'Amplitude' }));
    this.trigBox = el('div', { class: 'plot-panel hidden' });
    this.plot.tool('hold', 'Trigger', () => this.trigBox.classList.toggle('hidden'));
    this.plot.root.insertBefore(this.trigBox, this.plot.area);
  }

  config(cfg) {
    super.config(cfg);
    const p = this.plot;
    this.applyCommon(cfg);
    p.cfg.ylabel = cfg.ylabel || 'Amplitude';
    p.cfg.yunit = cfg.yunit || '';
    p.stem = !!cfg.stem;
    p.setHome({ y0: cfg.ymin, y1: cfg.ymax });
    if (cfg.autoscale && !p.autoY) p.setAutoY(true);
    p.setLines(cfg.lines || []);
    this._trigger(cfg.trigger || {});
    if (cfg.ctrlpanel) this.trigBox.classList.remove('hidden');
  }

  _trigger(t) {
    const box = this.trigBox;
    box.textContent = '';
    const mode = el('select', {}, ...['free', 'auto', 'norm', 'tag'].map((m) => el('option', { value: m }, { free: 'Free', auto: 'Auto', norm: 'Normal', tag: 'Tag' }[m])));
    mode.value = t.mode || 'free';
    const slope = el('select', {}, el('option', { value: 'pos' }, 'Positive'), el('option', { value: 'neg' }, 'Negative'));
    slope.value = t.slope || 'pos';
    const level = el('input', { type: 'number', step: 'any', value: t.level || 0, style: { width: '80px' } });
    const chan = el('select', {}, ...(this.cfg.lines || [{ label: 'Data 0' }]).map((l, i) => el('option', { value: i }, l.label || 'Data ' + i)));
    chan.value = t.chan || 0;
    const apply = () => this.send('trigger', { mode: mode.value, slope: slope.value, level: parseFloat(level.value) || 0, chan: parseInt(chan.value, 10) });
    for (const c of [mode, slope, chan]) c.addEventListener('change', apply);
    level.addEventListener('change', apply);
    box.append(el('label', {}, 'Trigger ', mode), el('label', {}, 'Slope ', slope), el('label', {}, 'Level ', level), el('label', {}, 'Channel ', chan));
    this.plot.markers = t.mode && t.mode !== 'free' && t.mode !== 'tag' ? [{ y: t.level }] : [];
  }

  frame(h, payload) {
    const traces = splitTraces(payload, h.traces, h.n);
    this.plot.tags = h.tags || [];
    this.plot.setData(traces, h.x0 || 0, h.dx);
  }
}

// --------------------------------------------------------------- frequency
export class FreqView extends PlotView {
  constructor(ctx, name, { compact = false } = {}) {
    super(ctx, name);
    this.attach(new LinePlot({ xunit: 'Hz', xlabel: 'Frequency', ylabel: 'Relative Gain', yunit: 'dB' }));
    const p = this.plot;
    this.maxBtn = p.tool('up', 'Max hold', () => { const on = !p.hold.max; p.setHold('max', on); this.maxBtn.classList.toggle('on', on); });
    this.minBtn = p.tool('zout', 'Min hold', () => { const on = !p.hold.min; p.setHold('min', on); this.minBtn.classList.toggle('on', on); });
    if (!compact) {
      this.avg = el('select', { class: 'pt-sel', title: 'Averaging' },
        el('option', { value: '1' }, 'No avg'), el('option', { value: '0.2' }, 'Avg low'),
        el('option', { value: '0.1' }, 'Avg med'), el('option', { value: '0.05' }, 'Avg high'));
      this.fft = el('select', { class: 'pt-sel', title: 'FFT size' },
        ...[32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768].map((n) => el('option', { value: n }, String(n))));
      this.win = el('select', { class: 'pt-sel', title: 'Window' },
        ...[['WIN_BLACKMAN_hARRIS', 'Blackman-Harris'], ['WIN_HAMMING', 'Hamming'], ['WIN_HANN', 'Hann'], ['WIN_BLACKMAN', 'Blackman'],
          ['WIN_RECTANGULAR', 'Rectangular'], ['WIN_KAISER', 'Kaiser'], ['WIN_FLATTOP', 'Flat-top']].map(([v, l]) => el('option', { value: v }, l)));
      this.avg.addEventListener('change', () => this.send('fft', { average: parseFloat(this.avg.value) }));
      this.fft.addEventListener('change', () => this.send('fft', { fftsize: parseInt(this.fft.value, 10) }));
      this.win.addEventListener('change', () => this.send('fft', { window: this.win.value }));
      p.tools.prepend(this.win, this.fft, this.avg);
    }
    p.dblclick = (x) => {
      this.send('freq_click', x);
      toast(`Frequency ${fmtValue(x, 'Hz', 7)} sent on the 'freq' port`, '', 1800);
    };
  }

  config(cfg) {
    super.config(cfg);
    const p = this.plot;
    this.applyCommon(cfg);
    p.cfg.ylabel = cfg.ylabel || 'Relative Gain';
    p.cfg.yunit = cfg.yunit || 'dB';
    p.setHome({ y0: cfg.ymin, y1: cfg.ymax });
    if (cfg.autoscale && !p.autoY) p.setAutoY(true);
    p.setLines(cfg.lines || [{ label: 'Data 0' }]);
    if (this.avg) {
      const options = [...this.avg.options].map((o) => o.value);
      const v = String(cfg.average);
      if (!options.includes(v)) this.avg.append(el('option', { value: v }, 'Avg ' + v));
      this.avg.value = v;
      this.fft.value = String(cfg.fftsize);
      if (![...this.fft.options].some((o) => o.value === String(cfg.fftsize))) this.fft.append(el('option', { value: cfg.fftsize }, String(cfg.fftsize)));
      this.fft.value = String(cfg.fftsize);
      if (cfg.window) this.win.value = cfg.window;
    }
  }

  frame(h, payload) {
    this.plot.setData(splitTraces(payload, h.traces, h.n), h.x0, h.dx);
  }
}

// --------------------------------------------------------------- waterfall
export class WaterfallView extends PlotView {
  constructor(ctx, name, { raster = false } = {}) {
    super(ctx, name);
    this.raster = raster;
    this.attach(new HeatPlot({ xunit: raster ? '' : 'Hz', xlabel: raster ? '' : 'Frequency', ylabel: raster ? 'Row' : 'Time', layout: raster ? 'raster' : 'waterfall' }));
    this.input = 0;
    this.inputSel = el('select', { class: 'pt-sel hidden', title: 'Input' });
    this.inputSel.addEventListener('change', () => { this.input = parseInt(this.inputSel.value, 10); });
    this.plot.tools.prepend(this.inputSel);
    this.zmin = el('input', { type: 'number', step: 'any', class: 'pt-num', title: 'Min intensity' });
    this.zmax = el('input', { type: 'number', step: 'any', class: 'pt-num', title: 'Max intensity' });
    const apply = () => this.plot.setRange(parseFloat(this.zmin.value), parseFloat(this.zmax.value));
    this.zmin.addEventListener('change', apply);
    this.zmax.addEventListener('change', apply);
    this.plot.tools.prepend(this.zmin, this.zmax);
    const setRange = this.plot.setRange.bind(this.plot);
    this.plot.setRange = (a, b) => { setRange(a, b); this.zmin.value = +a.toPrecision(4); this.zmax.value = +b.toPrecision(4); };
    if (!raster) {
      this.plot.dblclick = (x) => {
        this.send('freq_click', x);
        toast(`Frequency ${fmtValue(x, 'Hz', 7)} sent on the 'freq' port`, '', 1800);
      };
    }
  }

  config(cfg) {
    super.config(cfg);
    const p = this.plot;
    this.applyCommon(cfg);
    if (this.raster) {
      p.rows = Math.max(8, Math.min(2048, cfg.nrows || 256));
      p.cfg.xlabel = cfg.xlabel || 'Column';
      p.cfg.ylabel = cfg.ylabel || 'Row';
      p.setColormap(cfg.colormap || 0);
    } else {
      p.rowPeriod = cfg.update_time || 0.1;
      const line = (cfg.lines || [])[0] || {};
      p.setColormap(line.colormap || 0);
      const names = (cfg.lines || []).map((l) => l.label);
      this.inputSel.textContent = '';
      names.forEach((n, i) => this.inputSel.append(el('option', { value: i }, n)));
      this.inputSel.classList.toggle('hidden', names.length < 2);
    }
    p.cmapSel.value = String(p.colormap);
    p.setRange(cfg.zmin === undefined ? -140 : cfg.zmin, cfg.zmax === undefined ? 10 : cfg.zmax);
  }

  frame(h, payload) {
    const input = Math.min(this.input, (h.inputs || 1) - 1);
    const rows = dequantize(payload, h, input);
    const x0 = this.raster ? 0 : h.x0;
    const dx = this.raster ? 1 : h.dx;
    this.plot.addRows(rows, h.rows, h.cols, x0, dx);
  }
}

// ---------------------------------------------------------- constellation
export class ConstView extends PlotView {
  constructor(ctx, name) {
    super(ctx, name);
    this.attach(new XYPlot({ xlabel: 'In-phase', ylabel: 'Quadrature' }));
    this.plot.square = true;
  }

  config(cfg) {
    super.config(cfg);
    const p = this.plot;
    this.applyCommon(cfg);
    p.setHome({ x0: cfg.xmin, x1: cfg.xmax, y0: cfg.ymin, y1: cfg.ymax });
    if (cfg.autoscale) { p.autoY = true; p.autoBtn.classList.add('on'); }
    p.setLines(cfg.lines || [{ label: 'Data 0', style: 0, marker: 0 }]);
  }

  frame(h, payload) {
    const all = new Float32Array(payload);
    const traces = [];
    for (let i = 0; i < h.traces; i++) traces.push(all.subarray(i * h.n * 2, (i + 1) * h.n * 2));
    this.plot.setData(traces);
  }
}

// --------------------------------------------------- histogram / vector / ...
export class HistogramView extends PlotView {
  constructor(ctx, name) {
    super(ctx, name);
    this.attach(new LinePlot({ xlabel: 'Value', ylabel: 'Count', autoscale: true }));
    this.plot.stem = true;
    this.plot.tool('del', 'Clear accumulated', () => this.send('clear', true));
  }

  config(cfg) {
    super.config(cfg);
    this.applyCommon(cfg);
    this.plot.setLines((cfg.lines || []).map((l) => ({ ...l, marker: -1 })));
  }

  frame(h, payload) {
    this.plot.setData(splitTraces(payload, h.traces, h.n), h.x0, h.dx);
  }
}

export class VectorView extends PlotView {
  constructor(ctx, name) {
    super(ctx, name);
    this.attach(new LinePlot({}));
    const p = this.plot;
    this.maxBtn = p.tool('up', 'Max hold', () => { const on = !p.hold.max; p.setHold('max', on); this.maxBtn.classList.toggle('on', on); });
    p.dblclick = (x) => this.send('x_click', x);
  }

  config(cfg) {
    super.config(cfg);
    const p = this.plot;
    this.applyCommon(cfg);
    p.cfg.xlabel = cfg.xlabel || '';
    p.cfg.ylabel = cfg.ylabel || '';
    p.cfg.xunit = cfg.xunit || '';
    p.cfg.yunit = cfg.yunit || '';
    p.setHome({ y0: cfg.ymin, y1: cfg.ymax });
    if (cfg.autoscale && !p.autoY) p.setAutoY(true);
    p.markers = cfg.ref ? [{ y: cfg.ref }] : [];
    p.setLines(cfg.lines || []);
  }

  frame(h, payload) {
    this.plot.setData(splitTraces(payload, h.traces, h.n), h.x0, h.dx);
  }
}

export class AutocorrView extends PlotView {
  constructor(ctx, name) {
    super(ctx, name);
    this.attach(new LinePlot({ xunit: 's', xlabel: 'Lag', ylabel: 'Autocorrelation' }));
  }

  config(cfg) {
    super.config(cfg);
    const p = this.plot;
    this.applyCommon(cfg);
    p.cfg.yunit = cfg.db ? 'dB' : '';
    p.setHome({ y0: cfg.ymin, y1: cfg.ymax });
    if (cfg.autoscale && !p.autoY) p.setAutoY(true);
    p.setLines(cfg.lines || []);
  }

  frame(h, payload) {
    this.plot.setData(splitTraces(payload, h.traces, h.n), h.x0, h.dx);
  }
}

// ------------------------------------------------------------------- eye
export class EyeView extends View {
  constructor(ctx, name) {
    super(ctx, name);
    this.node = el('div', { class: 'item eye-item' });
    this.plots = [];
  }

  config(cfg) {
    super.config(cfg);
    const lines = cfg.lines || [];
    while (this.plots.length < lines.length) {
      const plot = new EyePlot({ xunit: 's', xlabel: 'Time', autoscale: cfg.autoscale });
      plot.onEvent = (event, data) => this.send(event, data);
      this.plots.push(plot);
      this.node.append(el('div', { class: 'plot-item' }, plot.root));
    }
    this.plots.forEach((plot, i) => {
      plot.setTitle((cfg.title ? cfg.title + ' — ' : '') + (lines[i] ? lines[i].label : ''));
      plot.cfg.ylabel = cfg.ylabel || '';
      plot.setHome({ y0: cfg.ymin, y1: cfg.ymax });
      plot.cfg.grid = !!cfg.grid;
    });
  }

  frame(h, payload) {
    const all = new Float32Array(payload);
    const per = h.nseg * h.seglen;
    for (let t = 0; t < h.traces && t < this.plots.length; t++) {
      const xy = new Float32Array(per * 2);
      for (let s = 0; s < h.nseg; s++) {
        for (let k = 0; k < h.seglen; k++) {
          const idx = s * h.seglen + k;
          xy[idx * 2] = k * h.dx;
          xy[idx * 2 + 1] = all[t * per + idx];
        }
      }
      const line = (this.cfg.lines || [])[t] || {};
      this.plots[t].setData(xy, h.seglen, h.nseg, h.dx, traceColor(line.color, t), line.alpha);
    }
  }

  destroy() { this.plots.forEach((p) => p.destroy()); }
}

// --------------------------------------------- QT GUI Sink (combined)
export class ComboView extends View {
  constructor(ctx, name) {
    super(ctx, name);
    this.views = {
      freq: new FreqView(ctx, name, { compact: true }),
      waterfall: new WaterfallView(ctx, name),
      time: new TimeView(ctx, name),
      const: new ConstView(ctx, name),
    };
    this.bar = el('div', { class: 'tabbar' });
    this.pages = el('div', { class: 'tabpages' });
    this.node = el('div', { class: 'item combo-item tabs-item' }, this.bar, this.pages);
    this.active = 'freq';
  }

  config(cfg) {
    super.config(cfg);
    const names = { freq: 'Frequency Display', waterfall: 'Waterfall Display', time: 'Time Domain Display', const: 'Constellation Display' };
    this.bar.textContent = '';
    this.pages.textContent = '';
    const views = cfg.views && cfg.views.length ? cfg.views : ['freq'];
    if (!views.includes(this.active)) this.active = views[0];
    for (const key of views) {
      const b = el('button', { type: 'button', class: key === this.active ? 'on' : '' }, names[key]);
      b.addEventListener('click', () => { this.active = key; this.config(this.cfg); });
      this.bar.append(b);
      const page = el('div', { class: 'tabpage' + (key === this.active ? '' : ' hidden') }, this.views[key].node);
      this.pages.append(page);
    }
    this.views.freq.config({ title: '', ymin: -140, ymax: 10, lines: [{ label: 'Spectrum' }], fftsize: cfg.fftsize, average: 1 });
    this.views.waterfall.config({ title: '', zmin: -140, zmax: 10, lines: [{ label: 'Data 0', colormap: 0 }], update_time: 0.1 });
    this.views.time.config({ title: '', ymin: -1, ymax: 1, autoscale: true, lines: cfg.cplx ? [{ label: 'Re' }, { label: 'Im' }] : [{ label: 'Data 0' }] });
    this.views.const.config({ title: '', xmin: -2, xmax: 2, ymin: -2, ymax: 2, autoscale: true, lines: [{ label: 'Data 0', style: 0, marker: 0 }] });
    for (const v of Object.values(this.views)) if (v.plot) v.plot.invalidate();
  }

  frame(h, payload) {
    const view = this.views[h.view];
    if (view) view.frame(h, payload);
  }

  destroy() { Object.values(this.views).forEach((v) => v.destroy()); }
}

export const VIEWS = {
  time: TimeView, freq: FreqView, waterfall: WaterfallView,
  raster: (ctx, name) => new WaterfallView(ctx, name, { raster: true }),
  const: ConstView, histogram: HistogramView, vector: VectorView, autocorr: AutocorrView,
  eye: EyeView, combo: ComboView,
};

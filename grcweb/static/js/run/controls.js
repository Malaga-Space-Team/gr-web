// Run window components for the QT GUI widgets (controls and indicators).
'use strict';

import { el, svgEl, eng, throttle } from '../common/ui.js';

class Control {
  constructor(ctx, name, cls = '') {
    this.ctx = ctx;
    this.name = name;
    this.cfg = {};
    this.val = null;
    this.node = el('div', { class: 'item ctl ' + cls });
  }

  send(event, data) { this.ctx.send(this.name, event, data); }

  config(cfg) { this.cfg = cfg; this.render(); }

  value(v) { this.val = v; this.update(); }

  render() {}

  update() {}

  frame() {}

  destroy() {}
}

function fmt(v, isInt) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  if (isInt) return String(Math.round(v));
  return String(+Number(v).toPrecision(10));
}

// ------------------------------------------------------------------ range
export class RangeControl extends Control {
  constructor(ctx, name) {
    super(ctx, name, 'range');
    this.sendThrottled = throttle((v) => this.send('value', v), 60);
  }

  render() {
    const c = this.cfg;
    this.node.textContent = '';
    this.node.classList.toggle('vertical', !!c.vertical);
    const label = el('span', { class: 'ctl-label' }, c.label);
    const slider = el('input', { type: 'range', min: c.start, max: c.stop, step: c.step || 'any' });
    const number = el('input', { type: 'number', min: c.start, max: c.stop, step: c.step || 'any', class: 'ctl-num' });
    const shown = el('span', { class: 'ctl-eng mono' });
    const useSlider = /slider|dial/.test(c.widget || '');
    const useCounter = /counter/.test(c.widget || '') || c.widget === 'eng';
    const useEng = /eng/.test(c.widget || '');
    this.slider = useSlider ? slider : null;
    this.number = useCounter || !useSlider ? number : null;
    this.shown = useEng ? shown : null;
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      if (this.number) this.number.value = fmt(v, c.int);
      if (this.shown) this.shown.textContent = eng(v);
      this.sendThrottled(v);
    });
    number.addEventListener('change', () => {
      const v = parseFloat(number.value);
      if (!Number.isNaN(v)) this.send('value', v);
    });
    number.addEventListener('keydown', (e) => { if (e.key === 'Enter') number.dispatchEvent(new Event('change')); });
    this.node.append(label);
    if (this.slider) this.node.append(slider);
    if (this.number) this.node.append(number);
    if (this.shown) this.node.append(shown);
    if (c.min_len && this.slider) this.slider.style[c.vertical ? 'minHeight' : 'minWidth'] = Math.min(c.min_len, 400) + 'px';
    this.update();
  }

  update() {
    if (this.val === null) return;
    const v = Number(this.val);
    if (this.slider && document.activeElement !== this.slider) this.slider.value = v;
    if (this.number && document.activeElement !== this.number) this.number.value = fmt(v, this.cfg.int);
    if (this.shown) this.shown.textContent = eng(v);
  }
}

// ---------------------------------------------------------------- chooser
export class ChooserControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'chooser'); }

  render() {
    const c = this.cfg;
    this.node.textContent = '';
    this.node.append(el('span', { class: 'ctl-label' }, c.label));
    const labels = c.labels || [];
    if (c.widget === 'radio_buttons') {
      const group = el('div', { class: 'radios' + (c.vertical ? ' vertical' : '') });
      this.radios = labels.map((label, i) => {
        const input = el('input', { type: 'radio', name: 'r-' + this.name, value: i });
        input.addEventListener('change', () => this.send('value', i));
        group.append(el('label', {}, input, label));
        return input;
      });
      this.select = null;
      this.node.append(group);
    } else {
      this.select = el('select', {}, ...labels.map((label, i) => el('option', { value: i }, label)));
      this.select.addEventListener('change', () => this.send('value', parseInt(this.select.value, 10)));
      this.radios = null;
      this.node.append(this.select);
    }
    this.update();
  }

  update() {
    if (this.val === null || this.val < 0) return;
    if (this.select) this.select.value = String(this.val);
    if (this.radios && this.radios[this.val]) this.radios[this.val].checked = true;
  }
}

// ---------------------------------------------------- check box & buttons
export class CheckControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'check'); }

  render() {
    this.node.textContent = '';
    this.box = el('input', { type: 'checkbox' });
    this.box.addEventListener('change', () => this.send('value', this.box.checked));
    this.node.append(el('label', {}, this.box, this.cfg.label));
    this.update();
  }

  update() { if (this.box && this.val !== null) this.box.checked = !!this.val; }
}

export class PushControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'push'); }

  render() {
    this.node.textContent = '';
    const b = el('button', { class: 'btn', type: 'button' }, this.cfg.label);
    let down = false;
    b.addEventListener('pointerdown', (e) => { down = true; b.setPointerCapture(e.pointerId); this.send('press', true); });
    const release = () => { if (down) { down = false; this.send('release', true); } };
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    this.node.append(b);
  }
}

export class MsgPushControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'push'); }

  render() {
    this.node.textContent = '';
    const [bg, fg] = this.cfg.colors || [];
    const b = el('button', { class: 'btn', type: 'button', style: { background: bg || '', color: fg || '' } }, this.cfg.label);
    b.addEventListener('click', () => this.send('press', true));
    this.node.append(b);
  }
}

export class ToggleControl extends Control {
  constructor(ctx, name, kind) { super(ctx, name, 'toggle ' + kind); this.kind = kind; }

  render() {
    this.node.textContent = '';
    const c = this.cfg;
    if (this.kind === 'msg_check_box') {
      this.input = el('input', { type: 'checkbox' });
      this.input.addEventListener('change', () => this.send('value', this.input.checked));
      this.node.append(el('label', {}, this.input, c.label));
    } else if (this.kind === 'toggle_switch') {
      this.input = el('input', { type: 'checkbox', class: 'switch' });
      this.input.addEventListener('change', () => this.send('value', this.input.checked));
      this.node.append(el('label', { class: 'switch-wrap' }, this.input, el('span', { class: 'switch-ui' }), c.label));
    } else {
      this.button = el('button', { class: 'btn toggle-btn', type: 'button' }, c.label);
      this.button.addEventListener('click', () => this.send('value', !this.val));
      this.node.append(this.button);
    }
    this.update();
  }

  update() {
    const on = !!this.val;
    if (this.input) this.input.checked = on;
    if (this.button) {
      this.button.classList.toggle('on', on);
      const colors = this.cfg.colors || [];
      this.button.style.background = (on ? colors[2] : colors[0]) || '';
      this.button.style.color = (on ? colors[3] : colors[1]) || '';
    }
  }
}

// ------------------------------------------------------------ text entry
export class EntryControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'entry'); }

  render() {
    this.node.textContent = '';
    this.input = el('input', { class: 'mono', spellcheck: 'false' });
    const commit = () => this.send('value', this.input.value);
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); this.input.blur(); } });
    this.input.addEventListener('change', commit);
    this.node.append(el('span', { class: 'ctl-label' }, this.cfg.label + ':'), this.input);
    this.update();
  }

  update() { if (this.input && this.val !== null && document.activeElement !== this.input) this.input.value = this.val; }
}

export class LabelControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'label-ctl'); }

  render() {
    this.node.textContent = '';
    this.text = el('span', { class: 'mono ctl-value' });
    this.node.append(el('span', { class: 'ctl-label' }, this.cfg.label), this.text);
    this.update();
  }

  update() { if (this.text) this.text.textContent = this.val === null ? '' : String(this.val); }
}

// ---------------------------------------------------------------- dial
function arcPath(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
}

export class DialControl extends Control {
  constructor(ctx, name, { readonly = false } = {}) {
    super(ctx, name, 'dial');
    this.readonly = readonly;
    this.sendThrottled = throttle((v) => this.send('value', v), 60);
  }

  render() {
    this.node.textContent = '';
    const svg = svgEl('svg', { viewBox: '0 0 120 100', class: 'dial-svg' });
    this.track = svgEl('path', { d: arcPath(60, 58, 42, Math.PI * 0.75, Math.PI * 2.25), class: 'dial-track' });
    this.fill = svgEl('path', { class: 'dial-fill' });
    this.knob = svgEl('line', { x1: 60, y1: 58, x2: 60, y2: 20, class: 'dial-needle' });
    this.text = svgEl('text', { x: 60, y: 92, 'text-anchor': 'middle', class: 'dial-text' });
    svg.append(this.track, this.fill, this.knob, svgEl('circle', { cx: 60, cy: 58, r: 5, class: 'dial-hub' }), this.text);
    this.node.append(el('div', { class: 'ctl-label' }, this.cfg.label), svg);
    if (!this.readonly) {
      const pick = (e) => {
        const r = svg.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width * 120 - 60;
        const y = (e.clientY - r.top) / r.height * 100 - 58;
        let a = Math.atan2(y, x);
        if (a < Math.PI * 0.75 - Math.PI) a += Math.PI * 2;
        let t = (a - Math.PI * 0.75) / (Math.PI * 1.5);
        t = Math.min(1, Math.max(0, t));
        let v = this.cfg.min + t * (this.cfg.max - this.cfg.min);
        if (this.cfg.int) v = Math.round(v);
        this.val = v;
        this.update();
        this.sendThrottled(v);
      };
      svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); pick(e); svg.addEventListener('pointermove', pick); });
      svg.addEventListener('pointerup', () => svg.removeEventListener('pointermove', pick));
      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = (this.cfg.max - this.cfg.min) / (this.cfg.int ? Math.max(1, this.cfg.max - this.cfg.min) : 100);
        let v = Number(this.val || 0) + (e.deltaY < 0 ? step : -step);
        v = Math.min(this.cfg.max, Math.max(this.cfg.min, v));
        this.val = v;
        this.update();
        this.sendThrottled(v);
      }, { passive: false });
    }
    this.update();
  }

  update() {
    if (!this.fill) return;
    const c = this.cfg;
    const v = Number(this.val === null ? c.min : this.val);
    const t = Math.min(1, Math.max(0, (v - c.min) / ((c.max - c.min) || 1)));
    const a = Math.PI * 0.75 + t * Math.PI * 1.5;
    this.fill.setAttribute('d', t > 0.001 ? arcPath(60, 58, 42, Math.PI * 0.75, a) : '');
    if (c.colors && c.colors[0]) this.fill.style.stroke = c.colors[0];
    this.knob.setAttribute('x2', 60 + 36 * Math.cos(a));
    this.knob.setAttribute('y2', 58 + 36 * Math.sin(a));
    this.text.textContent = (c.show !== false || this.readonly) ? fmt(v, c.int) : '';
  }
}

// ------------------------------------------------------------ level gauge
export class LevelGauge extends Control {
  constructor(ctx, name) { super(ctx, name, 'levelgauge'); }

  render() {
    this.node.textContent = '';
    const c = this.cfg;
    const [bar, bg, font] = c.colors || [];
    this.bar = el('div', { class: 'gauge-bar', style: { background: bar || '' } });
    this.box = el('div', { class: 'gauge' + (c.vertical ? ' vertical' : ''), style: { background: bg || '' } }, this.bar);
    this.text = el('span', { class: 'mono', style: { color: font || '' } });
    this.node.append(el('div', { class: 'ctl-label' }, c.label), this.box);
    if (c.show) this.node.append(this.text);
    this.update();
  }

  update() {
    if (!this.bar) return;
    const c = this.cfg;
    const v = Number(this.val || 0);
    const t = Math.min(1, Math.max(0, (v - c.min) / ((c.max - c.min) || 1))) * 100;
    if (c.vertical) { this.bar.style.height = t + '%'; this.bar.style.width = '100%'; } else { this.bar.style.width = t + '%'; this.bar.style.height = '100%'; }
    this.text.textContent = fmt(v);
  }
}

// ------------------------------------------------------------------ LED
export class LedControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'led'); }

  render() {
    this.node.textContent = '';
    const size = Math.min(this.cfg.size || 40, 80);
    this.dot = el('span', { class: 'led-dot', style: { width: size + 'px', height: size + 'px' } });
    this.node.append(this.dot, el('span', { class: 'ctl-label' }, this.cfg.label));
    this.update();
  }

  update() {
    if (!this.dot) return;
    const on = !!this.val;
    this.dot.style.background = on ? (this.cfg.on || '#2ecc40') : (this.cfg.off || '#ff3b30');
    this.dot.classList.toggle('on', on);
  }
}

// --------------------------------------------------------------- compass
export class CompassControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'compass'); }

  render() {
    this.node.textContent = '';
    const svg = svgEl('svg', { viewBox: '-60 -60 120 120', class: 'compass-svg' });
    svg.append(svgEl('circle', { r: 52, class: 'compass-ring' }));
    for (let a = 0; a < 360; a += 30) {
      const r = a * Math.PI / 180;
      svg.append(svgEl('line', { x1: 46 * Math.sin(r), y1: -46 * Math.cos(r), x2: 52 * Math.sin(r), y2: -52 * Math.cos(r), class: 'compass-tick' }));
    }
    for (const [t, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const r = a * Math.PI / 180;
      svg.append(svgEl('text', { x: 36 * Math.sin(r), y: -36 * Math.cos(r) + 4, 'text-anchor': 'middle', class: 'compass-text' }, t));
    }
    this.needle = svgEl('g');
    this.needle.append(svgEl('polygon', { points: '0,-44 5,0 -5,0', fill: this.cfg.tip || '#ff3b30' }),
      svgEl('polygon', { points: '0,30 5,0 -5,0', fill: this.cfg.body || '#888' }));
    this.text = svgEl('text', { y: 22, 'text-anchor': 'middle', class: 'compass-text' });
    svg.append(this.needle, svgEl('circle', { r: 4, class: 'dial-hub' }), this.text);
    this.node.append(el('div', { class: 'ctl-label' }, this.cfg.label), svg);
    this.update();
  }

  update() {
    if (!this.needle) return;
    const a = Number(this.val || 0);
    this.needle.setAttribute('transform', `rotate(${a})`);
    this.text.textContent = a.toFixed(1) + '°';
  }
}

// --------------------------------------------------------- distance radar
export class RadarControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'radar'); }

  render() {
    this.node.textContent = '';
    const [bg, font, ring] = this.cfg.colors || [];
    const svg = svgEl('svg', { viewBox: '-60 -60 120 70', class: 'radar-svg', style: { background: bg || '' } });
    const ticks = this.cfg.ticks && this.cfg.ticks.length ? this.cfg.ticks : ['20', '40', '60', '80', '100'];
    this.max = parseFloat(ticks[ticks.length - 1]) || 100;
    ticks.forEach((t, i) => {
      const r = 50 * (i + 1) / ticks.length;
      svg.append(svgEl('path', { d: `M${-r},0 A${r},${r} 0 0 1 ${r},0`, class: 'radar-ring', style: { stroke: font || '' } }),
        svgEl('text', { x: r - 1, y: 6, class: 'radar-text', style: { fill: font || '' } }, t));
    });
    this.ring = svgEl('path', { class: 'radar-value', style: { stroke: ring || '#ff3b30' } });
    svg.append(this.ring);
    this.node.append(el('div', { class: 'ctl-label' }, this.cfg.label), svg);
    this.update();
  }

  update() {
    if (!this.ring) return;
    const r = Math.max(0, Math.min(52, 50 * Number(this.val || 0) / this.max));
    this.ring.setAttribute('d', r > 0 ? `M${-r},0 A${r},${r} 0 0 1 ${r},0` : '');
  }
}

// ---------------------------------------------------------- az/el plot
export class AzElControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'azel'); }

  render() {
    this.node.textContent = '';
    const svg = svgEl('svg', { viewBox: '-62 -62 124 136', class: 'compass-svg', style: { background: this.cfg.background || '' } });
    for (const el_ of [90, 60, 30]) svg.append(svgEl('circle', { r: 50 * (90 - el_ + 0.0001) / 90 || 0.1, class: 'compass-ring' }));
    svg.append(svgEl('circle', { r: 50, class: 'compass-ring' }));
    for (const [t, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const r = a * Math.PI / 180;
      svg.append(svgEl('text', { x: 56 * Math.sin(r), y: -56 * Math.cos(r) + 3, 'text-anchor': 'middle', class: 'compass-text' }, t));
    }
    const colors = { b: '#1f77ff', g: '#2ecc40', r: '#ff3b30', c: '#00d0e0', m: '#ff40ff', y: '#ffd400', k: '#000', w: '#fff' };
    this.dot = svgEl('circle', { r: 4, fill: colors[(this.cfg.dot || 'ro')[0]] || '#ff3b30' });
    this.text = svgEl('text', { y: 70, 'text-anchor': 'middle', class: 'compass-text' });
    svg.append(this.dot, this.text);
    this.node.append(el('div', { class: 'ctl-label' }, this.cfg.label), svg);
    this.update();
  }

  update() {
    if (!this.dot) return;
    if (!this.val) { this.dot.setAttribute('visibility', 'hidden'); return; }
    const { az, el: elev } = this.val;
    const r = 50 * (90 - elev) / 90;
    const a = az * Math.PI / 180;
    this.dot.setAttribute('visibility', 'visible');
    this.dot.setAttribute('cx', r * Math.sin(a));
    this.dot.setAttribute('cy', -r * Math.cos(a));
    this.text.textContent = `az ${az.toFixed(1)}° el ${elev.toFixed(1)}°`;
  }
}

// ------------------------------------------------ digital number control
export class DigitalNumberControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'dignum'); }

  render() {
    this.node.textContent = '';
    const [bg, fg] = this.cfg.colors || [];
    this.digits = el('div', { class: 'dignum-digits mono', style: { background: bg || '', color: fg || '' }, tabindex: 0 });
    this.node.append(this.cfg.label ? el('span', { class: 'ctl-label' }, this.cfg.label) : null, this.digits);
    this.digits.addEventListener('wheel', (e) => {
      if (this.cfg.readonly) return;
      const d = e.target.closest('[data-p]');
      if (!d) return;
      e.preventDefault();
      this._change(Number(d.dataset.p) * (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    this.digits.addEventListener('click', (e) => {
      if (this.cfg.readonly) return;
      const d = e.target.closest('[data-p]');
      if (!d) return;
      const r = d.getBoundingClientRect();
      this._change(Number(d.dataset.p) * (e.clientY < r.top + r.height / 2 ? 1 : -1));
    });
    this.digits.addEventListener('dblclick', () => {
      if (this.cfg.readonly) return;
      const input = el('input', { type: 'number', value: this.val || 0, class: 'mono', style: { width: '160px' } });
      this.digits.replaceWith(input);
      input.focus();
      const done = () => { input.replaceWith(this.digits); const v = parseFloat(input.value); if (!Number.isNaN(v)) this.send('value', v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      input.addEventListener('blur', done, { once: true });
    });
    this.update();
  }

  _change(delta) {
    const v = Math.min(this.cfg.max, Math.max(this.cfg.min, Number(this.val || 0) + delta));
    this.val = v;
    this.update();
    this.send('value', v);
  }

  update() {
    if (!this.digits) return;
    const v = Math.round(Number(this.val || 0));
    const width = Math.max(String(Math.round(this.cfg.max || 0)).length, 1);
    const s = String(Math.abs(v)).padStart(width, '0');
    this.digits.textContent = '';
    for (let i = 0; i < s.length; i++) {
      const place = s.length - 1 - i;
      if (i > 0 && place % 3 === 2) this.digits.append(el('span', { class: 'sep' }, this.cfg.sep || ','));
      this.digits.append(el('span', { class: 'dg', dataset: { p: 10 ** place } }, s[i]));
    }
    this.digits.append(el('span', { class: 'unit' }, ' Hz'));
  }
}

// ---------------------------------------------------------- edit box msg
export class EditBoxControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'editbox'); }

  render() {
    this.node.textContent = '';
    const c = this.cfg;
    this.key = el('input', { class: 'mono', value: c.key || '', readOnly: c.static, style: { width: '110px' } });
    this.input = el('input', { class: 'mono', spellcheck: 'false' });
    const submit = el('button', { class: 'btn small', type: 'button' }, 'Submit');
    const go = () => this.send('submit', { key: this.key.value, value: this.input.value });
    submit.addEventListener('click', go);
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    this.node.append(c.label ? el('span', { class: 'ctl-label' }, c.label) : null, c.pair ? this.key : null, this.input, submit);
    this.update();
  }

  update() {
    if (!this.input || !this.val) return;
    if (this.val.key && !this.cfg.static) this.key.value = this.val.key;
    if (document.activeElement !== this.input) this.input.value = this.val.value;
  }
}

// ------------------------------------------------------------ number sink
export class NumberView extends Control {
  constructor(ctx, name) { super(ctx, name, 'number'); }

  render() {
    this.node.textContent = '';
    const c = this.cfg;
    if (c.title) this.node.append(el('div', { class: 'plot-title' }, c.title));
    this.rows = (c.rows || []).map((row) => {
      const value = el('span', { class: 'num-value mono' });
      const bar = el('div', { class: 'num-bar-fill' });
      const box = el('div', { class: 'num-bar' + (c.graph === 'vert' ? ' vertical' : '') + (c.graph === 'none' ? ' hidden' : '') }, bar);
      this.node.append(el('div', { class: 'num-row' }, el('span', { class: 'ctl-label' }, row.label), box, value));
      return { value, bar, row };
    });
    this.lo = c.min;
    this.hi = c.max;
  }

  frame(h) {
    const c = this.cfg;
    (h.values || []).forEach((v, i) => {
      const r = this.rows && this.rows[i];
      if (!r) return;
      const scaled = v * (r.row.factor || 1);
      r.value.textContent = `${+scaled.toPrecision(5)} ${r.row.unit || ''}`;
      if (c.autoscale) { this.lo = Math.min(this.lo, scaled); this.hi = Math.max(this.hi, scaled); }
      const t = Math.min(1, Math.max(0, (scaled - this.lo) / ((this.hi - this.lo) || 1)));
      const dark = document.documentElement.dataset.theme === 'dark';
      const fix = (c) => (dark && (c === '#000000' || c === 'black') ? '#d0d4dc' : c);
      const [c0, c1] = (r.row.colors || []).map(fix);
      if (c.graph === 'vert') r.bar.style.height = (t * 100) + '%'; else r.bar.style.width = (t * 100) + '%';
      r.bar.style.background = c0 && c1 && c0 !== c1 ? `linear-gradient(90deg, ${c0}, ${c1})` : (c0 || '');
    });
  }
}

// ----------------------------------------------------------- graphic item
export class ImageControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'image'); this.url = null; }

  render() {
    this.node.textContent = '';
    this.img = el('img', { alt: '' });
    if (this.cfg.fixed && this.cfg.width) { this.img.style.width = this.cfg.width + 'px'; this.img.style.height = this.cfg.height + 'px'; }
    if (this.url) this.img.src = this.url;
    this.node.append(this.img);
  }

  frame(h, payload) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(new Blob([payload], { type: h.mime || 'image/png' }));
    if (this.img) this.img.src = this.url;
  }
}

export class FallbackControl extends Control {
  constructor(ctx, name) { super(ctx, name, 'fallback'); }

  render() {
    this.node.textContent = '';
    this.node.append(el('div', {}, el('b', {}, this.cfg.label || this.name)),
      el('div', { class: 'muted' }, 'This Qt widget has no web version yet. The flow graph runs, but nothing is shown here.'));
  }
}

export const CONTROLS = {
  range: RangeControl, chooser: ChooserControl, check_box: CheckControl, push_button: PushControl,
  msg_push_button: MsgPushControl, entry: EntryControl, label: LabelControl,
  toggle_button: (ctx, n) => new ToggleControl(ctx, n, 'toggle_button'),
  toggle_switch: (ctx, n) => new ToggleControl(ctx, n, 'toggle_switch'),
  msg_check_box: (ctx, n) => new ToggleControl(ctx, n, 'msg_check_box'),
  dial: DialControl, dial_gauge: (ctx, n) => new DialControl(ctx, n, { readonly: true }),
  level_gauge: LevelGauge, led: LedControl, compass: CompassControl, distance_radar: RadarControl,
  azel: AzElControl, digital_number: DigitalNumberControl, edit_box_msg: EditBoxControl,
  number: NumberView, graphic_item: ImageControl, fallback: FallbackControl,
};

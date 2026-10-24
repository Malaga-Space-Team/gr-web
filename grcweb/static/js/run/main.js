// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// Run window: lays out the GUI blocks of a running flow graph (GUI hints and
// tab widgets, like the Qt window) and feeds them with live data.
'use strict';

import { Api, logout } from '../common/api.js';
import { el, iconButton, initTheme, toggleTheme, toast, confirmDialog } from '../common/ui.js';
import { VIEWS } from './views.js';
import { rendererName } from './plots.js';
import { CONTROLS } from './controls.js';

const PLOTS = new Set(['time', 'freq', 'waterfall', 'raster', 'const', 'histogram', 'vector', 'autocorr', 'eye', 'combo']);

class RunPage {
  constructor() {
    initTheme();
    const params = new URLSearchParams(location.search);
    this.runId = params.get('id');
    this.embedded = params.has('embed');
    document.body.classList.toggle('embedded', this.embedded);
    this.api = new Api();
    this.items = new Map();
    this.configs = new Map();
    this.values = new Map();
    this.manifest = null;
    this.info = null;
    this.bytes = 0;
    this.frames = 0;
    this.paused = false;
    this.main = document.getElementById('main');
    this.consoleBox = document.getElementById('console-box');
    this.consoleEl = document.getElementById('console');
    document.getElementById('console-close').addEventListener('click', () => this.consoleBox.classList.add('hidden'));
    this._header();
    this._bind();
    this.api.connect();
    setInterval(() => this._stats(), 1000);
    window.addEventListener('storage', (e) => {
      if (e.key === 'grcweb.theme') { initTheme(); window.dispatchEvent(new CustomEvent('themechange')); }
    });
  }

  _header() {
    const head = document.getElementById('head');
    this.titleEl = el('span', { class: 'title' }, 'Flow graph');
    this.badge = el('span', { class: 'badge' }, '…');
    this.statEl = el('span', { class: 'stat' });
    this.pauseBtn = iconButton('pause', 'Pause / resume all plots', () => this.pauseAll());
    this.stopBtn = iconButton('stop', 'Kill the flow graph', () => this.stop(), 'stop');
    head.append(this.titleEl, this.badge, el('span', { class: 'sp' }), this.statEl, this.pauseBtn,
      iconButton('panel', 'Show output', () => { this.consoleBox.classList.toggle('hidden'); this._scrollConsole(); }),
      this.stopBtn);
    if (!this.embedded) {
      head.append(iconButton('theme', 'Light/dark theme', () => toggleTheme()), iconButton('logout', 'Sign out', () => logout()));
    }
  }

  _bind() {
    const api = this.api;
    api.frameHandler = (h, payload) => {
      if (h.run !== this.runId) return;
      this.bytes += payload.byteLength;
      this.frames++;
      const item = this.items.get(h.name);
      if (item) item.frame(h, payload);
    };
    api.on('open', () => this.subscribe());
    api.on('close', () => { this.badge.textContent = 'offline'; this.badge.className = 'badge failed'; });
    api.on('run.item', ({ run, name, config }) => {
      if (run !== this.runId) return;
      const first = !this.configs.has(name);
      this.configs.set(name, config);
      const item = this.items.get(name);
      if (item) {
        item.config(config);
        if (first && this.values.has(name)) item.value(this.values.get(name));
      }
    });
    api.on('run.value', ({ run, name, value }) => {
      if (run !== this.runId) return;
      this.values.set(name, value);
      const item = this.items.get(name);
      if (item && this.configs.has(name)) item.value(value);
    });
    api.on('run.console', ({ run, lines }) => { if (run === this.runId) this._console(lines); });
    api.on('run.state', ({ run, info }) => { if (run === this.runId) this._state(info); });
  }

  async subscribe() {
    if (!this.runId) { this._note('No flow graph selected.'); return; }
    let snap;
    try {
      snap = await this.api.call('run.subscribe', { run: this.runId });
    } catch (err) {
      this._note('This flow graph is not running any more.\n' + err.message);
      this.badge.textContent = 'gone';
      return;
    }
    this.manifest = snap.manifest;
    for (const [name, config] of Object.entries(snap.items)) this.configs.set(name, config);
    for (const [name, value] of Object.entries(snap.values)) this.values.set(name, value);
    this.consoleEl.textContent = '';
    this._console(snap.console);
    this._state(snap.info);
    this._build();
  }

  _note(text) {
    this.main.textContent = '';
    this.main.append(el('div', { class: 'run-note' }, text));
  }

  _state(info) {
    this.info = info;
    this.titleEl.textContent = info.title;
    document.title = info.title + ' — GRC Web';
    this.badge.className = 'badge ' + info.state;
    this.badge.textContent = info.state === 'exited' || info.state === 'failed' ? `${info.state} (${info.exit_code})` : info.state;
    this.stopBtn.disabled = !(info.state === 'running' || info.state === 'starting');
    if (info.state === 'failed') this.consoleBox.classList.remove('hidden');
  }

  _console(lines) {
    for (const line of lines) {
      const cls = line.s === 'grc' ? 'grc' : /error|traceback|exception/i.test(line.t) ? 'err' : /warn/i.test(line.t) ? 'warn' : '';
      this.consoleEl.append(cls ? el('span', { class: cls }, line.t + '\n') : line.t + '\n');
    }
    while (this.consoleEl.childNodes.length > 3000) this.consoleEl.firstChild.remove();
    this._scrollConsole();
  }

  _scrollConsole() { this.consoleEl.scrollTop = this.consoleEl.scrollHeight; }

  _stats() {
    const rate = this.bytes * 8;
    this.statEl.textContent = this.frames
      ? `${rate > 1e6 ? (rate / 1e6).toFixed(2) + ' Mbit/s' : (rate / 1e3).toFixed(0) + ' kbit/s'} · ${this.frames} frames/s`
      : '';
    this.statEl.title = 'Plots drawn with ' + rendererName();
    this.bytes = 0;
    this.frames = 0;
  }

  // ------------------------------------------------------------- layout
  _build() {
    for (const item of this.items.values()) item.destroy();
    this.items.clear();
    this.main.textContent = '';
    const m = this.manifest;
    if (!m || !Object.keys(m.items || {}).length) {
      this._note('This flow graph has no GUI blocks.\nIts output is shown below.');
      this.consoleBox.classList.remove('hidden');
      return;
    }
    const root = this._container('main');
    root.classList.add('fill');
    this.main.append(root);
  }

  _ctx() {
    return { send: (name, event, data) => this.api.send('run.ui', { run: this.runId, name, event, data }) };
  }

  _createItem(name) {
    const meta = this.manifest.items[name];
    if (!meta) return null;
    if (meta.impl === 'tabs') return this._tabs(name);
    const factory = VIEWS[meta.impl] || CONTROLS[meta.impl] || CONTROLS.fallback;
    const item = factory.prototype ? new factory(this._ctx(), name) : factory(this._ctx(), name);
    this.items.set(name, item);
    // the runtime describes each item once it is created; until then it stays empty
    if (this.configs.has(name)) {
      item.config(this.configs.get(name));
      if (this.values.has(name)) item.value(this.values.get(name));
    }
    if (this.paused && item.plot) item.plot.setPaused(true);
    return item.node;
  }

  _isBig(name) {
    const meta = this.manifest.items[name];
    if (!meta) return false;
    if (meta.impl === 'tabs') return true;
    return PLOTS.has(meta.impl);
  }

  _container(key) {
    const box = el('div', { class: 'container' });
    const c = this.manifest.containers[key] || { grid: [], stack: [] };
    if (c.grid.length) {
      let nrows = 0, ncols = 0;
      for (const g of c.grid) { nrows = Math.max(nrows, g.row + g.rowspan); ncols = Math.max(ncols, g.col + g.colspan); }
      const big = new Array(nrows).fill(false);
      for (const g of c.grid) if (this._isBig(g.name)) for (let r = g.row; r < g.row + g.rowspan; r++) big[r] = true;
      const grid = el('div', { class: 'grid' });
      grid.style.gridTemplateColumns = `repeat(${ncols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = big.map((b) => (b ? 'minmax(240px, 1fr)' : 'auto')).join(' ');
      if (big.some(Boolean)) {
        grid.style.flex = '1';
        grid.style.minHeight = big.filter(Boolean).length * 240 + 'px';
      }
      for (const g of c.grid) {
        const node = this._createItem(g.name);
        if (!node) continue;
        node.style.gridRow = `${g.row + 1} / span ${g.rowspan}`;
        node.style.gridColumn = `${g.col + 1} / span ${g.colspan}`;
        grid.append(node);
      }
      box.append(grid);
    }
    if (c.stack.length) {
      const stack = el('div', { class: 'stack' });
      for (const name of c.stack) {
        const node = this._createItem(name);
        if (node) stack.append(node);
      }
      box.append(stack);
    }
    if (!c.grid.length && c.stack.length === 1 && this._isBig(c.stack[0])) {
      box.classList.add('fill');
      box.firstChild.style.flex = '1';
      box.firstChild.firstChild.style.flex = '1';
      box.firstChild.firstChild.style.height = 'auto';
    }
    return box;
  }

  _tabs(name) {
    const labels = (this.manifest.tabs[name] || {}).labels || [];
    const bar = el('div', { class: 'tabbar' });
    const pages = el('div', { class: 'tabpages' });
    const node = el('div', { class: 'item tabs-item' }, bar, pages);
    const buttons = [];
    const show = (i) => {
      buttons.forEach((b, k) => b.classList.toggle('on', k === i));
      [...pages.children].forEach((p, k) => p.classList.toggle('hidden', k !== i));
    };
    labels.forEach((label, i) => {
      const b = el('button', { type: 'button' }, label);
      b.addEventListener('click', () => show(i));
      buttons.push(b);
      bar.append(b);
      const page = el('div', { class: 'tabpage' }, this._container(`${name}@${i}`));
      page.firstChild.classList.add('fill');
      pages.append(page);
    });
    show(0);
    return node;
  }

  pauseAll() {
    this.paused = !this.paused;
    for (const item of this.items.values()) {
      if (item.plot) item.plot.setPaused(this.paused);
      if (item.plots) item.plots.forEach((p) => p.setPaused(this.paused));
      if (item.views) Object.values(item.views).forEach((v) => v.plot && v.plot.setPaused(this.paused));
    }
    this.pauseBtn.classList.toggle('on', this.paused);
  }

  async stop() {
    if (!this.info) return;
    if (!(await confirmDialog('Kill flow graph', `Stop "${this.info.title}"?`, 'Stop', true))) return;
    try { await this.api.call('run.stop', { run: this.runId }); } catch (err) { toast(err.message, 'err'); }
  }
}

window.runPage = new RunPage();

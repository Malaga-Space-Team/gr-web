// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// GRC Web editor: documents, toolbar, panels and keyboard shortcuts.
'use strict';

import { Api, logout } from '../common/api.js';
import {
  el, icon, iconButton, toast, modal, confirmDialog, choiceDialog, contextMenu,
  initTheme, toggleTheme, isTyping, hideTooltip,
} from '../common/ui.js';
import { Canvas } from './canvas.js';
import { Library } from './library.js';
import { openProps } from './props.js';
import { chooseFile } from './files.js';
import { RunWindow } from './runwin.js';
import { Terminals } from './terminals.js';

class Doc {
  constructor(state) {
    this.id = state.doc;
    this.view = { tx: 0, ty: 0, scale: 1, initialized: false };
    this.selection = new Set();
    this.load(state);
  }

  load(state) {
    this.meta = state.meta;
    this.version = state.version;
    this.blocks = new Map(state.blocks.map((b) => [b.name, b]));
    this.conns = new Map(state.connections.map((c) => [c.id, c]));
  }

  applyPatch(patch) {
    for (const name of patch.removed_blocks || []) this.blocks.delete(name);
    for (const id of patch.removed_connections || []) this.conns.delete(id);
    for (const b of patch.blocks || []) this.blocks.set(b.name, b);
    for (const c of patch.connections || []) this.conns.set(c.id, c);
    if (patch.meta) this.meta = patch.meta;
    this.version = patch.version;
  }
}

class App {
  constructor() {
    initTheme();
    this.api = new Api();
    this.docs = new Map();
    this.active = null;
    this.user = '';
    this.admin = false;
    this.runs = [];
    this.runWindows = new Map();
    this.canvas = new Canvas(document.getElementById('canvas'), this);
    try { Object.assign(this.canvas.opts, JSON.parse(localStorage.getItem('grcweb.view') || '{}')); } catch (e) { /* ignore */ }
    this.library = new Library(document.getElementById('side'), this);
    this.consoleEl = document.getElementById('console');
    this.varsEl = document.getElementById('vars');
    this.statusEl = document.getElementById('status');
    this.tabsEl = document.getElementById('tabs');
    this.terminals = new Terminals(this);
    this._buildToolbar();
    this._buildHud();
    this._bindPanels();
    this._bindKeys();
    this._bindApi();
    this.api.connect();
    this.library.load().catch((err) => toast(err.message, 'err'));
    window.addEventListener('beforeunload', (e) => {
      if ([...this.docs.values()].some((d) => d.meta.dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ------------------------------------------------------------ server
  _bindApi() {
    const api = this.api;
    api.on('open', async () => {
      this.status();
      try {
        const hello = await api.call('hello');
        this.user = hello.user;
        this.admin = hello.admin;
        this.runs = hello.runs;
        this.grVersion = hello.gr_version;
        const keep = this.active && this.active.id;
        const known = new Map(this.docs);
        this.docs.clear();
        for (const state of hello.docs) {
          const old = known.get(state.doc);
          const doc = new Doc(state);
          if (old) { doc.view = old.view; doc.selection = old.selection; }
          this.docs.set(doc.id, doc);
        }
        if (known.size && !hello.docs.length) this.log('>>> The server was restarted: unsaved changes were lost.\n', 'err');
        if (!this.docs.size) await this.newDoc();
        else this.activate(this.docs.get(keep) || this.docs.values().next().value);
        this.renderTabs();
        this.updateUser();
        this.updateRunButtons();
        this.terminals.sync(hello.terminal, hello.terminals);
        this.btn.term.classList.toggle('hidden', !hello.terminal);
        if (!this._welcomed) {
          this._welcomed = true;
          this.log(`<<< Welcome to GRC Web — GNU Radio ${hello.gr_version} >>>\n`, 'grc');
        }
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    api.on('close', () => { this.status(); toast('Connection lost, reconnecting…', 'err'); });
    api.on('doc.patch', ({ patch }) => {
      const doc = this.docs.get(patch.doc);
      if (!doc) return;
      doc.applyPatch(patch);
      if (doc === this.active) {
        this.canvas.applyPatch(patch);
        if (patch.meta) { this.renderVars(); this.status(); this.updateToolbar(); }
      }
      if (patch.meta) this.renderTabs();
    });
    api.on('doc.opened', ({ state }) => {
      const existing = this.docs.get(state.doc);
      if (existing) {
        existing.load(state);
        if (existing === this.active) this.activate(existing);
      } else {
        this.docs.set(state.doc, new Doc(state));
      }
      this.renderTabs();
    });
    api.on('doc.closed', ({ doc }) => {
      if (!this.docs.has(doc)) return;
      this.docs.delete(doc);
      if (this.active && this.active.id === doc) this.activate(this.docs.values().next().value || null);
      this.renderTabs();
    });
    api.on('console', ({ text }) => this.log(text));
    api.on('runs', ({ runs }) => {
      const before = new Map(this.runs.map((r) => [r.id, r]));
      this.runs = runs;
      for (const run of runs) {
        const old = before.get(run.id);
        if (old && old.state !== run.state && run.owner === this.user && (run.state === 'exited' || run.state === 'failed')) {
          this.log(`>>> ${run.title}: ${run.state === 'failed' ? 'failed' : 'done'} (return code ${run.exit_code})\n`, run.state === 'failed' ? 'err' : 'grc');
        }
      }
      this.updateRunButtons();
      for (const win of this.runWindows.values()) win.update(runs.find((r) => r.id === win.run.id));
    });
    api.on('library', () => this.library.load());
  }

  async edit(action, args = {}, doc = this.active) {
    if (!doc) throw new Error('No flow graph open');
    try {
      return await this.api.call('doc.edit', { doc: doc.id, action, args });
    } catch (err) {
      toast(err.message, 'err');
      throw err;
    }
  }

  // ------------------------------------------------------------ documents
  activate(doc) {
    this.active = doc || null;
    this.canvas.setDoc(this.active);
    this.renderTabs();
    this.renderVars();
    this.status();
    this.updateToolbar();
    this.updateRunButtons();
    document.title = doc ? `${doc.meta.dirty ? '*' : ''}${doc.meta.title} — GRC Web` : 'GRC Web';
  }

  renderTabs() {
    this.tabsEl.textContent = '';
    for (const doc of this.docs.values()) {
      const tab = el('div', { class: 'tab' + (doc === this.active ? ' active' : ''), title: doc.meta.path || 'Not saved yet' },
        doc.meta.dirty ? el('span', { class: 'dirty' }, '●') : null,
        el('span', { class: 't' }, doc.meta.title),
        el('button', { class: 'x', type: 'button', title: 'Close' }, '×'));
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.x')) this.closeDoc(doc);
        else if (doc !== this.active) this.activate(doc);
      });
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) this.closeDoc(doc); });
      this.tabsEl.append(tab);
    }
    this.tabsEl.append(el('button', { class: 'tab-add', type: 'button', title: 'New flow graph (Ctrl+N)', onclick: () => this.newDoc() }, '+'));
    if (this.active) document.title = `${this.active.meta.dirty ? '*' : ''}${this.active.meta.title} — GRC Web`;
  }

  async newDoc() {
    try {
      const state = await this.api.call('doc.new');
      const doc = this.docs.get(state.doc) || new Doc(state);
      this.docs.set(doc.id, doc);
      this.activate(doc);
    } catch (err) { toast(err.message, 'err'); }
  }

  async openDoc(path) {
    if (!path) {
      path = await chooseFile(this, { mode: 'open', start: this.active && this.active.meta.path ? this.active.meta.path.replace(/[^/]*$/, '') : '' });
      if (!path) return;
    }
    try {
      const state = await this.api.call('doc.open', { path });
      let doc = this.docs.get(state.doc);
      if (!doc) { doc = new Doc(state); this.docs.set(doc.id, doc); }
      // replace an untouched empty tab, like GRC does
      for (const other of [...this.docs.values()]) {
        if (other !== doc && !other.meta.path && !other.meta.dirty && other.blocks.size <= 2) {
          await this.api.call('doc.close', { doc: other.id });
          this.docs.delete(other.id);
        }
      }
      this.activate(doc);
    } catch (err) { toast(err.message, 'err'); }
  }

  async closeDoc(doc) {
    if (doc.meta.dirty) {
      const answer = await choiceDialog('Unsaved changes', `Save changes to "${doc.meta.title}" before closing?`, [
        { label: 'Cancel', value: 'cancel', cancel: true },
        { label: 'Close without saving', value: 'discard', cls: 'danger' },
        { label: 'Save', value: 'save', cls: 'primary' },
      ]);
      if (!answer || answer === 'cancel') return;
      if (answer === 'save' && !(await this.save(doc))) return;
    }
    await this.api.call('doc.close', { doc: doc.id }).catch(() => {});
    this.docs.delete(doc.id);
    if (doc === this.active) this.activate(this.docs.values().next().value || null);
    if (!this.docs.size) this.newDoc();
    this.renderTabs();
  }

  async save(doc = this.active, saveAs = false) {
    if (!doc) return false;
    let path = doc.meta.path;
    if (!path || saveAs) {
      const fgId = doc.meta.fg_id || 'untitled';
      path = await chooseFile(this, {
        mode: 'save', defaultName: (doc.meta.path ? doc.meta.title : fgId) + (doc.meta.path ? '' : '.grc'),
        start: doc.meta.path ? doc.meta.path.replace(/[^/]*$/, '') : '',
      });
      if (!path) return false;
    }
    try {
      await this.api.call('doc.save', { doc: doc.id, path: saveAs || !doc.meta.path ? path : undefined });
      toast('Saved', 'ok', 1500);
      return true;
    } catch (err) {
      if (err.message === 'exists') {
        if (!(await confirmDialog('File exists', `${path}\nalready exists. Overwrite it?`, 'Overwrite', true))) return false;
        await this.api.call('doc.save', { doc: doc.id, path, overwrite: true });
        toast('Saved', 'ok', 1500);
        return true;
      }
      toast(err.message, 'err');
      return false;
    }
  }

  async generate(show = false) {
    const doc = this.active;
    if (!doc) return;
    if (!doc.meta.path) {
      toast('Save the flow graph first');
      if (!(await this.save(doc))) return;
    } else if (doc.meta.dirty) {
      await this.save(doc);
    }
    try {
      const result = await this.api.call('doc.generate', { doc: doc.id, show });
      toast('Generated ' + result.path, 'ok');
      if (show && result.code !== null) {
        modal({ title: 'Generated code', sub: result.path, cls: 'wide', body: el('pre', { class: 'doc' }, result.code), buttons: [{ label: 'Close', cls: 'primary', cancel: true }] });
      }
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---------------------------------------------------------------- runs
  activeRun() {
    if (!this.active) return null;
    return this.runs.find((r) => r.doc === this.active.id && r.owner === this.user && (r.state === 'running' || r.state === 'starting'));
  }

  async run() {
    const doc = this.active;
    if (!doc) return;
    if (this.activeRun()) { this.showRun(this.activeRun()); return; }
    if (doc.meta.n_errors) {
      toast(`The flow graph has ${doc.meta.n_errors} error(s)`, 'err');
      this.showErrors();
      return;
    }
    this.log(`>>> Running ${doc.meta.title}…\n`, 'grc');
    try {
      const run = await this.api.call('run.start', { doc: doc.id });
      if (!this.runs.find((r) => r.id === run.id)) this.runs.push(run);
      this.updateRunButtons();
      this.showRun(run);
    } catch (err) {
      this.log(err.message + '\n', 'err');
      toast(err.message.split('\n')[0], 'err');
    }
  }

  async stop(run = this.activeRun()) {
    if (!run) return;
    try { await this.api.call('run.stop', { run: run.id }); } catch (err) { toast(err.message, 'err'); }
  }

  showRun(run) {
    let win = this.runWindows.get(run.id);
    if (!win) {
      win = new RunWindow(this, run, () => this.runWindows.delete(run.id));
      this.runWindows.set(run.id, win);
    }
    win.raise();
  }

  runsMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const items = [];
    if (!this.runs.length) items.push(el('div', { class: 'muted', style: { padding: '8px 10px' } }, 'No flow graphs running'));
    for (const run of [...this.runs].reverse()) {
      const live = run.state === 'running' || run.state === 'starting';
      const canStop = live && (run.owner === this.user || this.admin);
      const row = el('div', { class: 'run-row' },
        el('div', {}, el('div', {}, run.title), el('div', { class: 'who' }, `${run.owner} · ${new Date(run.started * 1000).toLocaleTimeString()}`)),
        el('span', { class: 'badge ' + run.state }, run.state),
        el('div', { style: { display: 'flex', gap: '4px' } },
          el('button', { class: 'btn small', type: 'button', onclick: () => { this.showRun(run); } }, 'View'),
          canStop ? el('button', { class: 'btn small danger', type: 'button', onclick: () => this.stop(run) }, 'Stop') : null,
          !live ? el('button', { class: 'btn small', type: 'button', onclick: () => this.api.call('run.forget', { run: run.id }) }, '×') : null));
      items.push(row);
    }
    contextMenu(r.left, r.bottom + 4, items, 'runs-menu');
  }

  updateRunButtons() {
    const run = this.activeRun();
    if (this.btn) {
      this.btn.run.disabled = !this.active;
      this.btn.stop.disabled = !run;
      const live = this.runs.filter((r) => r.state === 'running' || r.state === 'starting').length;
      this.btn.runsLabel.textContent = live ? String(live) : '';
    }
  }

  // ------------------------------------------------------------ editing
  sel() { return this.canvas.doc ? this.canvas.selectedBlocks() : []; }

  async addBlock(key, x, y) {
    try {
      const name = await this.edit('add', { key, x, y });
      if (name) this.canvas.setSelection(['b:' + name]);
      this.focusCanvas();
    } catch (err) { /* toast already shown */ }
  }

  addBlockAtCenter(key) {
    const [cx, cy] = this.canvas.viewCenter();
    const [x, y] = this.freeSpot(cx - 80, cy - 40);
    this.addBlock(key, x, y);
  }

  // nearest place around (x, y) where a new block does not cover another one
  freeSpot(x, y, w = 200, h = 110) {
    const boxes = [...this.canvas.blockEls.values()].map(({ block, layout }) =>
      [block.x - 24, block.y - 24, block.x + layout.bw + 24, block.y + layout.bh + 24]);
    const free = (px, py) => boxes.every(([x0, y0, x1, y1]) => px + w < x0 || px > x1 || py + h < y0 || py > y1);
    for (let ring = 0; ring < 12; ring++) {
      const steps = Math.max(1, ring * 8);
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * 2 * Math.PI;
        const px = x + Math.cos(a) * ring * 60;
        const py = y + Math.sin(a) * ring * 45;
        if (free(px, py)) return [px, py];
      }
    }
    return [x, y];
  }

  openProps(name) {
    if (!this.active) return;
    hideTooltip();
    openProps(this, this.active, name);
  }

  async copy() { if (this.sel().length) await this.edit('copy', { names: this.sel() }); }

  async cut() { if (this.sel().length) await this.edit('cut', { names: this.sel() }); }

  async paste() {
    const [x, y] = this.canvas.pastePoint();
    const names = await this.edit('paste', { x, y }).catch(() => null);
    if (names && names.length) this.canvas.setSelection(names.map((n) => 'b:' + n));
  }

  async remove() {
    const names = this.sel();
    const connections = this.canvas.doc ? this.canvas.selectedConns() : [];
    if (names.length || connections.length) await this.edit('delete', { names, connections });
  }

  async setState(state) { if (this.sel().length) await this.edit('state', { names: this.sel(), state }); }

  async rotate(rotation) { if (this.sel().length) await this.edit('rotate', { names: this.sel(), rotation }); }

  focusCanvas() { this.canvas.svg.focus({ preventScroll: true }); }

  canvasMenu(x, y, kind) {
    const has = this.sel().length > 0;
    const items = [];
    if (kind === 'block') {
      const name = this.sel()[0];
      items.push({ label: 'Properties', shortcut: 'Dbl-click', action: () => this.openProps(name), disabled: this.sel().length !== 1 });
      items.push('-');
    }
    if (kind !== 'canvas') {
      items.push(
        { label: 'Enable', shortcut: 'E', action: () => this.setState('enabled'), disabled: !has },
        { label: 'Disable', shortcut: 'D', action: () => this.setState('disabled'), disabled: !has },
        { label: 'Bypass', shortcut: 'B', action: () => this.setState('bypassed'), disabled: !has },
        '-',
        { label: 'Rotate counterclockwise', shortcut: '←', action: () => this.rotate(90), disabled: !has },
        { label: 'Rotate clockwise', shortcut: '→', action: () => this.rotate(-90), disabled: !has },
        '-',
        { label: 'Cut', shortcut: 'Ctrl+X', action: () => this.cut(), disabled: !has },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => this.copy(), disabled: !has },
      );
    }
    items.push({ label: 'Paste', shortcut: 'Ctrl+V', action: () => this.paste() });
    if (kind !== 'canvas') items.push({ label: 'Delete', shortcut: 'Del', action: () => this.remove() });
    if (kind === 'canvas') {
      const opts = this.canvas.opts;
      const check = (on, label) => (on ? '✓ ' : '\u2003 ') + label;
      items.push('-',
        { label: 'Select all', shortcut: 'Ctrl+A', action: () => this.canvas.selectAll() },
        { label: 'Zoom to fit', shortcut: 'Ctrl+0', action: () => this.canvas.fit() },
        { label: 'Add block…', shortcut: 'Ctrl+F', action: () => this.library.focus() },
        '-',
        { label: check(opts.showExpr, 'Show parameter expressions'), action: () => this.setView('showExpr', !opts.showExpr) },
        { label: check(opts.showComments, 'Show block comments'), action: () => this.setView('showComments', !opts.showComments) },
        '-',
        { label: 'Export image (SVG)', action: () => this.exportImage('svg') },
        { label: 'Export image (PNG)', action: () => this.exportImage('png') });
    }
    contextMenu(x, y, items);
  }

  setView(key, value) {
    this.canvas.opts[key] = value;
    try { localStorage.setItem('grcweb.view', JSON.stringify(this.canvas.opts)); } catch (e) { /* ignore */ }
    this.canvas.redrawAll();
  }

  // the flow graph as a standalone SVG (styles resolved), optionally rasterized
  async exportImage(format) {
    const doc = this.active;
    const bounds = this.canvas.bounds();
    if (!doc || !bounds) return;
    const [x0, y0, x1, y1] = bounds;
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list;
      try { list = sheet.cssRules; } catch (e) { continue; }
      for (const rule of list) {
        if (rule.selectorText && /^\.(blk|conn)\b/.test(rule.selectorText)) rules.push(rule.cssText);
      }
    }
    const root = getComputedStyle(document.documentElement);
    const vars = ['--canvas-bg', '--block-bg', '--block-border', '--block-text', '--block-param', '--block-disabled',
      '--block-bypassed', '--block-deprecated', '--block-deprecated-border', '--block-missing', '--conn',
      '--conn-disabled', '--conn-error', '--select', '--comment', '--danger', '--sans']
      .map((v) => `${v}: ${root.getPropertyValue(v)};`).join(' ');
    const w = x1 - x0, h = y1 - y0;
    const body = this.canvas.blockLayer.parentNode.cloneNode(true);
    body.removeAttribute('transform');
    body.firstChild.remove(); // grid background
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${w} ${h}">` +
      `<style>svg { ${vars} } ${rules.join('\n')}</style>` +
      `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${root.getPropertyValue('--canvas-bg')}"/>` +
      new XMLSerializer().serializeToString(body) + '</svg>';
    const name = (doc.meta.fg_id || 'flowgraph');
    let blob = new Blob([svg], { type: 'image/svg+xml' });
    if (format === 'png') {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
      const scale = 2;
      const canvas = el('canvas', { width: w * scale, height: h * scale });
      canvas.getContext('2d').drawImage(img, 0, 0, w * scale, h * scale);
      URL.revokeObjectURL(url);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }
    const a = el('a', { href: URL.createObjectURL(blob), download: `${name}.${format}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  showHelp() {
    const rows = [
      ['Ctrl+N / Ctrl+O / Ctrl+S', 'New, open, save (Shift: save as)'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy, cut, paste (at the mouse position)'],
      ['Del', 'Delete the selection'],
      ['E / D / B', 'Enable, disable, bypass'],
      ['← / →', 'Rotate counterclockwise / clockwise'],
      ['↑ / ↓', 'Change the type of the block (e.g. complex/float)'],
      ['+ / −', 'More / fewer ports'],
      ['Enter, double click', 'Block properties'],
      ['Ctrl+F', 'Search blocks: ↑/↓ choose a result, Enter adds it'],
      ['F5 / F6 / F7', 'Generate, execute, kill'],
      ['Ctrl+` (key below Esc)', 'Go to the terminal (opens one) and back to the canvas'],
      ['Terminal: Ctrl+Shift+C, Ctrl+V', 'Copy (also Ctrl+C when text is selected), paste'],
      ['Wheel, Shift+wheel', 'Scroll'],
      ['Ctrl+wheel, Ctrl +/−', 'Zoom (Ctrl+0 fit, Ctrl+1 100%)'],
      ['Middle drag, Space+drag', 'Pan'],
      ['Drag on empty canvas', 'Select several blocks (Shift adds)'],
      ['Drag from a port to a port', 'Connect (or click one port, then the other)'],
      ['Plots: drag / right click', 'Zoom a box / reset zoom'],
      ['Plots: wheel, Shift+wheel', 'Zoom X / zoom Y; Shift+drag pans'],
      ['Frequency plots: double click', "Send the frequency on the 'freq' port"],
    ];
    const table = el('table', { class: 'help' }, rows.map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', {}, v))));
    modal({ title: 'Keyboard and mouse', body: table, buttons: [{ label: 'Close', cls: 'primary', cancel: true }] });
  }

  // ------------------------------------------------------------- UI bits
  _buildToolbar() {
    const bar = document.getElementById('topbar');
    const b = (name, title, fn, cls) => iconButton(name, title, () => fn(), cls);
    this.btn = {
      undo: b('undo', 'Undo (Ctrl+Z)', () => this.edit('undo').catch(() => {})),
      redo: b('redo', 'Redo (Ctrl+Y)', () => this.edit('redo').catch(() => {})),
      cut: b('cut', 'Cut (Ctrl+X)', () => this.cut()),
      copy: b('copy', 'Copy (Ctrl+C)', () => this.copy()),
      paste: b('paste', 'Paste (Ctrl+V)', () => this.paste()),
      del: b('del', 'Delete (Del)', () => this.remove()),
      rotl: b('rotl', 'Rotate counterclockwise (←)', () => this.rotate(90)),
      rotr: b('rotr', 'Rotate clockwise (→)', () => this.rotate(-90)),
      enable: b('enable', 'Enable (E)', () => this.setState('enabled')),
      disable: b('disable', 'Disable (D)', () => this.setState('disabled')),
      bypass: b('bypass', 'Bypass (B)', () => this.setState('bypassed')),
      run: b('run', 'Execute the flow graph (F6)', () => this.run(), 'run'),
      stop: b('stop', 'Kill the flow graph (F7)', () => this.stop(), 'stop'),
      term: b('term', 'Terminal (Ctrl+`)', () => this.terminals.toggle(), 'hidden'),
    };
    const runsBtn = el('button', { class: 'tb-btn', type: 'button', title: 'Running flow graphs', style: { width: 'auto', padding: '0 6px', display: 'inline-flex', gap: '3px' } },
      icon('runs'), this.btn.runsLabel = el('span', { style: { fontSize: '12px', fontWeight: 700, color: 'var(--ok)' } }));
    runsBtn.addEventListener('click', () => this.runsMenu(runsBtn));
    const sep = () => el('span', { class: 'tb-sep' });
    bar.append(
      el('div', { class: 'brand' }, 'GRC Web'),
      b('new', 'New flow graph (Ctrl+N)', () => this.newDoc()),
      b('open', 'Open (Ctrl+O)', () => this.openDoc()),
      b('save', 'Save (Ctrl+S)', () => this.save()),
      b('saveas', 'Save as (Ctrl+Shift+S)', () => this.save(this.active, true)),
      sep(),
      this.btn.undo, this.btn.redo, sep(),
      this.btn.cut, this.btn.copy, this.btn.paste, this.btn.del, sep(),
      this.btn.rotl, this.btn.rotr, this.btn.enable, this.btn.disable, this.btn.bypass, sep(),
      b('gen', 'Generate the flow graph (F5)', () => this.generate()),
      b('code', 'Generate and view the code', () => this.generate(true)),
      this.btn.run, this.btn.stop, runsBtn, sep(),
      b('find', 'Find block (Ctrl+F)', () => this.library.focus()),
      b('reload', 'Reload block library', async () => {
        try { await this.api.call('library.reload'); toast('Block library reloaded', 'ok'); } catch (err) { toast(err.message, 'err'); }
      }),
      b('lib', 'Show/hide block library', () => document.getElementById('workspace').classList.toggle('lib-hidden')),
      b('panel', 'Show/hide console', () => document.getElementById('bottom').classList.toggle('collapsed')),
      this.btn.term,
      el('span', { class: 'tb-spacer' }),
      b('theme', 'Light/dark theme', () => { toggleTheme(); this.canvas.redrawAll(); }),
      this.userEl = el('span', { class: 'tb-user' }),
      b('help', 'Keyboard and mouse help', () => this.showHelp()),
      b('key', 'Change password', () => this.changePassword()),
      b('logout', 'Sign out', () => logout()),
    );
    this.updateToolbar();
  }

  updateUser() {
    this.userEl.textContent = this.user + (this.admin ? ' (admin)' : '');
  }

  _buildHud() {
    const hud = document.getElementById('hud');
    this.zoomLabel = el('span', { class: 'zoom' }, '100%');
    hud.append(
      iconButton('zout', 'Zoom out (Ctrl+-)', () => this.canvas.zoomAt(1 / 1.2)),
      this.zoomLabel,
      iconButton('zin', 'Zoom in (Ctrl++)', () => this.canvas.zoomAt(1.2)),
      iconButton('fit', 'Zoom to fit (Ctrl+0)', () => this.canvas.fit()),
    );
    this.zoomLabel.addEventListener('click', () => this.canvas.setZoom(1));
    this.zoomLabel.title = 'Reset zoom (Ctrl+1)';
  }

  onZoom(scale) {
    if (this.zoomLabel) this.zoomLabel.textContent = Math.round(scale * 100) + '%';
  }

  onSelection() {
    this.updateToolbar();
    this.status();
  }

  updateToolbar() {
    if (!this.btn) return;
    const doc = this.active;
    const has = !!doc && this.sel().length > 0;
    const hasAny = has || (!!doc && this.canvas.selectedConns().length > 0);
    this.btn.undo.disabled = !doc || !doc.meta.undo;
    this.btn.redo.disabled = !doc || !doc.meta.redo;
    for (const k of ['cut', 'copy', 'rotl', 'rotr', 'enable', 'disable', 'bypass']) this.btn[k].disabled = !has;
    this.btn.del.disabled = !hasAny;
  }

  log(text, cls = '') {
    const atBottom = this.consoleEl.scrollTop + this.consoleEl.clientHeight >= this.consoleEl.scrollHeight - 4;
    for (const line of text.split('\n')) {
      if (!line && !text.endsWith('\n')) continue;
      let c = cls;
      if (!c) {
        if (/error|traceback|exception|failed/i.test(line)) c = 'err';
        else if (/warning/i.test(line)) c = 'warn';
      }
      this.consoleEl.append(c ? el('span', { class: c }, line + '\n') : line + '\n');
    }
    while (this.consoleEl.childNodes.length > 4000) this.consoleEl.firstChild.remove();
    if (atBottom) this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
    this.terminals.consoleActivity();
  }

  showErrors() {
    const doc = this.active;
    if (!doc) return;
    document.getElementById('bottom').classList.remove('collapsed');
    this.terminals.show('console');
    if (!doc.meta.errors.length) { this.log('>>> No errors.\n', 'grc'); return; }
    this.log(`>>> ${doc.meta.n_errors} error(s) in ${doc.meta.title}:\n`, 'err');
    this.log(doc.meta.errors.join('\n') + '\n', 'err');
  }

  status() {
    const doc = this.active;
    this.statusEl.textContent = '';
    const conn = el('span', { class: 'conn-state' + (this.api.connected ? '' : ' off') }, this.api.connected ? '● connected' : '● offline');
    this.statusEl.append(conn);
    if (doc) {
      const nerr = doc.meta.n_errors;
      const errs = el('span', { class: nerr ? 'errs' : 'ok' }, nerr ? `⚠ ${nerr} error${nerr > 1 ? 's' : ''}` : '✓ no errors');
      if (nerr) errs.addEventListener('click', () => this.showErrors());
      this.statusEl.append(
        errs,
        el('span', {}, `${doc.blocks.size - 1} blocks · ${doc.conns.size} connections`),
        el('span', {}, `${doc.meta.generate_options}${doc.meta.output_language === 'cpp' ? ' · C++' : ''}`),
      );
      const n = this.sel().length;
      if (n) this.statusEl.append(el('span', {}, `${n} selected`));
      this.statusEl.append(el('span', { class: 'sp' }), el('span', { class: 'mono' }, doc.meta.path || 'not saved'));
    }
  }

  renderVars() {
    const doc = this.active;
    this.varsEl.textContent = '';
    if (!doc) return;
    const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Id'), el('th', {}, 'Value'), el('th', {}, ''))));
    const tbody = el('tbody');
    for (const v of doc.meta.variables) {
      const tr = el('tr', { class: (v.valid ? '' : 'bad ') + (v.state === 'disabled' ? 'disabled' : ''), title: v.value },
        el('td', { class: 'mono' }, v.name), el('td', { class: 'mono' }, v.shown), el('td', { class: 'kind' }, v.label));
      tr.addEventListener('click', () => { this.canvas.setSelection(['b:' + v.name]); this.canvas.centerOn(v.name); });
      tr.addEventListener('dblclick', () => this.openProps(v.name));
      tbody.append(tr);
    }
    table.append(tbody);
    this.varsEl.append(table);
  }

  _bindPanels() {
    document.getElementById('console-clear').addEventListener('click', () => { this.consoleEl.textContent = ''; });
    document.getElementById('add-var').addEventListener('click', () => this.addBlockAtCenter('variable'));
    document.getElementById('add-import').addEventListener('click', () => this.addBlockAtCenter('import'));
    const resize = (handle, target, prop, invert) => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const start = prop === 'height' ? e.clientY : e.clientX;
        const size = prop === 'height' ? target.getBoundingClientRect().height : target.getBoundingClientRect().width;
        const move = (ev) => {
          const pos = prop === 'height' ? ev.clientY : ev.clientX;
          const next = Math.max(60, size + (invert ? start - pos : pos - start));
          if (target.id === 'side') {
            document.getElementById('workspace').style.gridTemplateColumns = `1fr auto ${next}px`;
          } else if (target.classList.contains('vars-panel')) {
            document.getElementById('bottom').style.gridTemplateColumns = `1fr 5px ${next}px`;
          } else {
            target.style.height = next + 'px';
          }
        };
        const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    };
    const bottom = document.getElementById('bottom');
    bottom.style.height = '190px';
    resize(document.getElementById('split-bottom'), bottom, 'height', true);
    resize(document.getElementById('split-side'), document.getElementById('side'), 'width', true);
    resize(document.getElementById('split-vars'), document.querySelector('.vars-panel'), 'width', true);
  }

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-back')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.altKey && e.code === 'Backquote') { e.preventDefault(); this.terminals.toggle(); return; }
      if (isTyping(e)) return;
      const k = e.key;
      const run = (fn) => { e.preventDefault(); fn(); };
      if (ctrl) {
        const lower = k.toLowerCase();
        if (lower === 'n') return run(() => this.newDoc());
        if (lower === 'o') return run(() => this.openDoc());
        if (lower === 's') return run(() => this.save(this.active, e.shiftKey));
        if (lower === 'z' && !e.shiftKey) return run(() => this.edit('undo').catch(() => {}));
        if (lower === 'y' || (lower === 'z' && e.shiftKey)) return run(() => this.edit('redo').catch(() => {}));
        if (lower === 'c') return run(() => this.copy());
        if (lower === 'x') return run(() => this.cut());
        if (lower === 'v') return run(() => this.paste());
        if (lower === 'a') return run(() => this.canvas.selectAll());
        if (lower === 'f') return run(() => this.library.focus());
        if (k === '0') return run(() => this.canvas.fit());
        if (k === '1') return run(() => this.canvas.setZoom(1));
        if (k === '+' || k === '=') return run(() => this.canvas.zoomAt(1.2));
        if (k === '-') return run(() => this.canvas.zoomAt(1 / 1.2));
        return;
      }
      if (!this.active) return;
      const sel = this.sel();
      if (k === 'Delete' || k === 'Backspace') return run(() => this.remove());
      if (k === 'F5') return run(() => this.generate());
      if (k === 'F6') return run(() => this.run());
      if (k === 'F7') return run(() => this.stop());
      if (k === 'Escape') return run(() => { this.canvas.cancelDrag(); this.canvas.setSelection([]); });
      if (!sel.length || e.altKey) return;
      const lower = k.toLowerCase();
      if (lower === 'e') return run(() => this.setState('enabled'));
      if (lower === 'd') return run(() => this.setState('disabled'));
      if (lower === 'b') return run(() => this.setState('bypassed'));
      if (k === 'ArrowLeft') return run(() => this.rotate(90));
      if (k === 'ArrowRight') return run(() => this.rotate(-90));
      if (k === 'ArrowUp') return run(() => this.edit('type', { names: sel, direction: -1 }).catch(() => {}));
      if (k === 'ArrowDown') return run(() => this.edit('type', { names: sel, direction: 1 }).catch(() => {}));
      if (k === '+' || k === '=') return run(() => this.edit('ports', { names: sel, direction: 1 }).catch(() => {}));
      if (k === '-') return run(() => this.edit('ports', { names: sel, direction: -1 }).catch(() => {}));
      if (k === 'Enter' && sel.length === 1) return run(() => this.openProps(sel[0]));
    });
  }

  async changePassword() {
    const old = el('input', { type: 'password', autocomplete: 'current-password', style: { width: '100%' } });
    const pw1 = el('input', { type: 'password', autocomplete: 'new-password', style: { width: '100%' } });
    const pw2 = el('input', { type: 'password', autocomplete: 'new-password', style: { width: '100%' } });
    const msg = el('div', { class: 'login-error' });
    modal({
      title: 'Change password', cls: 'small',
      body: el('div', {}, el('label', {}, 'Current password'), old, el('br'), el('br'),
        el('label', {}, 'New password (8+ characters)'), pw1, el('br'), el('br'), el('label', {}, 'Repeat new password'), pw2, msg),
      buttons: [
        { label: 'Cancel', cancel: true },
        {
          label: 'Change', cls: 'primary', action: async (close) => {
            if (pw1.value !== pw2.value) { msg.textContent = 'Passwords do not match'; return; }
            const r = await fetch('/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ old: old.value, new: pw1.value }) });
            const data = await r.json().catch(() => ({}));
            if (r.ok && data.ok) { close(); toast('Password changed', 'ok'); } else msg.textContent = data.error || 'Error';
          },
        },
      ],
    });
    setTimeout(() => old.focus(), 0);
  }
}

window.app = new App();

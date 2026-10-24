// The flow graph canvas (SVG): drawing, selection, dragging, connecting, zooming.
'use strict';

import { svgEl, el, showTooltip, hideTooltip, closeMenu } from '../common/ui.js';
import {
  layoutBlock, portByKey, connectionPath, alignToGrid, GRID, FONTS, textWidth, PORT_HEIGHT,
} from './geometry.js';

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

export class Canvas {
  constructor(container, app) {
    this.app = app;
    this.wrap = container;
    this.doc = null;
    this.opts = { showExpr: false, showValue: true, showComments: true };
    this.svg = svgEl('svg', { class: 'fg', tabindex: '-1' });
    const defs = svgEl('defs');
    const pattern = svgEl('pattern', { id: 'gridpat', width: GRID * 2, height: GRID * 2, patternUnits: 'userSpaceOnUse' });
    pattern.append(svgEl('circle', { cx: 1, cy: 1, r: 0.9, fill: 'var(--canvas-dot)' }));
    defs.append(pattern);
    this.svg.append(defs);
    this.viewport = svgEl('g');
    this.gridRect = svgEl('rect', { x: -50000, y: -50000, width: 100000, height: 100000, fill: 'url(#gridpat)' });
    this.connLayer = svgEl('g');
    this.blockLayer = svgEl('g');
    this.overlay = svgEl('g');
    this.viewport.append(this.gridRect, this.connLayer, this.blockLayer, this.overlay);
    this.svg.append(this.viewport);
    this.empty = el('div', { class: 'canvas-empty' }, 'Drag blocks here from the library →');
    this.wrap.append(this.svg, this.empty);
    this.blockEls = new Map();
    this.connEls = new Map();
    this.drag = null;
    this.armed = null;
    this.space = false;
    this.lastPointer = null;
    this._bind();
  }

  // ------------------------------------------------------------ document
  setDoc(doc) {
    this.cancelDrag();
    this.doc = doc;
    this.render();
    if (doc && !doc.view.initialized) {
      doc.view.initialized = true;
      this.initialView();
    } else {
      this.applyView();
    }
  }

  render() {
    this.blockLayer.textContent = '';
    this.connLayer.textContent = '';
    this.blockEls.clear();
    this.connEls.clear();
    if (!this.doc) { this.empty.classList.remove('hidden'); return; }
    for (const block of this.doc.blocks.values()) this._drawBlock(block);
    for (const conn of this.doc.conns.values()) this._drawConn(conn);
    this._updateEmpty();
  }

  _updateEmpty() {
    this.empty.classList.toggle('hidden', !!this.doc && this.doc.blocks.size > 1);
  }

  applyPatch(patch) {
    const touched = new Set();
    for (const name of patch.removed_blocks || []) {
      const entry = this.blockEls.get(name);
      if (entry) entry.g.remove();
      this.blockEls.delete(name);
      this.doc.selection.delete('b:' + name);
    }
    for (const id of patch.removed_connections || []) {
      const entry = this.connEls.get(id);
      if (entry) entry.g.remove();
      this.connEls.delete(id);
      this.doc.selection.delete('c:' + id);
    }
    for (const block of patch.blocks || []) {
      this._drawBlock(block);
      touched.add(block.name);
    }
    for (const conn of patch.connections || []) this._drawConn(conn);
    for (const conn of this.doc.conns.values()) {
      if (touched.has(conn.src) || touched.has(conn.dst)) this._drawConn(conn);
    }
    this._updateEmpty();
    this._refreshSelectionClasses();
  }

  // ------------------------------------------------------------- drawing
  _drawBlock(block) {
    const old = this.blockEls.get(block.name);
    const layout = layoutBlock(block, this.opts);
    const cls = ['blk', block.state];
    if (!block.valid) cls.push('invalid');
    if (block.deprecated) cls.push('deprecated');
    if (block.dummy) cls.push('dummy');
    if (this.doc.selection.has('b:' + block.name)) cls.push('selected');
    const g = svgEl('g', { class: cls.join(' '), transform: `translate(${block.x},${block.y})` });
    g.dataset.block = block.name;

    for (const p of layout.ports) {
      const pg = svgEl('g', { class: 'port' });
      pg.dataset.port = p.key;
      pg.dataset.dir = p.dir;
      const color = p.port.c;
      pg.append(svgEl('rect', { x: p.x, y: p.y, width: p.w, height: p.h, fill: color, stroke: darken(color) }));
      const label = svgEl('text', {}, p.port.n);
      if (p.d === 0 || p.d === 180) {
        label.setAttribute('x', p.x + p.w / 2);
        label.setAttribute('y', p.y + PORT_HEIGHT / 2 + 3.5);
        label.setAttribute('text-anchor', 'middle');
      } else {
        const cx = p.x + PORT_HEIGHT / 2 + 3.5;
        const cy = p.y + p.h / 2;
        label.setAttribute('transform', `translate(${cx},${cy}) rotate(-90)`);
        label.setAttribute('text-anchor', 'middle');
      }
      pg.append(label);
      g.append(pg);
    }

    g.append(svgEl('rect', { class: 'body', x: 0, y: 0, width: layout.bw, height: layout.bh }));
    const inner = svgEl('g', layout.vertical ? { transform: `translate(0,${layout.w}) rotate(-90)` } : {});
    let y = (layout.h - layout.labelH) / 2 + 11;
    inner.append(svgEl('text', { class: 'title', x: layout.w / 2, y, 'text-anchor': 'middle' }, block.label));
    if (layout.lines.length) {
      let maxW = 0;
      for (const line of layout.lines) {
        maxW = Math.max(maxW, textWidth(line.key, FONTS.paramKey) + textWidth(line.value, FONTS.param));
      }
      const x0 = (layout.w - maxW) / 2;
      y += 3 + 2;
      for (const line of layout.lines) {
        y += 12;
        const t = svgEl('text', { class: 'param' + (line.bad ? ' bad' : ''), x: x0, y: y - 2 });
        t.append(svgEl('tspan', { class: 'k' }, line.key), svgEl('tspan', {}, line.value));
        inner.append(t);
        y += 3;
      }
    }
    g.append(inner);

    if (this.opts.showComments && block.comment) {
      const lines = block.comment.split('\n').slice(0, 20);
      const cx = layout.vertical ? layout.bw + 7 : 0;
      const cy = layout.vertical ? 0 : layout.bh + 7;
      lines.forEach((line, i) => {
        g.append(svgEl('text', { class: 'comment', x: cx, y: cy + 11 + i * 13 }, line));
      });
    }

    if (old) old.g.replaceWith(g); else this.blockLayer.append(g);
    this.blockEls.set(block.name, { g, layout, block });
  }

  _connPoints(conn, positions) {
    const src = this.blockEls.get(conn.src);
    const dst = this.blockEls.get(conn.dst);
    if (!src || !dst) return null;
    const sp = portByKey(src.layout, 'out', conn.sp);
    const dp = portByKey(dst.layout, 'in', conn.dp);
    if (!sp || !dp) return null;
    const sPos = (positions && positions.get(conn.src)) || [src.block.x, src.block.y];
    const dPos = (positions && positions.get(conn.dst)) || [dst.block.x, dst.block.y];
    return connectionPath(sPos[0] + sp.cx, sPos[1] + sp.cy, sp.d, dPos[0] + dp.cx, dPos[1] + dp.cy, dp.d);
  }

  _drawConn(conn, positions) {
    const geom = this._connPoints(conn, positions);
    let entry = this.connEls.get(conn.id);
    if (!geom) {
      if (entry) { entry.g.remove(); this.connEls.delete(conn.id); }
      return;
    }
    const cls = ['conn'];
    if (conn.msg) cls.push('msg');
    if (!conn.enabled) cls.push('disabled');
    else if (!conn.valid) cls.push('invalid');
    if (this.doc.selection.has('c:' + conn.id)) cls.push('selected');
    if (!entry) {
      const g = svgEl('g');
      g.dataset.conn = conn.id;
      const hit = svgEl('path', { class: 'hit' });
      const line = svgEl('path', { class: 'line' });
      const arrow = svgEl('polygon');
      g.append(line, arrow, hit);
      this.connLayer.append(g);
      entry = { g, hit, line, arrow };
      this.connEls.set(conn.id, entry);
    }
    entry.g.setAttribute('class', cls.join(' '));
    entry.line.setAttribute('d', geom.d);
    entry.hit.setAttribute('d', geom.d);
    entry.arrow.setAttribute('points', geom.arrow);
  }

  redrawAll() {
    if (!this.doc) return;
    this.render();
  }

  // ------------------------------------------------------------ selection
  selectedBlocks() {
    return [...this.doc.selection].filter((s) => s.startsWith('b:')).map((s) => s.slice(2));
  }

  selectedConns() {
    return [...this.doc.selection].filter((s) => s.startsWith('c:')).map((s) => s.slice(2));
  }

  setSelection(items) {
    this.doc.selection = new Set(items);
    this._refreshSelectionClasses();
    this.app.onSelection();
  }

  selectAll() {
    this.setSelection([...this.doc.blocks.keys()].map((n) => 'b:' + n));
  }

  _refreshSelectionClasses() {
    if (!this.doc) return;
    for (const [name, entry] of this.blockEls) entry.g.classList.toggle('selected', this.doc.selection.has('b:' + name));
    for (const [id, entry] of this.connEls) entry.g.classList.toggle('selected', this.doc.selection.has('c:' + id));
  }

  // ----------------------------------------------------------------- view
  applyView() {
    if (!this.doc) return;
    const { tx, ty, scale } = this.doc.view;
    this.viewport.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
    this.app.onZoom(scale);
  }

  toWorld(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    const { tx, ty, scale } = this.doc.view;
    return [(clientX - r.left - tx) / scale, (clientY - r.top - ty) / scale];
  }

  zoomAt(factor, clientX, clientY) {
    if (!this.doc) return;
    const r = this.svg.getBoundingClientRect();
    if (clientX === undefined) { clientX = r.left + r.width / 2; clientY = r.top + r.height / 2; }
    const v = this.doc.view;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
    const [wx, wy] = this.toWorld(clientX, clientY);
    v.tx = clientX - r.left - wx * scale;
    v.ty = clientY - r.top - wy * scale;
    v.scale = scale;
    this.applyView();
  }

  setZoom(scale) {
    this.zoomAt(scale / this.doc.view.scale);
  }

  bounds(names) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [name, entry] of this.blockEls) {
      if (names && !names.includes(name)) continue;
      const { block, layout } = entry;
      x0 = Math.min(x0, block.x - 30); y0 = Math.min(y0, block.y - 30);
      x1 = Math.max(x1, block.x + layout.bw + 30); y1 = Math.max(y1, block.y + layout.bh + 30);
    }
    return isFinite(x0) ? [x0, y0, x1, y1] : null;
  }

  fit(maxScale = 2) {
    if (!this.doc) return;
    const b = this.bounds();
    const r = this.svg.getBoundingClientRect();
    if (!b || r.width < 10) { this.applyView(); return; }
    const [x0, y0, x1, y1] = b;
    const scale = Math.min(maxScale, Math.max(MIN_SCALE, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
    this.doc.view.scale = scale;
    this.doc.view.tx = (r.width - (x1 - x0) * scale) / 2 - x0 * scale;
    this.doc.view.ty = (r.height - (y1 - y0) * scale) / 2 - y0 * scale;
    this.applyView();
  }

  // like GRC: a flow graph that fits at 100% is shown from its top-left corner
  initialView() {
    const b = this.bounds();
    const r = this.svg.getBoundingClientRect();
    if (!b || r.width < 10) { this.applyView(); return; }
    const [x0, y0, x1, y1] = b;
    if (x1 - x0 <= r.width && y1 - y0 <= r.height) {
      Object.assign(this.doc.view, { scale: 1, tx: -x0, ty: -y0 });
      this.applyView();
    } else {
      this.fit(1);
    }
  }

  centerOn(name) {
    const entry = this.blockEls.get(name);
    if (!entry) return;
    const r = this.svg.getBoundingClientRect();
    const v = this.doc.view;
    v.tx = r.width / 2 - (entry.block.x + entry.layout.bw / 2) * v.scale;
    v.ty = r.height / 2 - (entry.block.y + entry.layout.bh / 2) * v.scale;
    this.applyView();
  }

  viewCenter() {
    const r = this.svg.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  pastePoint() {
    if (this.lastPointer) return this.toWorld(...this.lastPointer);
    return this.viewCenter();
  }

  // --------------------------------------------------------- interaction
  _bind() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => this._down(e));
    svg.addEventListener('pointermove', (e) => this._move(e));
    svg.addEventListener('pointerup', (e) => this._up(e));
    svg.addEventListener('pointercancel', () => this.cancelDrag());
    svg.addEventListener('dblclick', (e) => {
      // with pointer capture the event targets the svg itself: look underneath
      const target = document.elementFromPoint(e.clientX, e.clientY) || e.target;
      const b = target.closest('[data-block]');
      if (b && !target.closest('.port')) this.app.openProps(b.dataset.block);
    });
    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.doc) return;
      const b = e.target.closest('[data-block]');
      const c = e.target.closest('[data-conn]');
      if (b && !this.doc.selection.has('b:' + b.dataset.block)) this.setSelection(['b:' + b.dataset.block]);
      else if (c && !this.doc.selection.has('c:' + c.dataset.conn)) this.setSelection(['c:' + c.dataset.conn]);
      this.lastPointer = [e.clientX, e.clientY];
      this.app.canvasMenu(e.clientX, e.clientY, b ? 'block' : c ? 'conn' : 'canvas');
    });
    svg.addEventListener('wheel', (e) => {
      if (!this.doc) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022)), e.clientX, e.clientY);
      } else {
        const k = e.deltaMode ? 16 : 1;
        this.doc.view.tx -= (e.shiftKey ? e.deltaY : e.deltaX) * k;
        this.doc.view.ty -= (e.shiftKey ? 0 : e.deltaY) * k;
        this.applyView();
      }
    }, { passive: false });
    svg.addEventListener('mousemove', (e) => {
      this.lastPointer = [e.clientX, e.clientY];
      if (this.drag) return;
      this._hover(e);
    });
    svg.addEventListener('mouseleave', () => hideTooltip());

    this.wrap.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/grc-block')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    });
    this.wrap.addEventListener('drop', (e) => {
      const key = e.dataTransfer.getData('text/grc-block');
      if (!key || !this.doc) return;
      e.preventDefault();
      const [x, y] = this.toWorld(e.clientX, e.clientY);
      this.app.addBlock(key, x - 40, y - 20);
    });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isEditing(e)) this.space = true; });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.space = false; });
  }

  _hover(e) {
    const port = e.target.closest('.port');
    const b = e.target.closest('[data-block]');
    const c = e.target.closest('[data-conn]');
    if (port && b) {
      const entry = this.blockEls.get(b.dataset.block);
      const p = entry && entry.block[port.dataset.dir === 'in' ? 'in' : 'out'].find((q) => q.k === port.dataset.port);
      if (p) {
        showTooltip(`${port.dataset.dir === 'in' ? 'Input' : 'Output'} ${p.n}\nType: ${p.msg ? 'message' : p.dt}${p.vl > 1 ? ' × ' + p.vl : ''}${p.opt ? '\n(optional)' : ''}`, e.clientX, e.clientY, 500);
        return;
      }
    }
    if (b) {
      const entry = this.blockEls.get(b.dataset.block);
      if (entry) {
        const blk = entry.block;
        let text = `${blk.label}\n${blk.name}  (${blk.key})`;
        if (blk.state !== 'enabled') text += `\n[${blk.state}]`;
        if (blk.errors.length) text += '\n\n' + blk.errors.join('\n');
        showTooltip(text, e.clientX, e.clientY, 600);
        return;
      }
    }
    if (c) {
      const conn = this.doc.conns.get(c.dataset.conn);
      if (conn && conn.errors && conn.errors.length) {
        showTooltip(conn.errors.join('\n'), e.clientX, e.clientY, 300);
        return;
      }
    }
    hideTooltip();
  }

  _portInfo(target) {
    const port = target && target.closest && target.closest('.port');
    if (!port) return null;
    const b = port.closest('[data-block]');
    return { block: b.dataset.block, key: port.dataset.port, dir: port.dataset.dir, node: port };
  }

  _down(e) {
    if (!this.doc) return;
    closeMenu();
    hideTooltip();
    this.svg.focus({ preventScroll: true });
    this.lastPointer = [e.clientX, e.clientY];
    if (e.button === 1 || (e.button === 0 && this.space)) {
      e.preventDefault();
      this.drag = { mode: 'pan', x: e.clientX, y: e.clientY, tx: this.doc.view.tx, ty: this.doc.view.ty };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    const port = this._portInfo(e.target);
    if (port) {
      if (this.armed && this.armed.block !== port.block && this.armed.dir !== port.dir) {
        this._connect(this.armed, port);
        this._disarm();
        return;
      }
      this._disarm();
      const entry = this.blockEls.get(port.block);
      const p = portByKey(entry.layout, port.dir, port.key);
      this.drag = {
        mode: 'connect', from: port, sx: entry.block.x + p.cx, sy: entry.block.y + p.cy, d: p.d,
        startX: e.clientX, startY: e.clientY, moved: false,
      };
      this.drag.path = svgEl('path', { class: 'temp-conn' });
      this.overlay.append(this.drag.path);
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    this._disarm();
    const b = e.target.closest('[data-block]');
    const c = e.target.closest('[data-conn]');
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (b) {
      const key = 'b:' + b.dataset.block;
      if (additive) {
        const sel = new Set(this.doc.selection);
        if (sel.has(key)) sel.delete(key); else sel.add(key);
        this.setSelection(sel);
      } else if (!this.doc.selection.has(key)) {
        this.setSelection([key]);
      }
      const names = this.selectedBlocks();
      const origin = new Map(names.map((n) => {
        const blk = this.doc.blocks.get(n);
        return [n, [blk.x, blk.y]];
      }));
      this.drag = { mode: 'move', wx, wy, origin, moved: false, clickKey: additive ? null : key };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (c) {
      const key = 'c:' + c.dataset.conn;
      if (additive) {
        const sel = new Set(this.doc.selection);
        if (sel.has(key)) sel.delete(key); else sel.add(key);
        this.setSelection(sel);
      } else {
        this.setSelection([key]);
      }
      return;
    }
    const base = additive ? new Set(this.doc.selection) : new Set();
    if (!additive) this.setSelection([]);
    this.drag = { mode: 'rubber', wx, wy, base, rect: svgEl('rect', { class: 'rubber', x: wx, y: wy, width: 0, height: 0 }) };
    this.overlay.append(this.drag.rect);
    this.svg.setPointerCapture(e.pointerId);
  }

  _move(e) {
    const drag = this.drag;
    if (!drag) return;
    if (drag.mode === 'pan') {
      this.doc.view.tx = drag.tx + e.clientX - drag.x;
      this.doc.view.ty = drag.ty + e.clientY - drag.y;
      this.applyView();
      return;
    }
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    if (drag.mode === 'move') {
      const dx = wx - drag.wx;
      const dy = wy - drag.wy;
      if (!drag.moved && Math.hypot(dx, dy) * this.doc.view.scale < 3) return;
      drag.moved = true;
      const positions = new Map();
      for (const [name, [x, y]] of drag.origin) {
        const nx = alignToGrid(x + dx);
        const ny = alignToGrid(y + dy);
        positions.set(name, [nx, ny]);
        const entry = this.blockEls.get(name);
        if (entry) entry.g.setAttribute('transform', `translate(${nx},${ny})`);
      }
      drag.positions = positions;
      for (const conn of this.doc.conns.values()) {
        if (positions.has(conn.src) || positions.has(conn.dst)) this._drawConn(conn, positions);
      }
      this._autoScroll(e);
    } else if (drag.mode === 'connect') {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4) drag.moved = true;
      const target = this._portInfo(document.elementFromPoint(e.clientX, e.clientY));
      if (drag.hover && drag.hover.node !== (target && target.node)) drag.hover.node.classList.remove('armed');
      drag.hover = target && target.block !== drag.from.block && target.dir !== drag.from.dir ? target : null;
      if (drag.hover) drag.hover.node.classList.add('armed');
      let kx = wx, ky = wy, kd = (drag.d + 180) % 360;
      if (drag.hover) {
        const entry = this.blockEls.get(drag.hover.block);
        const p = portByKey(entry.layout, drag.hover.dir, drag.hover.key);
        kx = entry.block.x + p.cx; ky = entry.block.y + p.cy; kd = p.d;
      }
      const geom = drag.from.dir === 'out'
        ? connectionPath(drag.sx, drag.sy, drag.d, kx, ky, kd)
        : connectionPath(kx, ky, kd, drag.sx, drag.sy, drag.d);
      drag.path.setAttribute('d', geom.d);
      this._autoScroll(e);
    } else if (drag.mode === 'rubber') {
      const x = Math.min(wx, drag.wx), y = Math.min(wy, drag.wy);
      const w = Math.abs(wx - drag.wx), h = Math.abs(wy - drag.wy);
      Object.entries({ x, y, width: w, height: h }).forEach(([k, v]) => drag.rect.setAttribute(k, v));
      const sel = new Set(drag.base);
      for (const [name, entry] of this.blockEls) {
        const { block, layout } = entry;
        if (block.x < x + w && block.x + layout.bw > x && block.y < y + h && block.y + layout.bh > y) sel.add('b:' + name);
      }
      this.doc.selection = sel;
      this._refreshSelectionClasses();
    }
  }

  _autoScroll(e) {
    const r = this.svg.getBoundingClientRect();
    const margin = 24;
    let dx = 0, dy = 0;
    if (e.clientX < r.left + margin) dx = 12; else if (e.clientX > r.right - margin) dx = -12;
    if (e.clientY < r.top + margin) dy = 12; else if (e.clientY > r.bottom - margin) dy = -12;
    if (dx || dy) {
      this.doc.view.tx += dx;
      this.doc.view.ty += dy;
      this.applyView();
      if (this.drag && this.drag.mode === 'move') { this.drag.wx -= dx / this.doc.view.scale; this.drag.wy -= dy / this.doc.view.scale; }
    }
  }

  _up(e) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    try { this.svg.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    if (drag.mode === 'move') {
      if (drag.moved && drag.positions) {
        const positions = {};
        for (const [name, pos] of drag.positions) {
          positions[name] = pos;
          const blk = this.doc.blocks.get(name);
          if (blk) { blk.x = pos[0]; blk.y = pos[1]; }
          const entry = this.blockEls.get(name);
          if (entry) { entry.block.x = pos[0]; entry.block.y = pos[1]; }
        }
        this.app.edit('move', { positions });
      } else if (drag.clickKey && this.doc.selection.size > 1) {
        this.setSelection([drag.clickKey]);
      }
    } else if (drag.mode === 'connect') {
      drag.path.remove();
      if (drag.hover) drag.hover.node.classList.remove('armed');
      if (drag.hover) {
        this._connect(drag.from, drag.hover);
      } else if (!drag.moved) {
        this.armed = drag.from;
        drag.from.node.classList.add('armed');
      }
    } else if (drag.mode === 'rubber') {
      drag.rect.remove();
      this.app.onSelection();
    }
  }

  _connect(a, b) {
    const [src, dst] = a.dir === 'out' ? [a, b] : [b, a];
    if (src.dir !== 'out' || dst.dir !== 'in') return;
    this.app.edit('connect', { src: src.block, sp: src.key, dst: dst.block, dp: dst.key });
  }

  _disarm() {
    if (this.armed) {
      const node = this.armed.node;
      if (node && node.classList) node.classList.remove('armed');
      this.armed = null;
    }
  }

  cancelDrag() {
    if (!this.drag) return;
    if (this.drag.path) this.drag.path.remove();
    if (this.drag.rect) this.drag.rect.remove();
    if (this.drag.mode === 'move') this.render();
    this.drag = null;
    this._disarm();
  }
}

function darken(hex) {
  if (!hex || hex[0] !== '#' || hex.length !== 7) return '#333';
  const c = [1, 3, 5].map((i) => Math.max(0, parseInt(hex.slice(i, i + 2), 16) - 77));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function isEditing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

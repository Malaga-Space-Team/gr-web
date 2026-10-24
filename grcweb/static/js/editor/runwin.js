// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// Floating window showing a running flow graph (the run page in an iframe),
// the web equivalent of the Qt window that gnuradio-companion opens.
'use strict';

import { el, iconButton } from '../common/ui.js';

let zTop = 40;
let cascade = 0;

export class RunWindow {
  constructor(app, run, onClose) {
    this.app = app;
    this.run = run;
    this.onClose = onClose;
    this.badge = el('span', { class: 'badge ' + run.state }, run.state);
    this.title = el('span', { class: 't' }, run.title);
    this.stopBtn = iconButton('stop', 'Kill the flow graph', () => app.stop(this.run), 'stop');
    const head = el('div', { class: 'fw-head' },
      this.title, this.badge, this.stopBtn,
      iconButton('pop', 'Open in a new browser tab', () => this.popOut()),
      iconButton('max', 'Maximize', () => this.node.classList.toggle('max')),
      iconButton('close', 'Close this view (the flow graph keeps running)', () => this.close()));
    this.frame = el('iframe', { src: '/run?id=' + encodeURIComponent(run.id) + '&embed=1', title: run.title });
    this.node = el('div', { class: 'float-win' }, head, this.frame);
    const w = Math.min(980, innerWidth - 80);
    const h = Math.min(700, innerHeight - 120);
    const off = (cascade++ % 6) * 28;
    Object.assign(this.node.style, {
      left: Math.max(10, innerWidth - w - 60 - off) + 'px',
      top: 70 + off + 'px', width: w + 'px', height: h + 'px',
    });
    this.node.addEventListener('mousedown', () => this.raise());
    this._drag(head);
    document.body.append(this.node);
    this.update(run);
  }

  _drag(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || this.node.classList.contains('max')) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const r = this.node.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      this.frame.style.pointerEvents = 'none';
      const move = (ev) => {
        this.node.style.left = Math.min(innerWidth - 80, Math.max(-r.width + 80, ev.clientX - dx)) + 'px';
        this.node.style.top = Math.min(innerHeight - 40, Math.max(0, ev.clientY - dy)) + 'px';
      };
      const up = () => {
        this.frame.style.pointerEvents = '';
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  update(run) {
    if (!run) return;
    this.run = run;
    this.title.textContent = run.title;
    this.badge.className = 'badge ' + run.state;
    this.badge.textContent = run.state === 'failed' || run.state === 'exited' ? `${run.state} (${run.exit_code})` : run.state;
    this.stopBtn.disabled = !(run.state === 'running' || run.state === 'starting') ||
      !(run.owner === this.app.user || this.app.admin);
  }

  raise() {
    this.node.style.zIndex = ++zTop;
  }

  popOut() {
    window.open('/run?id=' + encodeURIComponent(this.run.id), '_blank');
    this.close();
  }

  close() {
    this.node.remove();
    this.onClose();
  }
}

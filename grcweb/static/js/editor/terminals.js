// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// Terminal tabs of the bottom panel, next to the console. The shells run on
// the server and outlive the page: a reload shows them again.
'use strict';

import { el, toast, confirmDialog } from '../common/ui.js';
import { TermView } from '../common/terminal.js';

export class Terminals {
  constructor(app) {
    this.app = app;
    this.enabled = false;
    this.items = new Map(); // id -> { info, tab, pane, view, title }
    this.current = 'console';
    this.tabsEl = document.getElementById('out-tabs');
    this.bodyEl = document.getElementById('out-body');
    this.bottom = document.getElementById('bottom');
    this.consoleEl = document.getElementById('console');
    this.consoleTab = this.tabsEl.querySelector('[data-pane="console"]');
    this.consoleTab.addEventListener('click', () => this.show('console'));
    this.newBtn = document.getElementById('term-new');
    this.newBtn.addEventListener('click', () => this.create());
    this.popBtn = document.getElementById('term-pop');
    this.popBtn.addEventListener('click', () => this.popOut());
    this.clearBtn = document.getElementById('console-clear');
    app.api.on('term.opened', ({ term }) => this.add(term));
    app.api.on('term.exited', ({ term }) => this.update(term));
    app.api.on('term.closed', ({ term }) => this.remove(term.id));
  }

  // the terminals the server reports on (re)connection
  sync(enabled, list) {
    this.enabled = enabled;
    this.newBtn.classList.toggle('hidden', !enabled);
    const ids = new Set(list.map((t) => t.id));
    for (const id of [...this.items.keys()]) if (!ids.has(id)) this.remove(id);
    for (const info of list) this.add(info);
    this._buttons();
  }

  add(info) {
    const known = this.items.get(info.id);
    if (known) { this.update(info); return known; }
    const tab = el('button', { type: 'button', class: 'term-tab' },
      el('span', {}, `Terminal ${info.number}`), el('span', { class: 'x', title: 'Close this terminal' }, '×'));
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.x')) this.close(info.id);
      else this.show(info.id);
    });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) this.close(info.id); });
    const pane = el('div', { class: 'term-pane hidden' });
    this.bodyEl.append(pane);
    const item = { info, tab, pane, view: null, title: '' };
    this.items.set(info.id, item);
    const after = [...this.items.values()].find((other) => other.info.number > info.number && other.tab.isConnected);
    this.tabsEl.insertBefore(tab, after ? after.tab : null);
    this.update(info);
    return item;
  }

  update(info) {
    const item = this.items.get(info.id);
    if (!item) return;
    item.info = info;
    item.tab.classList.toggle('exited', !info.alive);
    item.tab.title = (item.title || `Terminal ${info.number}`) + (info.alive ? '' : ` (exited with code ${info.exit_code})`);
  }

  show(id) {
    if (id !== 'console' && !this.items.has(id)) id = 'console';
    this.current = id;
    this.consoleEl.classList.toggle('hidden', id !== 'console');
    this.consoleTab.classList.toggle('on', id === 'console');
    if (id === 'console') this.consoleTab.classList.remove('unread');
    for (const [key, item] of this.items) {
      const on = key === id;
      item.tab.classList.toggle('on', on);
      item.pane.classList.toggle('hidden', !on);
      if (!on) continue;
      if (!item.view) {
        item.view = new TermView(item.pane, key, {
          onTitle: (title) => { item.title = title; this.update(item.info); },
          onClose: () => this.close(key),
        });
      } else {
        item.view.resize();
      }
      item.view.focus();
    }
    this._buttons();
  }

  _buttons() {
    const terminal = this.current !== 'console';
    this.clearBtn.classList.toggle('hidden', terminal);
    this.popBtn.classList.toggle('hidden', !terminal);
  }

  // output in the console while a terminal is in front
  consoleActivity() {
    if (this.current !== 'console') this.consoleTab.classList.add('unread');
  }

  reveal() {
    this.bottom.classList.remove('collapsed');
    if (this.bottom.getBoundingClientRect().height < 240) this.bottom.style.height = '300px';
  }

  async create() {
    if (!this.enabled) return;
    this.reveal();
    try {
      const info = await this.app.api.call('term.new', { cols: 80, rows: 24 });
      this.add(info);
      this.show(info.id);
    } catch (err) { toast(err.message, 'err'); }
  }

  async close(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.info.alive && !item.view?.exited &&
        !(await confirmDialog('Close terminal', `Close Terminal ${item.info.number}? The shell and the programs started in it are stopped.`, 'Close', true))) {
      return;
    }
    try { await this.app.api.call('term.close', { term: id }); } catch (err) { toast(err.message, 'err'); return; }
    this.remove(id);
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.view) item.view.dispose();
    item.tab.remove();
    item.pane.remove();
    this.items.delete(id);
    if (this.current === id) {
      const next = [...this.items.keys()].pop();
      this.show(next || 'console');
      if (!next) this.app.focusCanvas();
    }
  }

  // Ctrl+`: to the terminal (opening one if needed), and back to the canvas
  toggle() {
    if (!this.enabled) return;
    const item = this.items.get(this.current);
    if (item && !this.bottom.classList.contains('collapsed') && item.pane.contains(document.activeElement)) {
      this.app.focusCanvas();
      return;
    }
    this.reveal();
    if (item) this.show(this.current);
    else if (this.items.size) this.show([...this.items.keys()].pop());
    else this.create();
  }

  popOut() {
    if (this.items.has(this.current)) window.open('/terminal?id=' + encodeURIComponent(this.current), '_blank');
  }
}

// Block library tree with search, drag & drop and double click to add.
'use strict';

import { el, showTooltip, hideTooltip } from '../common/ui.js';

export class Library {
  constructor(container, app) {
    this.app = app;
    this.search = el('input', { type: 'search', placeholder: 'Search blocks…  (Ctrl+F)', spellcheck: 'false' });
    this.tree = el('div', { class: 'lib' });
    container.append(el('div', { class: 'side-head' }, this.search), this.tree);
    this.data = null;
    this.flat = [];
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.tree.querySelector('.item');
        if (first) this.app.addBlockAtCenter(first.dataset.key);
      } else if (e.key === 'Escape') {
        this.search.value = '';
        this.render();
        this.app.focusCanvas();
      }
    });
  }

  async load() {
    const response = await fetch('/api/library', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Cannot load the block library');
    this.data = await response.json();
    this.flat = [];
    const walk = (node, path) => {
      for (const b of node.blocks) this.flat.push({ ...b, path: path.join(' / ') });
      for (const c of node.children) walk(c, path.concat(c.name));
    };
    walk(this.data, []);
    this.render();
  }

  focus() {
    this.search.focus();
    this.search.select();
  }

  _item(block, withKey) {
    const item = el('div', {
      class: 'item' + (block.deprecated ? ' deprecated' : ''), draggable: 'true',
      dataset: { key: block.key },
    }, block.label, withKey ? el('span', { class: 'key' }, block.key) : null);
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/grc-block', block.key);
      e.dataTransfer.effectAllowed = 'copy';
      hideTooltip();
    });
    item.addEventListener('dblclick', () => this.app.addBlockAtCenter(block.key));
    item.addEventListener('mouseenter', (e) => {
      const doc = block.doc ? '\n\n' + block.doc.slice(0, 500) : '';
      showTooltip(`${block.label}\n${block.key}${block.path ? '\n' + block.path : ''}${doc}`, e.clientX, e.clientY, 700);
    });
    item.addEventListener('mouseleave', hideTooltip);
    return item;
  }

  render() {
    this.tree.textContent = '';
    if (!this.data) return;
    const query = this.search.value.trim().toLowerCase();
    if (query) {
      const words = query.split(/\s+/);
      const scored = [];
      for (const b of this.flat) {
        const label = b.label.toLowerCase();
        const key = b.key.toLowerCase();
        const hay = label + ' ' + key + ' ' + b.path.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        let score = 3;
        if (label.startsWith(query) || key.startsWith(query)) score = 0;
        else if (label.includes(query)) score = 1;
        else if (key.includes(query)) score = 2;
        scored.push([score, b]);
      }
      scored.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label));
      const box = el('div', { class: 'lib-results' });
      for (const [, b] of scored.slice(0, 300)) box.append(this._item(b, true));
      if (!scored.length) box.append(el('div', { class: 'muted', style: { padding: '8px 12px' } }, 'No blocks found'));
      this.tree.append(box);
      return;
    }
    const build = (node, depth) => {
      const frag = document.createDocumentFragment();
      for (const child of node.children) {
        const details = el('details', {}, el('summary', {}, child.name));
        details.addEventListener('toggle', () => {
          if (details.open && !details.dataset.filled) {
            details.dataset.filled = '1';
            details.append(build(child, depth + 1));
          }
        }, { once: false });
        frag.append(details);
      }
      for (const b of node.blocks) frag.append(this._item(b, false));
      return frag;
    };
    this.tree.append(build(this.data, 0));
  }
}

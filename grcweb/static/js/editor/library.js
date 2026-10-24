// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

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
    this.visible = [];   // search results in display order
    this.selected = -1;
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const item = this.visible[this.selected];
        if (item) this.app.addBlockAtCenter(item.dataset.key);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._select(this.selected + (e.key === 'ArrowDown' ? 1 : -1));
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
    this.render();
  }

  focus() {
    this.search.focus();
    this.search.select();
  }

  _item(block, path, words) {
    const item = el('div', {
      class: 'item' + (block.deprecated ? ' deprecated' : ''), draggable: 'true',
      dataset: { key: block.key },
    }, words ? highlight(block.label, words) : block.label, words ? el('span', { class: 'key' }, block.key) : null);
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/grc-block', block.key);
      e.dataTransfer.effectAllowed = 'copy';
      hideTooltip();
    });
    item.addEventListener('click', () => {
      const index = this.visible.indexOf(item);
      if (index >= 0) this._select(index);
    });
    item.addEventListener('dblclick', () => this.app.addBlockAtCenter(block.key));
    item.addEventListener('mouseenter', (e) => {
      const doc = block.doc ? '\n\n' + block.doc.slice(0, 500) : '';
      showTooltip(`${block.label}\n${block.key}${path.length ? '\n' + path.join(' / ') : ''}${doc}`, e.clientX, e.clientY, 700);
    });
    item.addEventListener('mouseleave', hideTooltip);
    return item;
  }

  _select(index) {
    if (!this.visible.length) return;
    index = Math.max(0, Math.min(this.visible.length - 1, index));
    if (this.visible[this.selected]) this.visible[this.selected].classList.remove('sel');
    this.selected = index;
    this.visible[index].classList.add('sel');
    this.visible[index].scrollIntoView({ block: 'nearest' });
  }

  render() {
    this.tree.textContent = '';
    this.visible = [];
    this.selected = -1;
    if (!this.data) return;
    const query = this.search.value.trim().toLowerCase();
    if (!query) {
      this.tree.append(this._browse(this.data, []));
      return;
    }
    // keep the categories of the matching blocks, all expanded
    const words = query.split(/\s+/);
    let best = null;
    let bestScore = Infinity;
    const filter = (node, path) => {
      const blocks = node.blocks.filter((b) => {
        const hay = `${b.label} ${b.key} ${path.join(' ')}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      for (const b of blocks) {
        const label = b.label.toLowerCase();
        const key = b.key.toLowerCase();
        let score = 3;
        if (label.startsWith(query) || key.startsWith(query)) score = 0;
        else if (label.includes(query)) score = 1;
        else if (key.includes(query)) score = 2;
        if (score < bestScore || (score === bestScore && b.label.localeCompare(best.label) < 0)) {
          best = b;
          bestScore = score;
        }
      }
      const children = node.children.map((c) => filter(c, path.concat(c.name))).filter(Boolean);
      const count = blocks.length + children.reduce((n, c) => n + c.count, 0);
      return count ? { name: node.name, blocks, children, path, count } : null;
    };
    const found = filter(this.data, []);
    if (!found) {
      this.tree.append(el('div', { class: 'muted lib-count' }, 'No blocks found'));
      return;
    }
    this.tree.append(el('div', { class: 'muted lib-count' },
      `${found.count} block${found.count === 1 ? '' : 's'} · ↑↓ to choose, Enter to add`));
    const draw = (node) => {
      const frag = document.createDocumentFragment();
      for (const child of node.children) {
        frag.append(el('details', { open: true },
          el('summary', {}, child.name, el('span', { class: 'count' }, String(child.count))), draw(child)));
      }
      for (const b of node.blocks) {
        const item = this._item(b, node.path, words);
        if (b === best) this.selected = this.visible.length;
        this.visible.push(item);
        frag.append(item);
      }
      return frag;
    };
    this.tree.append(draw(found));
    this._select(this.selected);
  }

  // the full tree, categories filled when they are opened
  _browse(node, path) {
    const frag = document.createDocumentFragment();
    for (const child of node.children) {
      const details = el('details', {}, el('summary', {}, child.name));
      details.addEventListener('toggle', () => {
        if (details.open && !details.dataset.filled) {
          details.dataset.filled = '1';
          details.append(this._browse(child, path.concat(child.name)));
        }
      });
      frag.append(details);
    }
    for (const b of node.blocks) frag.append(this._item(b, path, null));
    return frag;
  }
}

// label with the searched words marked
function highlight(text, words) {
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) {
      for (let k = i; k < i + w.length; k++) marks[k] = true;
    }
  }
  const out = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    out.push(marks[i] ? el('mark', {}, text.slice(i, j)) : text.slice(i, j));
    i = j;
  }
  return out;
}

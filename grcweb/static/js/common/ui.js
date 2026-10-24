// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// Small DOM toolkit: element builder, dialogs, menus, toasts, tooltips, icons, theme.
'use strict';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------------------------------------------------------------- theme
export function initTheme() {
  let theme = null;
  try { theme = localStorage.getItem('grcweb.theme'); } catch (e) { /* ignore */ }
  if (!theme) theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('grcweb.theme', next); } catch (e) { /* ignore */ }
  window.dispatchEvent(new CustomEvent('themechange'));
  return next;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// --------------------------------------------------------------- toasts
let toastStack = null;
export function toast(message, kind = '', ms = 3500) {
  if (!toastStack) {
    toastStack = el('div', { class: 'toast-stack' });
    document.body.append(toastStack);
  }
  const node = el('div', { class: 'toast ' + kind }, message);
  toastStack.append(node);
  setTimeout(() => node.remove(), kind === 'err' ? Math.max(ms, 6000) : ms);
}

// -------------------------------------------------------------- dialogs
export function modal({ title, sub, body, buttons = [], cls = '', onClose, tabs, foot } = {}) {
  const back = el('div', { class: 'modal-back' });
  const box = el('div', { class: 'modal ' + cls, role: 'dialog', 'aria-modal': 'true' });
  const head = el('div', { class: 'modal-head' }, el('h2', {}, title || ''), sub ? el('span', { class: 'sub' }, sub) : null);
  const bodyBox = el('div', { class: 'modal-body' }, body || '');
  const footBox = el('div', { class: 'modal-foot' }, foot ? el('div', { class: 'left' }, foot) : null);
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose(result);
  };
  for (const b of buttons) {
    const button = el('button', { class: 'btn ' + (b.cls || ''), type: 'button' }, b.label);
    button.addEventListener('click', () => b.action ? b.action(close, button) : close(b.value));
    if (b.id) button.dataset.id = b.id;
    footBox.append(button);
  }
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      const cancel = buttons.find((b) => b.cancel);
      if (cancel && cancel.action) cancel.action(close); else close(null);
    }
  };
  document.addEventListener('keydown', onKey, true);
  box.append(head);
  if (tabs) box.append(tabs);
  box.append(bodyBox, footBox);
  if (tabs) box.style.gridTemplateRows = 'auto auto 1fr auto';
  back.append(box);
  back.addEventListener('mousedown', (event) => {
    if (event.target === back) {
      const cancel = buttons.find((b) => b.cancel);
      if (cancel && cancel.action) cancel.action(close); else close(null);
    }
  });
  document.body.append(back);
  return { close, body: bodyBox, box, foot: footBox, head };
}

export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    modal({
      title, cls: 'small', body: el('div', { style: { whiteSpace: 'pre-wrap' } }, message),
      onClose: (v) => resolve(v === true),
      buttons: [
        { label: 'Cancel', value: false, cancel: true },
        { label: okLabel, value: true, cls: danger ? 'danger' : 'primary' },
      ],
    });
  });
}

export function choiceDialog(title, message, choices) {
  return new Promise((resolve) => {
    modal({
      title, cls: 'small', body: el('div', { style: { whiteSpace: 'pre-wrap' } }, message),
      onClose: (v) => resolve(v),
      buttons: choices,
    });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const input = el('input', { value, style: { width: '100%' } });
    const m = modal({
      title, cls: 'small',
      body: el('div', {}, el('div', { style: { marginBottom: '6px' } }, label), input),
      onClose: (v) => resolve(v),
      buttons: [
        { label: 'Cancel', value: null, cancel: true },
        { label: 'OK', cls: 'primary', action: (close) => close(input.value) },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.close(input.value); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// ---------------------------------------------------------------- menus
let openMenu = null;
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

export function contextMenu(x, y, items, cls = '') {
  closeMenu();
  const menu = el('div', { class: 'menu ' + cls });
  for (const item of items) {
    if (item === '-') { menu.append(el('hr')); continue; }
    if (item instanceof Node) { menu.append(item); continue; }
    const button = el('button', { type: 'button', disabled: item.disabled },
      el('span', {}, item.label), item.shortcut ? el('span', { class: 'sc' }, item.shortcut) : null);
    button.addEventListener('click', () => { closeMenu(); item.action(); });
    menu.append(button);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - rect.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, innerHeight - rect.height - 4)) + 'px';
  openMenu = menu;
  return menu;
}

document.addEventListener('mousedown', (event) => {
  if (openMenu && !openMenu.contains(event.target)) closeMenu();
}, true);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });

// ------------------------------------------------------------- tooltips
let tip = null;
let tipTimer = null;
export function showTooltip(text, x, y, delay = 350) {
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    if (!tip) { tip = el('div', { class: 'tooltip' }); document.body.append(tip); }
    tip.textContent = text;
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, innerWidth - r.width - 6) + 'px';
    tip.style.top = Math.min(y + 16, innerHeight - r.height - 6) + 'px';
  }, delay);
}
export function hideTooltip() {
  clearTimeout(tipTimer);
  if (tip) tip.style.display = 'none';
}

// ---------------------------------------------------------------- icons
const ICONS = {
  new: 'M6 2h8l4 4v16H6zM14 2v4h4M12 11v6M9 14h6',
  open: 'M3 6h6l2 2h10v11H3zM3 10h18',
  save: 'M5 3h12l3 3v15H5zM8 3v5h8V3M8 21v-7h8v7',
  saveas: 'M5 3h12l3 3v6M5 3v18h7M8 3v5h8V3M15 15l4 4M14 21l1-3 5-5 2 2-5 5z',
  undo: 'M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-3',
  redo: 'M15 7l5 5-5 5M20 12H9a5 5 0 000 10h3',
  cut: 'M6 6m-3 0a3 3 0 106 0a3 3 0 10-6 0M6 18m-3 0a3 3 0 106 0a3 3 0 10-6 0M8.5 7.5L20 19M8.5 16.5L20 5',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  paste: 'M9 4h6v3H9zM7 5H5v16h14V5h-2M9 12h6M9 16h6',
  del: 'M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3',
  rotl: 'M4 4v6h6M4.5 10A8 8 0 1112 20',
  rotr: 'M20 4v6h-6M19.5 10A8 8 0 1012 20',
  enable: 'M5 12l5 5L20 7',
  disable: 'M5 5l14 14M19 5L5 19',
  bypass: 'M3 12h4M17 12h4M7 6h10v12H7zM7 12c3-6 7-6 10 0',
  gen: 'M8 6l-6 6 6 6M16 6l6 6-6 6M14 4l-4 16',
  run: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  zin: 'M11 11m-7 0a7 7 0 1014 0a7 7 0 10-14 0M21 21l-5-5M8 11h6M11 8v6',
  zout: 'M11 11m-7 0a7 7 0 1014 0a7 7 0 10-14 0M21 21l-5-5M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  find: 'M10 10m-6 0a6 6 0 1012 0a6 6 0 10-12 0M20 20l-5.5-5.5',
  reload: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  theme: 'M12 3a9 9 0 109 9 7 7 0 01-9-9z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  lib: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  panel: 'M3 4h18v16H3zM3 15h18',
  runs: 'M4 6h16M4 12h16M4 18h10',
  pause: 'M7 5h3v14H7zM14 5h3v14h-3z',
  play: 'M7 4l13 8-13 8z',
  max: 'M4 4h16v16H4z',
  pop: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  close: 'M6 6l12 12M18 6L6 18',
  key: 'M7 14a4 4 0 110-8 4 4 0 010 8zM10.5 9.5H21M17 9.5v3M20 9.5v2',
  code: 'M8 6l-6 6 6 6M16 6l6 6-6 6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  folder: 'M3 6h6l2 2h10v11H3z',
  file: 'M6 2h8l4 4v16H6zM14 2v4h4',
  up: 'M12 19V5M5 12l7-7 7 7',
  home: 'M3 11l9-8 9 8M5 9v11h14V9',
  plus: 'M12 5v14M5 12h14',
  hold: 'M4 18l5-8 4 4 7-10M4 4v16h16',
  autoscale: 'M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  camera: 'M4 7h4l2-3h4l2 3h4v12H4zM12 13m-3 0a3 3 0 106 0a3 3 0 10-6 0',
  help: 'M12 12m-9 0a9 9 0 1018 0a9 9 0 10-18 0M9.5 9a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5M12 17h.01',
};

export function icon(name) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: ICONS[name] || ICONS.file }));
  return svg;
}

export function iconButton(name, title, onClick, cls = '') {
  const button = el('button', { class: 'tb-btn ' + cls, type: 'button', title, 'aria-label': title }, icon(name));
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

// --------------------------------------------------------------- helpers
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = performance.now(); fn(...lastArgs); }, ms - (now - last));
    }
  };
}

export function isTyping(event) {
  const t = event.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// engineering notation like GNU Radio's eng_notation
export function eng(value, digits = 4) {
  if (!isFinite(value)) return String(value);
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const units = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']];
  for (const [f, s] of units) {
    if (abs >= f * 0.9999999) return +(value / f).toPrecision(digits) + s;
  }
  return value.toPrecision(digits);
}

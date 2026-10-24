// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// Block properties dialog: live validation through the GRC core, like the GTK dialog.
'use strict';

import { el, modal, toast } from '../common/ui.js';
import { editCode } from './codeedit.js';
import { chooseFile } from './files.js';

const DTYPE_COLORS = {
  complex: '#3399FF', real: '#FF8C69', float: '#FF8C69', int: '#00FF99',
  complex_vector: '#3399AA', real_vector: '#CC8C69', float_vector: '#CC8C69', int_vector: '#00CC99',
  bool: '#00FF99', hex: '#00FF99', string: '#CC66CC', id: '#DDDDDD', stream_id: '#DDDDDD',
};

export async function openProps(app, doc, name) {
  let props;
  try {
    props = await app.edit('props_begin', { name }, doc);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  let currentName = props.name;
  let pending = {};
  let busy = Promise.resolve();
  let activeTab = null;
  let finished = false;

  const tabsBar = el('div', { class: 'mtabs' });
  const errorBox = el('div');
  const content = el('div');
  const body = el('div', {}, content, errorBox);

  const send = () => {
    const values = pending;
    pending = {};
    if (!Object.keys(values).length) return busy;
    busy = busy.then(async () => {
      try {
        props = await app.edit('props_preview', { name: currentName, values }, doc);
        currentName = props.name;
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    return busy;
  };
  let timer = null;
  const schedule = (key, value, immediate) => {
    pending[key] = value;
    clearTimeout(timer);
    if (immediate) send(); else timer = setTimeout(send, 350);
  };

  const finish = async (commit, close) => {
    if (finished) return;
    clearTimeout(timer);
    await send();
    await busy;
    finished = true;
    try {
      await app.edit('props_end', { commit }, doc);
    } catch (err) {
      toast(err.message, 'err');
    }
    close();
    app.focusCanvas();
  };

  const m = modal({
    title: props.label, sub: currentName, cls: 'wide', tabs: tabsBar, body,
    buttons: [
      { label: 'Cancel', cancel: true, action: (close) => finish(false, close) },
      {
        label: 'Apply', action: async () => {
          clearTimeout(timer);
          await send();
          await busy;
          await app.edit('props_end', { commit: true }, doc);
          props = await app.edit('props_begin', { name: currentName }, doc);
          render();
        },
      },
      { label: 'OK', cls: 'primary', action: (close) => finish(true, close) },
    ],
  });
  m.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.isComposing) {
      e.preventDefault();
      finish(true, m.close);
    }
  });

  function paramInput(p) {
    const wrap = el('div', { class: 'pinput' + (p.valid ? '' : ' bad') });
    const color = DTYPE_COLORS[p.dtype];
    let input;
    if (p.dtype === '_multiline_python_external') {
      const preview = el('input', { value: (p.value.split('\n').find((l) => l.trim() && !l.trim().startsWith('"""')) || '').slice(0, 80), readOnly: true, class: 'raw' });
      const button = el('button', { class: 'btn', type: 'button' }, 'Open in editor…');
      button.addEventListener('click', () => {
        editCode({
          title: `${props.label} — ${currentName}`,
          value: p.value,
          onApply: async (code) => {
            schedule(p.key, code, true);
            await busy;
            const now = props.params.find((q) => q.key === p.key);
            if (now && !now.valid) throw new Error(now.tip.split('\n').slice(-1)[0]);
          },
        });
      });
      wrap.append(preview, button);
      return wrap;
    }
    if (p.enum) {
      input = el('select');
      for (const [value, label] of p.options) input.append(el('option', { value }, label));
      input.value = p.value;
      input.addEventListener('change', () => schedule(p.key, input.value, true));
    } else if (p.dtype === '_multiline') {
      input = el('textarea', { rows: Math.min(10, Math.max(3, p.value.split('\n').length)) });
      input.value = p.value;
      input.addEventListener('input', () => schedule(p.key, input.value));
    } else {
      input = el('input', { class: p.dtype === 'string' ? '' : 'raw', spellcheck: 'false' });
      input.value = p.value;
      if (p.options) {
        const listId = 'dl-' + Math.random().toString(36).slice(2);
        const list = el('datalist', { id: listId });
        for (const [value, label] of p.options) list.append(el('option', { value, label }));
        input.setAttribute('list', listId);
        wrap.append(list);
      }
      input.addEventListener('input', () => schedule(p.key, input.value));
      input.addEventListener('change', () => schedule(p.key, input.value, true));
    }
    input.dataset.key = p.key;
    if (color) wrap.append(el('span', { class: 'dt', style: { background: color }, title: p.dtype }));
    wrap.append(input);
    if (['file_open', 'file_save', 'dir_select'].includes(p.dtype)) {
      const button = el('button', { class: 'btn small', type: 'button' }, '…');
      button.addEventListener('click', async () => {
        const raw = input.value.replace(/^['"]|['"]$/g, '');
        const path = await chooseFile(app, {
          mode: p.dtype === 'file_save' ? 'save' : p.dtype === 'dir_select' ? 'dir' : 'open',
          start: raw || (doc.meta.path ? doc.meta.path.replace(/[^/]*$/, '') : ''),
          filter: '',
        });
        if (path) {
          input.value = path;
          schedule(p.key, path, true);
        }
      });
      wrap.append(button);
    }
    return wrap;
  }

  function render() {
    m.head.querySelector('.sub').textContent = currentName;
    m.head.querySelector('h2').textContent = props.label;
    const active = document.activeElement;
    const focused = active && active.dataset && active.dataset.key;
    const selection = focused ? [active.selectionStart, active.selectionEnd] : null;
    // keep what the user typed while the preview was on its way
    const typed = focused && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') ? active.value : null;
    const categories = [];
    for (const p of props.params) if (!categories.includes(p.category)) categories.push(p.category);
    const tabs = [...categories, 'Documentation', 'Generated Code'];
    if (!tabs.includes(activeTab)) activeTab = tabs[0];
    tabsBar.textContent = '';
    for (const tab of tabs) {
      const b = el('button', { class: tab === activeTab ? 'on' : '', type: 'button' }, tab);
      b.addEventListener('click', () => { activeTab = tab; render(); });
      tabsBar.append(b);
    }
    content.textContent = '';
    errorBox.textContent = '';
    if (activeTab === 'Documentation') {
      const entries = Object.entries(props.docs);
      if (props.doc_url) content.append(el('p', {}, el('a', { href: props.doc_url, target: '_blank', rel: 'noopener' }, props.doc_url)));
      if (!entries.length) content.append(el('p', { class: 'muted' }, 'This GNU Radio installation has no documentation for this block.'));
      const wiki = 'https://wiki.gnuradio.org/index.php?search=' + encodeURIComponent(props.label);
      content.append(el('p', {}, el('a', { href: wiki, target: '_blank', rel: 'noopener noreferrer' }, `Search "${props.label}" in the GNU Radio wiki`)));
      for (const [key, text] of entries) {
        if (key) content.append(el('div', { class: 'doc-key mono' }, key));
        content.append(el('pre', { class: 'doc' }, text));
      }
      return;
    }
    if (activeTab === 'Generated Code') {
      content.append(el('pre', { class: 'doc' }, props.code || ''));
      return;
    }
    const grid = el('div', { class: 'params' });
    for (const p of props.params.filter((q) => q.category === activeTab)) {
      const label = el('div', { class: 'plabel' + (p.cb ? ' cb' : '') + (p.valid ? '' : ' bad'), title: p.tip }, p.name);
      grid.append(label, paramInput(p));
    }
    content.append(grid);
    if (props.errors.length) errorBox.append(el('div', { class: 'block-errors' }, props.errors.join('\n')));
    if (focused) {
      const again = content.querySelector(`[data-key="${CSS.escape(focused)}"]`);
      if (again) {
        if (typed !== null && again.value !== typed) again.value = typed;
        again.focus();
        if (selection && again.setSelectionRange && selection[0] !== null) {
          try { again.setSelectionRange(selection[0], selection[1]); } catch (e) { /* not a text field */ }
        }
      }
    }
  }

  render();
  const first = content.querySelector('input:not([readonly]), select, textarea');
  if (first) first.focus();
}

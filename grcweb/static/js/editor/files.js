// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// Server-side file browser: open/save flow graphs, pick files for parameters,
// upload from / download to the local computer.
'use strict';

import { el, modal, icon, toast, promptDialog, fmtBytes } from '../common/ui.js';

const LAST_DIR = 'grcweb.lastDir';

function lastDir() {
  try { return localStorage.getItem(LAST_DIR) || ''; } catch (e) { return ''; }
}

export function chooseFile(app, { mode = 'open', start = '', filter = '.grc', title, defaultName = '' } = {}) {
  return new Promise((resolve) => {
    let current = '';
    let selected = null;
    let listing = null;
    const pathLabel = el('div', { class: 'path' });
    const list = el('div', { class: 'files-list' });
    const nameInput = el('input', { value: defaultName, placeholder: 'file name', spellcheck: 'false' });
    const showAll = el('input', { type: 'checkbox', checked: !filter });
    const rootSel = el('select');
    const uploadInput = el('input', { type: 'file', multiple: true, class: 'hidden' });

    const choose = (path) => {
      try { localStorage.setItem(LAST_DIR, current); } catch (e) { /* ignore */ }
      m.close(path);
    };

    const load = async (path) => {
      try {
        listing = await app.api.call('files.list', { path });
      } catch (err) {
        if (path) { toast(err.message, 'err'); return load(''); }
        toast(err.message, 'err');
        return;
      }
      current = listing.path;
      selected = null;
      pathLabel.textContent = current;
      pathLabel.title = current;
      rootSel.textContent = '';
      for (const root of listing.roots) rootSel.append(el('option', { value: root }, root));
      rootSel.value = listing.roots.find((r) => current.startsWith(r)) || listing.roots[0];
      render();
    };

    const render = () => {
      list.textContent = '';
      if (listing.parent) {
        const up = el('div', { class: 'f' }, icon('up'), el('span', {}, '..'), el('span'));
        up.addEventListener('dblclick', () => load(listing.parent));
        up.addEventListener('click', () => load(listing.parent));
        list.append(up);
      }
      for (const entry of listing.entries) {
        const matches = entry.dir || showAll.checked || !filter || entry.name.endsWith(filter);
        if (!matches && mode !== 'dir') continue;
        const full = current.replace(/\/$/, '') + '/' + entry.name;
        const row = el('div', { class: 'f' + (!entry.dir && mode === 'dir' ? ' dim' : '') },
          icon(entry.dir ? 'folder' : 'file'), el('span', {}, entry.name),
          el('span', { class: 'muted' }, entry.dir ? '' : fmtBytes(entry.size)));
        row.addEventListener('click', () => {
          list.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel'));
          row.classList.add('sel');
          selected = { ...entry, path: full };
          if (!entry.dir && mode === 'save') nameInput.value = entry.name;
        });
        row.addEventListener('dblclick', () => {
          if (entry.dir) load(full);
          else if (mode !== 'dir') choose(full);
        });
        list.append(row);
      }
    };

    const accept = async () => {
      if (mode === 'dir') return choose(selected && selected.dir ? selected.path : current);
      if (mode === 'save') {
        let name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        if (filter && !name.endsWith(filter)) name += filter;
        return choose(name.startsWith('/') ? name : current.replace(/\/$/, '') + '/' + name);
      }
      if (selected && selected.dir) return load(selected.path);
      if (selected) return choose(selected.path);
      toast('Select a file');
    };

    uploadInput.addEventListener('change', async () => {
      if (!uploadInput.files.length) return;
      const form = new FormData();
      form.append('dir', current);
      for (const f of uploadInput.files) form.append('file', f, f.name);
      try {
        const r = await fetch('/api/files/upload', { method: 'POST', body: form, credentials: 'same-origin' });
        if (!r.ok) throw new Error(await r.text());
        toast(`Uploaded ${uploadInput.files.length} file(s)`, 'ok');
      } catch (err) {
        toast('Upload failed: ' + err.message, 'err');
      }
      uploadInput.value = '';
      load(current);
    });

    const bar = el('div', { class: 'files-bar' },
      rootSel,
      el('button', { class: 'btn small', type: 'button', title: 'Parent folder', onclick: () => listing && listing.parent && load(listing.parent) }, icon('up')),
      pathLabel,
      el('button', {
        class: 'btn small', type: 'button', title: 'New folder', onclick: async () => {
          const name = await promptDialog('New folder', 'Folder name');
          if (!name) return;
          try { await app.api.call('files.mkdir', { path: current, name }); load(current); } catch (err) { toast(err.message, 'err'); }
        },
      }, icon('plus'), 'Folder'),
      el('button', { class: 'btn small', type: 'button', title: 'Upload from this computer', onclick: () => uploadInput.click() }, icon('upload'), 'Upload'),
      el('button', {
        class: 'btn small', type: 'button', title: 'Download the selected file', onclick: () => {
          if (!selected || selected.dir) { toast('Select a file to download'); return; }
          window.open('/api/files/download?path=' + encodeURIComponent(selected.path), '_blank');
        },
      }, icon('download'), 'Download'),
      uploadInput);
    rootSel.addEventListener('change', () => load(rootSel.value));
    showAll.addEventListener('change', render);

    const body = el('div', {}, bar, list);
    if (mode === 'save') body.append(el('div', { class: 'files-name' }, el('span', {}, 'Name'), nameInput));
    if (filter) body.append(el('label', { class: 'muted', style: { display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center' } }, showAll, 'Show all files'));

    const m = modal({
      title: title || { open: 'Open', save: 'Save as', dir: 'Choose folder' }[mode], body,
      onClose: (v) => resolve(typeof v === 'string' ? v : null),
      buttons: [
        { label: 'Cancel', value: null, cancel: true },
        { label: { open: 'Open', save: 'Save', dir: 'Select folder' }[mode], cls: 'primary', action: () => accept() },
      ],
    });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') accept(); });
    load(start || lastDir());
    if (mode === 'save') setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  });
}

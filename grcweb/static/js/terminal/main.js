// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// One server terminal in its own browser tab (/terminal?id=...).
'use strict';

import { el, initTheme } from '../common/ui.js';
import { TermView } from '../common/terminal.js';

initTheme();
window.addEventListener('storage', (e) => {
  if (e.key !== 'grcweb.theme') return;
  initTheme();
  window.dispatchEvent(new CustomEvent('themechange'));
});

async function main() {
  const id = new URLSearchParams(location.search).get('id') || '';
  const pane = document.getElementById('term');
  const r = await fetch('/api/terminals', { credentials: 'same-origin' });
  if (r.status === 401) { location.replace('/login'); return; }
  const data = await r.json();
  const info = data.terminals.find((t) => t.id === id);
  if (!info) {
    pane.append(el('div', { class: 'term-missing' }, 'This terminal is closed. Open a new one from the editor.'));
    return;
  }
  const name = `Terminal ${info.number}`;
  document.title = `${name} — GRC Web`;
  const view = new TermView(pane, id, {
    onTitle: (title) => { document.title = `${title || name} — GRC Web`; },
    onClose: () => window.close(),
  });
  view.focus();
}

main();

// Lightweight Python code editor (textarea + highlighted overlay), no dependencies.
'use strict';

import { el, modal } from '../common/ui.js';

const KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except ' +
  'finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case').split(' '));
const BUILTINS = new Set(('self print len range int float complex str list dict tuple set bool abs min max sum ' +
  'enumerate zip map filter isinstance super object type open round sorted reversed any all np numpy gr pmt').split(' '));

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightPython(code) {
  const re = /("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(#[^\n]*)|(@[\w.]+)|(\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?j?\b|\b0[xXbBoO][\da-fA-F_]+\b)|([A-Za-z_]\w*)/g;
  let out = '';
  let last = 0;
  let prevWord = '';
  let m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    const text = escapeHtml(m[0]);
    if (m[1]) out += `<span class="tok-str">${text}</span>`;
    else if (m[2]) out += `<span class="tok-com">${text}</span>`;
    else if (m[3]) out += `<span class="tok-dec">${text}</span>`;
    else if (m[4]) out += `<span class="tok-num">${text}</span>`;
    else if (m[5]) {
      if (prevWord === 'def' || prevWord === 'class') out += `<span class="tok-def">${text}</span>`;
      else if (KEYWORDS.has(m[5])) out += `<span class="tok-kw">${text}</span>`;
      else if (BUILTINS.has(m[5])) out += `<span class="tok-bi">${text}</span>`;
      else out += text;
      prevWord = m[5];
      last = re.lastIndex;
      continue;
    }
    prevWord = '';
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out + '\n';
}

export class CodeEditor {
  constructor(value = '') {
    this.gutter = el('div', { class: 'gutter' });
    this.pre = el('pre', { 'aria-hidden': 'true' });
    this.text = el('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off' });
    this.node = el('div', { class: 'code-editor' }, this.gutter, el('div', { class: 'area' }, this.pre, this.text));
    this.text.value = value;
    this.text.addEventListener('input', () => this.refresh());
    this.text.addEventListener('scroll', () => this.sync());
    this.text.addEventListener('keydown', (e) => this.onKey(e));
    this.refresh();
  }

  get value() { return this.text.value; }

  set value(v) { this.text.value = v; this.refresh(); }

  refresh() {
    this.pre.innerHTML = highlightPython(this.text.value);
    const lines = this.text.value.split('\n').length;
    let nums = '';
    for (let i = 1; i <= lines; i++) nums += i + '\n';
    this.gutter.textContent = nums;
    this.sync();
  }

  sync() {
    this.pre.scrollTop = this.text.scrollTop;
    this.pre.scrollLeft = this.text.scrollLeft;
    this.gutter.scrollTop = this.text.scrollTop;
  }

  _replace(start, end, insert, selStart, selEnd) {
    this.text.setRangeText(insert, start, end, 'end');
    if (selStart !== undefined) this.text.setSelectionRange(selStart, selEnd);
    this.refresh();
  }

  onKey(e) {
    const t = this.text;
    const { selectionStart: s, selectionEnd: en, value } = t;
    if (e.key === 'Tab') {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      if (s === en && !e.shiftKey) {
        this._replace(s, en, '    ');
        return;
      }
      const block = value.slice(lineStart, en);
      const lines = block.split('\n');
      const changed = e.shiftKey
        ? lines.map((l) => l.replace(/^ {1,4}/, ''))
        : lines.map((l) => '    ' + l);
      const joined = changed.join('\n');
      this._replace(lineStart, en, joined, lineStart, lineStart + joined.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const line = value.slice(lineStart, s);
      let indent = line.match(/^\s*/)[0];
      if (/:\s*(#.*)?$/.test(line)) indent += '    ';
      this._replace(s, en, '\n' + indent);
    } else if (e.key === 'Backspace' && s === en && s > 0) {
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const before = value.slice(lineStart, s);
      if (before.length && /^ +$/.test(before)) {
        e.preventDefault();
        const remove = before.length % 4 || 4;
        this._replace(s - remove, s, '');
      }
    } else if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = value.indexOf('\n', en);
      if (lineEnd < 0) lineEnd = value.length;
      const lines = value.slice(lineStart, lineEnd).split('\n');
      const commented = lines.every((l) => /^\s*#/.test(l) || !l.trim());
      const out = lines.map((l) => commented ? l.replace(/^(\s*)# ?/, '$1') : (l.trim() ? l.replace(/^(\s*)/, '$1# ') : l)).join('\n');
      this._replace(lineStart, lineEnd, out, lineStart, lineStart + out.length);
    }
  }

  focus() { this.text.focus(); }
}

// Modal editor used for Python blocks/modules and multiline parameters.
export function editCode({ title, value, onApply }) {
  return new Promise((resolve) => {
    const editor = new CodeEditor(value);
    const status = el('span', {}, 'Ctrl+S apply · Tab/Shift+Tab indent · Ctrl+/ comment');
    let current = value;
    const apply = async () => {
      if (!onApply) return true;
      status.textContent = 'Applying…';
      try {
        await onApply(editor.value);
        current = editor.value;
        status.textContent = 'Applied ✓';
        return true;
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
        return false;
      }
    };
    const m = modal({
      title, cls: 'wide', body: editor.node, foot: status,
      onClose: () => resolve(current),
      buttons: [
        { label: 'Close', cancel: true, action: (close) => close() },
        { label: 'Apply', action: () => apply() },
        { label: 'Apply & close', cls: 'primary', action: async (close) => { if (await apply()) close(); } },
      ],
    });
    editor.text.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); apply(); }
    });
    m.body.style.padding = '8px';
    setTimeout(() => editor.focus(), 0);
  });
}

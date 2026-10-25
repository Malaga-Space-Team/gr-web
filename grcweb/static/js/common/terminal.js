// Copyright 2026 Málaga Space Team
// SPDX-License-Identifier: GPL-3.0-or-later

// A server terminal shown with xterm.js: the byte stream of /ws/term, with
// reconnection, replay of the recent output, flow control and copy/paste.
'use strict';

import { Terminal } from '../../vendor/xterm/xterm.js';
import { FitAddon } from '../../vendor/xterm/addon-fit.js';
import { el, contextMenu, cssVar, toast } from './ui.js';

const HIGH_WATER = 1024 * 1024; // bytes xterm.js has not parsed yet: ask the server to pause
const LOW_WATER = 128 * 1024;

const PALETTES = {
  dark: {
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8',
    magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c',
    brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
    brightCyan: '#29b8db', brightWhite: '#ffffff',
  },
  light: {
    black: '#000000', red: '#cd3131', green: '#00a000', yellow: '#949800', blue: '#0451a5',
    magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131',
    brightGreen: '#14a014', brightYellow: '#9a9e00', brightBlue: '#0451a5', brightMagenta: '#bc05bc',
    brightCyan: '#0598bc', brightWhite: '#a5a5a5',
  },
};

function theme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    ...PALETTES[dark ? 'dark' : 'light'],
    background: cssVar('--term-bg'), foreground: cssVar('--term-fg'),
    cursor: cssVar('--term-fg'), cursorAccent: cssVar('--term-bg'),
    selectionBackground: dark ? 'rgba(91, 147, 255, .38)' : 'rgba(37, 99, 235, .25)',
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // plain HTTP has no clipboard API
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export class TermView {
  // events: onTitle(title), onExit(code), onGone(), onClose() (Enter after the shell exited)
  constructor(container, id, events = {}) {
    this.container = container;
    this.id = id;
    this.events = events;
    this.ws = null;
    this.retry = 0;
    this.exited = false;
    this.disposed = false;
    this.replayLeft = 0;
    this.quiet = false; // while replaying: do not answer old terminal queries again
    this.unparsed = 0;
    this.pauseSent = false;

    this.term = new Terminal({
      fontFamily: cssVar('--mono'), fontSize: 13, lineHeight: 1.1, cursorBlink: true,
      scrollback: 5000, theme: theme(),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.host = el('div', { class: 'term-host' }); // the fit addon measures this box
    container.append(this.host);
    this.term.open(this.host);
    this.term.onData((data) => {
      if (this.exited) {
        if (data === '\r' && this.events.onClose) this.events.onClose();
        return;
      }
      if (!this.quiet) this._send({ t: 'in', d: data });
    });
    this.term.onBinary((data) => { if (!this.quiet && !this.exited) this._send({ t: 'bin', d: data }); });
    this.term.onResize(({ cols, rows }) => this._send({ t: 'resize', cols, rows }));
    this.term.onTitleChange((title) => { if (this.events.onTitle) this.events.onTitle(title); });
    this.term.attachCustomKeyEventHandler((e) => this._key(e));
    container.addEventListener('contextmenu', (e) => { e.preventDefault(); this._menu(e.clientX, e.clientY); });

    this._onTheme = () => { this.term.options.theme = theme(); };
    window.addEventListener('themechange', this._onTheme);
    this._resizer = new ResizeObserver(() => this.resize());
    this._resizer.observe(container);
    this.resize();
    this._connect();
  }

  // ------------------------------------------------------------ stream
  _connect() {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/term?id=' + encodeURIComponent(this.id);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', cols: this.term.cols, rows: this.term.rows }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') { this._output(new Uint8Array(event.data)); return; }
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.t === 'hello') {
        this.term.reset();
        this.unparsed = 0;
        this.pauseSent = false;
        this.replayLeft = msg.replay;
        this.exited = !msg.alive;
        if (!this.replayLeft && this.exited) this._exitNotice(msg.exit_code);
        this.exitCode = msg.exit_code;
      } else if (msg.t === 'exit') {
        this._exitNotice(msg.code);
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.disposed || this.exited) return;
      if (event.code === 4401) { location.replace('/login'); return; }
      const delay = Math.min(10000, 300 * 2 ** this.retry++);
      setTimeout(() => this._reconnect(), delay);
    };
  }

  async _reconnect() {
    if (this.disposed) return;
    try {
      const r = await fetch('/api/terminals', { credentials: 'same-origin' });
      if (r.status === 401) { location.replace('/login'); return; }
      const data = await r.json();
      if (!data.terminals.some((t) => t.id === this.id)) { this._gone(); return; }
    } catch (e) {
      setTimeout(() => this._reconnect(), Math.min(10000, 300 * 2 ** this.retry++));
      return;
    }
    this._connect();
  }

  _gone() {
    this.term.write('\r\n\x1b[2m[This terminal was closed on the server]\x1b[0m\r\n');
    this.exited = true;
    if (this.events.onGone) this.events.onGone();
  }

  _output(bytes) {
    if (this.replayLeft > 0) {
      const n = Math.min(this.replayLeft, bytes.length);
      this.replayLeft -= n;
      const replay = bytes.subarray(0, n);
      this.quiet = true;
      const done = !this.replayLeft;
      this._write(replay, () => {
        if (!done) return;
        this.quiet = false;
        if (this.exited) this._exitNotice(this.exitCode);
      });
      bytes = bytes.subarray(n);
      if (!bytes.length) return;
    }
    this._write(bytes);
  }

  // xterm.js parses asynchronously: count what it still has to parse
  _write(bytes, callback) {
    const size = bytes.length;
    this.unparsed += size;
    if (!this.pauseSent && this.unparsed > HIGH_WATER) {
      this.pauseSent = true;
      this._send({ t: 'pause' });
    }
    this.term.write(bytes, () => {
      this.unparsed -= size;
      if (this.pauseSent && this.unparsed < LOW_WATER) {
        this.pauseSent = false;
        this._send({ t: 'resume' });
      }
      if (callback) callback();
    });
  }

  _exitNotice(code) {
    this.exited = true;
    this.term.write(`\r\n\x1b[2m[Shell exited with code ${code}. Press Enter to close this terminal.]\x1b[0m\r\n`);
    if (this.events.onExit) this.events.onExit(code);
  }

  _send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  // ---------------------------------------------------------- keyboard
  _key(e) {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl || e.altKey) return true;
    if (e.code === 'Backquote') return false; // the page toggles the terminal
    if (e.code === 'KeyC' && (e.shiftKey || this.term.hasSelection())) {
      e.preventDefault();
      this.copy();
      return false;
    }
    if (e.code === 'KeyV') return false; // the browser pastes into xterm.js
    return true;
  }

  async copy() {
    const text = this.term.getSelection();
    if (!text) return;
    if (await copyText(text)) this.term.clearSelection();
    else toast('The browser did not allow copying', 'err');
  }

  async paste() {
    try {
      this.term.paste(await navigator.clipboard.readText());
    } catch (e) {
      toast('Paste with Ctrl+V (the browser does not allow reading the clipboard here)');
    }
    this.focus();
  }

  _menu(x, y) {
    contextMenu(x, y, [
      { label: 'Copy', shortcut: 'Ctrl+Shift+C', action: () => this.copy(), disabled: !this.term.hasSelection() },
      { label: 'Paste', shortcut: 'Ctrl+V', action: () => this.paste() },
      { label: 'Select all', action: () => this.term.selectAll() },
      '-',
      { label: 'Clear scrollback', action: () => this.term.clear() },
    ]);
  }

  // -------------------------------------------------------------- misc
  resize() {
    if (this.disposed || !this.container.offsetWidth || !this.container.offsetHeight) return;
    try { this.fit.fit(); } catch (e) { /* not measurable yet */ }
  }

  focus() { this.term.focus(); }

  dispose() {
    this.disposed = true;
    window.removeEventListener('themechange', this._onTheme);
    this._resizer.disconnect();
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
    this.term.dispose();
    this.host.remove();
  }
}

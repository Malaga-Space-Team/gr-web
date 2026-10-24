// WebSocket client: request/response RPC, server events and binary plot frames.
'use strict';

export class Api {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.frameHandler = null;
    this.connected = false;
    this.retry = 0;
    this.decoder = new TextDecoder();
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
  }

  emit(event, data) {
    for (const fn of this.handlers.get(event) || []) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }

  connect() {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.emit('open');
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') this._onText(event.data);
      else this._onBinary(event.data);
    };
    ws.onclose = (event) => {
      const was = this.connected;
      this.connected = false;
      for (const { reject } of this.pending.values()) reject(new Error('Connection lost'));
      this.pending.clear();
      if (was) this.emit('close');
      if (event.code === 1008 || event.code === 4401) { location.replace('/login'); return; }
      this._checkSession().then((ok) => {
        if (!ok) { location.replace('/login'); return; }
        const delay = Math.min(10000, 500 * 2 ** this.retry++);
        setTimeout(() => this.connect(), delay);
      });
    };
  }

  async _checkSession() {
    try {
      const r = await fetch('/api/library', { method: 'HEAD', credentials: 'same-origin' });
      return r.status !== 401;
    } catch (e) {
      return true; // server down: keep retrying
    }
  }

  _onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.ev) {
      if (msg.ev === 'logout') { location.replace('/login'); return; }
      this.emit(msg.ev, msg);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(Object.assign(new Error(msg.error || 'Error'), { server: true }));
  }

  _onBinary(buffer) {
    const view = new DataView(buffer);
    const hlen = view.getUint32(0, true);
    const header = JSON.parse(this.decoder.decode(new Uint8Array(buffer, 4, hlen)));
    const payload = buffer.slice(4 + hlen); // aligned copy
    if (this.frameHandler) this.frameHandler(header, payload);
  }

  call(op, args = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected to the server'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, op, args }));
    });
  }

  // fire and forget (no reply expected)
  send(op, args = {}) {
    if (this.connected) this.ws.send(JSON.stringify({ op, args }));
  }
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  location.replace('/login');
}

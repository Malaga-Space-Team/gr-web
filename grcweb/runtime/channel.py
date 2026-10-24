# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""Link between a running flow graph and the grc-web server.

Plot frames are "latest wins": a sink overwrites its pending frame if the
previous one has not been sent yet, so a slow network never stalls the GNU
Radio scheduler. Row based plots (waterfall, raster) append rows instead.
Control messages (widget descriptions, value updates) are never dropped.

Without GRCWEB_SOCKET (the generated file run by hand) everything is a no-op.
"""

import collections
import json
import logging
import os
import socket
import struct
import threading
import weakref

log = logging.getLogger('grcweb.runtime')

_HEADER = struct.Struct('<II')
MAX_MERGED_ROWS = 512


def _json_default(value):
    try:
        import numpy
        if isinstance(value, numpy.generic):
            return value.item()
        if isinstance(value, numpy.ndarray):
            return value.tolist()
    except ImportError:
        pass
    if isinstance(value, complex):
        return [value.real, value.imag]
    return str(value)


def dumps(value):
    return json.dumps(value, default=_json_default)


class Channel:
    def __init__(self, path):
        self.items = {}
        self._tb = None
        self.viewers = 1
        self._cond = threading.Condition()
        self._control = collections.deque()
        self._frames = collections.OrderedDict()
        self._sock = None
        if path:
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.connect(path)
                self._sock = sock
            except OSError as error:
                log.warning('grc-web: cannot reach the server (%s); GUI output disabled', error)
        if self._sock is not None:
            threading.Thread(target=self._sender, name='grcweb-tx', daemon=True).start()
            threading.Thread(target=self._receiver, name='grcweb-rx', daemon=True).start()

    @property
    def connected(self):
        return self._sock is not None

    @property
    def active(self):
        """True when someone is looking at the plots."""
        return self._sock is not None and self.viewers > 0

    # ------------------------------------------------------------ outgoing
    def attach(self, tb):
        if self._tb is None:
            self._tb = weakref.ref(tb)

    @property
    def tb(self):
        return self._tb() if self._tb else None

    def register(self, item):
        self.items[item.item_name] = item

    def send_control(self, header, payload=b''):
        if self._sock is None:
            return
        with self._cond:
            self._control.append((header, payload))
            self._cond.notify()

    def send_item(self, name, config):
        self.send_control({'t': 'item', 'name': name, 'config': config})

    def send_value(self, name, value):
        self.send_control({'t': 'value', 'name': name, 'value': value})

    def log(self, text):
        self.send_control({'t': 'log', 'text': text})

    def publish(self, key, header, payload):
        """Queue a frame; replaces a pending frame with the same key."""
        if self._sock is None:
            return
        header['t'] = 'frame'
        with self._cond:
            self._frames[key] = (header, payload)
            self._frames.move_to_end(key)
            self._cond.notify()

    def publish_rows(self, key, header, payload, row_header_keys=('scale',)):
        """Queue rows of a waterfall-like plot; pending rows are kept and merged."""
        if self._sock is None:
            return
        header['t'] = 'frame'
        with self._cond:
            pending = self._frames.get(key)
            if pending is not None and pending[0].get('cols') == header.get('cols') \
                    and pending[0].get('rows', 0) + header.get('rows', 0) <= MAX_MERGED_ROWS:
                old_header, old_payload = pending
                merged = dict(header)
                merged['rows'] = old_header['rows'] + header['rows']
                for k in row_header_keys:
                    if k in header:
                        merged[k] = old_header.get(k, []) + header[k]
                self._frames[key] = (merged, old_payload + payload)
            else:
                self._frames[key] = (header, payload)
            self._cond.notify()

    def _sender(self):
        sock = self._sock
        while True:
            with self._cond:
                while not self._control and not self._frames:
                    self._cond.wait()
                batch = list(self._control)
                self._control.clear()
                batch.extend(self._frames.values())
                self._frames.clear()
            try:
                for header, payload in batch:
                    data = dumps(header).encode()
                    sock.sendall(_HEADER.pack(len(data), len(payload)) + data)
                    if payload:
                        sock.sendall(payload)
            except OSError:
                self._sock = None
                return

    # ------------------------------------------------------------ incoming
    def _receiver(self):
        stream = self._sock.makefile('rb')
        for line in stream:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            try:
                self._dispatch(message)
            except Exception as error:
                log.exception('grc-web: error handling %r', message)
                self.log('>>> Error in web GUI handler: {}'.format(error))
        self._sock = None

    def _dispatch(self, message):
        kind = message.get('t')
        if kind == 'viewers':
            self.viewers = int(message.get('n', 0))
        elif kind == 'ui':
            item = self.items.get(message.get('name'))
            if item is not None:
                item.on_ui(message.get('event'), message.get('data'))


_channel = None
_lock = threading.Lock()


def channel():
    global _channel
    with _lock:
        if _channel is None:
            _channel = Channel(os.environ.get('GRCWEB_SOCKET'))
        return _channel

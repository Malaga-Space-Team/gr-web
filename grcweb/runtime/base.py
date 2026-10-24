"""Common pieces of the web GUI blocks."""

import time

from .channel import channel

# qtgui colour names -> CSS
COLORS = {
    'blue': '#1f77ff', 'red': '#ff3b30', 'green': '#2ecc40', 'black': '#000000',
    'cyan': '#00d0e0', 'magenta': '#ff40ff', 'yellow': '#ffd400', 'dark red': '#a00000',
    'dark green': '#007a20', 'dark blue': '#0030a0', 'white': '#ffffff', 'gray': '#808080',
    'grey': '#808080', 'silver': '#c0c0c0', 'navy': '#000080', 'orange': '#ff8c00',
    'purple': '#800080', 'lime': '#00ff00', 'aqua': '#00ffff', 'teal': '#008080',
    'lightgray': '#d3d3d3', 'default': '',
}


def css_color(name):
    name = unquote(str(name or '')).strip()
    if name.startswith('#'):
        return name
    return COLORS.get(name.lower(), name)


def unquote(text):
    text = str(text)
    if len(text) >= 2 and text[0] == text[-1] and text[0] in '"\'':
        return text[1:-1]
    return text


class Params:
    """Evaluated block parameters (each given as a zero-argument function)."""

    def __init__(self, functions):
        self._values = {}
        self.errors = {}
        for key, fn in functions.items():
            self._values[key] = self._evaluate(key, fn)

    def _evaluate(self, key, fn):
        try:
            value = fn()
            self.errors.pop(key, None)
            return value
        except Exception as error:
            self.errors[key] = str(error)
            return None

    def update(self, key, fn):
        self._values[key] = self._evaluate(key, fn)
        return self._values[key]

    def __contains__(self, key):
        return key in self._values

    def raw(self, key, default=None):
        value = self._values.get(key)
        return default if value is None else value

    def enum(self, key, default=''):
        return unquote(self.raw(key, default))

    def flag(self, key, default=False):
        value = self._values.get(key)
        if value is None:
            return default
        if isinstance(value, str):
            return unquote(value).strip().lower() in ('true', '1', 'yes')
        return bool(value)

    def num(self, key, default=0.0):
        value = self._values.get(key)
        try:
            return float(unquote(value) if isinstance(value, str) else value)
        except (TypeError, ValueError):
            return default

    def int(self, key, default=0):
        value = self.num(key, None)
        return default if value is None else int(round(value))

    def text(self, key, default=''):
        value = self._values.get(key)
        if value is None:
            return default
        return str(value)


def line_styles(params, count, defaults=None):
    """Per-line label/colour/width/style/marker/alpha settings (1-based params)."""
    defaults = defaults or {}
    lines = []
    for i in range(1, count + 1):
        key = lambda base: '{}{}'.format(base, i)
        lines.append({
            'label': params.text(key('label'), ''),
            'color': css_color(params.enum(key('color'), '')) if key('color') in params else '',
            'width': params.num(key('width'), 1) if key('width') in params else 1,
            'style': params.int(key('style'), defaults.get('style', 1)) if key('style') in params else defaults.get('style', 1),
            'marker': params.int(key('marker'), defaults.get('marker', -1)) if key('marker') in params else defaults.get('marker', -1),
            'alpha': params.num(key('alpha'), 1.0) if key('alpha') in params else 1.0,
        })
    return lines


class Item:
    """Mixin for everything that appears in the run window."""

    impl = ''

    def setup_item(self, tb, name, params):
        self.item_name = name
        self.params = params
        self.ch = channel()
        self.ch.attach(tb)
        self.ch.register(self)
        self._last_publish = 0.0
        self.paused = False

    @property
    def tb(self):
        return self.ch.tb

    def config(self):
        return {}

    def announce(self):
        config = {'impl': self.impl}
        config.update(self.config())
        if self.params.errors:
            config['param_errors'] = dict(self.params.errors)
        self.ch.send_item(self.item_name, config)

    def set_param(self, key, fn):
        self.params.update(key, fn)
        try:
            self.apply()
        except Exception as error:
            self.ch.log('>>> {}: cannot apply {} ({})'.format(self.item_name, key, error))
        self.announce()

    def apply(self):
        """Derive the working settings from self.params."""

    def on_ui(self, event, data):
        if event == 'pause':
            self.paused = bool(data)

    def due(self, period):
        """True once per update period while someone is watching."""
        if self.paused or not self.ch.active:
            return False
        now = time.monotonic()
        if now - self._last_publish >= period:
            self._last_publish = now
            return True
        return False

    def call_setter(self, value):
        tb = self.tb
        setter = getattr(tb, 'set_' + self.item_name, None) if tb is not None else None
        if setter is None:
            self.ch.log('>>> {}: no setter found'.format(self.item_name))
            return
        setter(value)

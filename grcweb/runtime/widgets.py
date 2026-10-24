"""Web replacements for the QT GUI widgets (ranges, choosers, buttons, ...).

Variable widgets call the generated ``set_<id>()`` of the top block, exactly
like their Qt versions, and are told about value changes made elsewhere
through ``set_value()`` (a GRC callback added by grcweb.translate).
"""

import ast
import os
import time

import numpy as np
import pmt
from gnuradio import gr, eng_notation

from .base import Item, css_color, unquote


def to_pmt(value):
    if isinstance(value, bool):
        return pmt.from_bool(value)
    if isinstance(value, int):
        return pmt.from_long(value)
    if isinstance(value, float):
        return pmt.from_double(value)
    if isinstance(value, complex):
        return pmt.from_complex(value)
    if isinstance(value, str):
        return pmt.intern(value)
    return pmt.to_pmt(value)


def jsonable(value):
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    if isinstance(value, complex):
        return str(value)
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    return str(value)


class _Widget(Item):
    """A variable widget that is not a GNU Radio block."""

    def __init__(self, tb, name, params):
        self.setup_item(tb, name, params)
        self.value = getattr(tb, name, None)
        self.apply()
        self.announce()
        self.ch.send_value(name, self.ui_value(self.value))

    def label(self):
        text = unquote(self.params.text('label', ''))
        return text or self.item_name

    def ui_value(self, value):
        return jsonable(value)

    def set_value(self, fn):
        try:
            value = fn()
        except Exception:
            return
        self.value = value
        self.ch.send_value(self.item_name, self.ui_value(value))


class Range(_Widget):
    impl = 'range'

    def apply(self):
        p = self.params
        self.is_int = p.enum('rangeType', 'float').strip('"') == 'int'

    def config(self):
        p = self.params
        return {'label': self.label(), 'start': p.num('start', 0), 'stop': p.num('stop', 100),
                'step': p.num('step', 1), 'widget': p.enum('widget', 'counter_slider'),
                'vertical': p.enum('orient', '').endswith('Vertical'), 'int': self.is_int,
                'min_len': p.int('min_len', 200)}

    def on_ui(self, event, data):
        if event != 'value':
            return
        p = self.params
        lo, hi = sorted((p.num('start', 0), p.num('stop', 100)))
        value = min(max(float(data), lo), hi)
        self.call_setter(int(round(value)) if self.is_int else value)


class Chooser(_Widget):
    impl = 'chooser'

    def apply(self):
        p = self.params
        count = p.int('num_opts', 0)
        if count > 0:
            options = [p.raw('option{}'.format(i)) for i in range(count)]
            labels = [p.text('label{}'.format(i), '') for i in range(count)]
        else:
            options = p.raw('options', []) or []
            labels = p.raw('labels', []) or []
            if not isinstance(options, (list, tuple)):
                options = [options]
            if not isinstance(labels, (list, tuple)):
                labels = [labels]
            labels = [str(l) for l in labels]
        labels = list(labels) + [''] * (len(options) - len(labels))
        self.options = list(options)
        self.labels = [l if l not in ('', "''") else str(o) for l, o in zip(labels, options)]

    def config(self):
        return {'label': self.label(), 'labels': self.labels,
                'widget': self.params.enum('widget', 'combo_box'),
                'vertical': 'QVBox' in self.params.enum('orient', 'Qt.QVBoxLayout')}

    def ui_value(self, value):
        for i, option in enumerate(self.options):
            try:
                if option == value:
                    return i
            except Exception:
                continue
        return -1

    def on_ui(self, event, data):
        if event == 'value':
            index = int(data)
            if 0 <= index < len(self.options):
                self.call_setter(self.options[index])


class CheckBox(_Widget):
    impl = 'check_box'

    def config(self):
        return {'label': self.label()}

    def ui_value(self, value):
        try:
            return bool(value == self.params.raw('true', True))
        except Exception:
            return bool(value)

    def on_ui(self, event, data):
        if event == 'value':
            self.call_setter(self.params.raw('true', True) if data else self.params.raw('false', False))


class PushButton(_Widget):
    impl = 'push_button'

    def config(self):
        return {'label': self.label()}

    def on_ui(self, event, data):
        if event == 'press':
            self.call_setter(self.params.raw('pressed', 1))
        elif event == 'release':
            self.call_setter(self.params.raw('released', 0))


_CONVERT = {
    'real': eng_notation.str_to_num,
    'int': lambda s: int(float(s)) if '.' in s or 'e' in s.lower() else int(s, 0),
    'string': str,
    'bool': lambda s: s.strip().lower() in ('true', '1', 'yes', 'on'),
    'raw': lambda s: eval(s),  # same as the Qt entry ("raw" type evaluates the text)
}
_FORMAT = {'real': eng_notation.num_to_str, 'int': str, 'string': str, 'bool': str, 'raw': repr}


class Entry(_Widget):
    impl = 'entry'

    def config(self):
        return {'label': self.label(), 'type': self.params.enum('type', 'int')}

    def ui_value(self, value):
        try:
            return _FORMAT.get(self.params.enum('type', 'int'), str)(value)
        except Exception:
            return str(value)

    def on_ui(self, event, data):
        if event == 'value':
            try:
                value = _CONVERT.get(self.params.enum('type', 'int'), str)(str(data))
            except Exception as error:
                self.ch.log('>>> {}: invalid value {!r} ({})'.format(self.item_name, data, error))
                self.ch.send_value(self.item_name, self.ui_value(self.value))
                return
            self.call_setter(value)


class Label(_Widget):
    impl = 'label'

    def config(self):
        return {'label': self.label()}

    def ui_value(self, value):
        formatter = self.params.raw('formatter')
        try:
            if callable(formatter):
                return str(formatter(value))
            return _FORMAT.get(self.params.enum('type', 'int'), str)(value)
        except Exception:
            return str(value)


# --------------------------------------------------------------------------
# Widgets with message ports are GNU Radio blocks.

class _MsgWidget(Item, gr.basic_block):
    def _init_block(self, tb, name, params, block_name, in_sig=None):
        gr.basic_block.__init__(self, name=block_name, in_sig=in_sig, out_sig=None)
        self.setup_item(tb, name, params)

    def label(self):
        text = unquote(self.params.text('label', ''))
        return text or self.item_name

    def _out(self, port):
        self.message_port_register_out(pmt.intern(port))

    def _in(self, port, handler):
        self.message_port_register_in(pmt.intern(port))
        self.set_msg_handler(pmt.intern(port), handler)

    def pub(self, port, key, value):
        self.message_port_pub(pmt.intern(port), pmt.cons(pmt.intern(str(key)), to_pmt(value)))

    def set_value(self, fn):
        try:
            self.value = fn()
        except Exception:
            return
        self.ch.send_value(self.item_name, self.ui_value(self.value))

    def ui_value(self, value):
        return jsonable(value)

    def general_work(self, input_items, output_items):
        return 0


def _typed(params, key, kind, default):
    value = params.raw(key, default)
    if kind == 'bool':
        return bool(value)
    return value


class ToggleButton(_MsgWidget):
    """Toggle button, toggle switch and message check box share the logic."""
    impl = 'toggle_button'

    def __init__(self, tb, name, p, impl=None):
        self.impl = impl or self.impl
        self._init_block(tb, name, p, 'web_' + self.impl)
        self._out('state')
        kind = p.enum('type', 'int')
        self.pressed_value = _typed(p, 'pressed', kind, 1)
        self.released_value = _typed(p, 'released', kind, 0)
        self.state = p.flag('initPressed')
        self.value = getattr(tb, name, None)
        self.announce()
        self.ch.send_value(name, self.state)

    def config(self):
        p = self.params
        return {'label': self.label(), 'colors': [css_color(p.enum(k, 'default')) for k in
                ('relBackgroundColor', 'relFontColor', 'pressBackgroundColor', 'pressFontColor',
                 'switchOnBackground', 'switchOffBackground') if k in p]}

    def ui_value(self, value):
        return self.state

    def set_value(self, fn):
        try:
            value = fn()
        except Exception:
            return
        if not isinstance(value, gr.basic_block):
            self.state = value == self.pressed_value
            self.ch.send_value(self.item_name, self.state)

    def on_ui(self, event, data):
        if event != 'value':
            return
        self.state = bool(data)
        value = self.pressed_value if self.state else self.released_value
        self.call_setter(value)
        self.pub('state', self.params.text('outputmsgname', 'value'), value)


class MsgPushButton(_MsgWidget):
    impl = 'msg_push_button'

    def __init__(self, tb, name, p):
        self._init_block(tb, name, p, 'web_msg_push_button')
        self._out('pressed')
        self.announce()

    def config(self):
        p = self.params
        return {'label': self.label(),
                'colors': [css_color(p.enum('relBackgroundColor', 'default')), css_color(p.enum('relFontColor', 'default'))]}

    def on_ui(self, event, data):
        if event == 'press':
            p = self.params
            value = p.raw('value', 1)
            if p.enum('type', 'int') == 'bool':
                value = bool(value)
            self.pub('pressed', p.text('msgName', 'pressed'), value)


class Dial(_MsgWidget):
    impl = 'dial'

    def __init__(self, tb, name, p):
        self._init_block(tb, name, p, 'web_dial')
        self._out('value')
        self.value = getattr(tb, name, None)
        self.announce()
        self.ch.send_value(name, jsonable(self.value))

    def config(self):
        p = self.params
        return {'label': self.label(), 'min': p.num('minimum', 0), 'max': p.num('maximum', 100),
                'int': p.enum('type', 'int') == 'int', 'show': p.flag('showvalue')}

    def on_ui(self, event, data):
        if event != 'value':
            return
        p = self.params
        value = float(data)
        value = min(max(value, p.num('minimum', 0)), p.num('maximum', 100))
        if p.enum('type', 'int') == 'int':
            value = int(round(value))
        self.call_setter(value)
        self.pub('value', p.text('outputmsgname', 'value'), value)


class DigitalNumber(_MsgWidget):
    impl = 'digital_number'

    def __init__(self, tb, name, p):
        self._init_block(tb, name, p, 'web_digital_number')
        self._in('valuein', self._handle)
        self._out('valueout')
        self.value = getattr(tb, name, None)
        self.announce()
        self.ch.send_value(name, jsonable(self.value))

    def config(self):
        p = self.params
        return {'label': unquote(p.text('lbl', '')), 'min': p.num('minFreqHz', 0), 'max': p.num('maxFreqHz', 1e9),
                'sep': p.enum('ThousandsSeparator', ','), 'readonly': p.flag('readOnly'),
                'colors': [css_color(p.enum('relBackgroundColor', 'black')), css_color(p.enum('relFontColor', 'white'))]}

    def _apply_value(self, value, publish):
        p = self.params
        value = min(max(float(value), p.num('minFreqHz', 0)), p.num('maxFreqHz', 1e9))
        self.call_setter(value)
        self.ch.send_value(self.item_name, value)
        if publish:
            self.message_port_pub(pmt.intern('valueout'),
                                  pmt.cons(pmt.intern(p.text('outputmsgname', 'freq')), pmt.from_double(value)))

    def _handle(self, msg):
        try:
            value = pmt.to_python(pmt.cdr(msg))
            self._apply_value(value, True)
        except Exception as error:
            self.ch.log('>>> {}: bad message ({})'.format(self.item_name, error))

    def on_ui(self, event, data):
        if event == 'value' and not self.params.flag('readOnly'):
            self._apply_value(data, True)


_EDIT_TYPES = {
    'string': (str, pmt.intern),
    'int': (int, pmt.from_long),
    'float': (float, pmt.from_float),
    'double': (float, pmt.from_double),
    'complex': (complex, pmt.from_complex),
    'int_vec': (lambda s: [int(v) for v in ast.literal_eval(s)], pmt.init_s32vector),
    'flt_vec': (lambda s: [float(v) for v in ast.literal_eval(s)], pmt.init_f32vector),
    'dbl_vec': (lambda s: [float(v) for v in ast.literal_eval(s)], pmt.init_f64vector),
    'cpx_vec': (lambda s: [complex(v) for v in ast.literal_eval(s)], pmt.init_c32vector),
}


class EditBoxMsg(_MsgWidget):
    impl = 'edit_box_msg'

    def __init__(self, tb, name, p):
        self._init_block(tb, name, p, 'web_edit_box_msg')
        self._in('val', self._handle)
        self._out('msg')
        self.announce()
        self.ch.send_value(name, {'key': unquote(p.text('key', '')), 'value': unquote(p.text('value', ''))})

    def config(self):
        p = self.params
        return {'label': unquote(p.text('label', '')), 'type': p.enum('type', 'string'),
                'pair': p.flag('is_pair', True), 'static': p.flag('is_static', True),
                'key': unquote(p.text('key', ''))}

    def _make(self, text):
        convert, make = _EDIT_TYPES.get(self.params.enum('type', 'string'), _EDIT_TYPES['string'])
        value = convert(text)
        if make in (pmt.init_s32vector, pmt.init_f32vector, pmt.init_f64vector, pmt.init_c32vector):
            return make(len(value), value)
        return make(value)

    def on_ui(self, event, data):
        if event != 'submit' or not isinstance(data, dict):
            return
        try:
            value = self._make(str(data.get('value', '')))
        except Exception as error:
            self.ch.log('>>> {}: cannot convert {!r} ({})'.format(self.item_name, data.get('value'), error))
            return
        if self.params.flag('is_pair', True):
            key = data.get('key') if not self.params.flag('is_static', True) else self.config()['key']
            value = pmt.cons(pmt.intern(str(key)), value)
        self.message_port_pub(pmt.intern('msg'), value)

    def _handle(self, msg):
        try:
            if pmt.is_pair(msg) and not pmt.is_dict(msg):
                shown = {'key': pmt.symbol_to_string(pmt.car(msg)) if pmt.is_symbol(pmt.car(msg)) else str(pmt.car(msg)),
                         'value': str(pmt.to_python(pmt.cdr(msg)))}
            else:
                shown = {'key': '', 'value': str(pmt.to_python(msg))}
            self.ch.send_value(self.item_name, shown)
        except Exception as error:
            self.ch.log('>>> {}: bad message ({})'.format(self.item_name, error))


class _Indicator(_MsgWidget):
    """Message driven displays: LED, gauges, compass, radar, az/el plot."""
    port = 'value'
    use_car = False

    def __init__(self, tb, name, p, in_sig=None):
        self._init_block(tb, name, p, 'web_' + self.impl, in_sig)
        self._in(self.port, self._handle)
        self.value = self.initial()
        self.announce()
        self.ch.send_value(name, jsonable(self.value))

    def initial(self):
        return self.params.raw('value', 0)

    def convert(self, value):
        return float(value)

    def _handle(self, msg):
        try:
            raw = pmt.to_python(pmt.car(msg) if self.use_car else pmt.cdr(msg))
            self.value = self.convert(raw)
            self.ch.send_value(self.item_name, jsonable(self.value))
        except Exception as error:
            self.ch.log('>>> {}: bad message ({})'.format(self.item_name, error))

    def set_param(self, key, fn):
        super().set_param(key, fn)
        if key in ('value', 'state'):
            self.value = self.initial()
            self.ch.send_value(self.item_name, jsonable(self.value))


class Led(_Indicator):
    impl = 'led'
    port = 'state'

    def initial(self):
        return bool(self.params.raw('state', False))

    def convert(self, value):
        return bool(value) if isinstance(value, bool) else value == 1

    def config(self):
        p = self.params
        return {'label': unquote(p.text('label', '')), 'on': css_color(p.enum('onColor', 'green')),
                'off': css_color(p.enum('offColor', 'red')), 'size': p.int('maxSize', 40)}


class LevelGauge(_Indicator):
    impl = 'level_gauge'

    def config(self):
        p = self.params
        return {'label': self.label(), 'min': p.num('minimum', 0), 'max': p.num('maximum', 100),
                'vertical': p.flag('isVertical', True), 'show': p.flag('showValue'),
                'colors': [css_color(p.enum(k, 'default')) for k in ('barColor', 'backgroundColor', 'fontColor')]}


class DialGauge(LevelGauge):
    impl = 'dial_gauge'

    def config(self):
        config = super().config()
        config['vertical'] = False
        return config


class Compass(_Indicator):
    impl = 'compass'
    port = 'angle'

    def __init__(self, tb, name, p):
        # the stream input is optional, like on the Qt block
        super().__init__(tb, name, p, in_sig=gr.py_io_signature(0, 1, [np.float32]))
        self._last = 0.0

    def initial(self):
        return 0.0

    def config(self):
        p = self.params
        return {'label': unquote(p.text('name', '')), 'tip': css_color(p.enum('needleTipColor', 'red')),
                'body': css_color(p.enum('needleBodyColor', 'black')), 'size': p.int('min_size', 250)}

    def general_work(self, input_items, output_items):
        if not input_items:
            return 0
        data = input_items[0]
        n = len(data)
        if n and not self.params.flag('usemsg'):
            now = time.monotonic()
            if now - self._last >= max(0.02, self.params.num('update_time', 0.1)):
                self._last = now
                self.value = float(data[-1])
                self.ch.send_value(self.item_name, self.value)
        self.consume(0, n)
        return 0


class DistanceRadar(_Indicator):
    impl = 'distance_radar'
    port = 'radius'

    def initial(self):
        return 0.0

    def config(self):
        p = self.params
        ticks = p.raw('ticklabels', [])
        return {'label': self.label(), 'ticks': [str(t) for t in (ticks or [])],
                'colors': [css_color(p.enum(k, '')) for k in ('backgroundColor', 'fontColor', 'ringColor')]}


class AzEl(_Indicator):
    impl = 'azel'
    port = 'azel'
    use_car = True

    def initial(self):
        return None

    def convert(self, value):
        return {'az': float(value['az']), 'el': float(value['el'])}

    def config(self):
        p = self.params
        return {'label': self.label(), 'background': css_color(p.enum('backgroundColor', 'white')),
                'dot': p.enum('dotColor', 'ro')}


class GraphicItem(_MsgWidget):
    impl = 'graphic_item'

    def __init__(self, tb, name, p):
        self._init_block(tb, name, p, 'web_graphic_item')
        self._in('filename', self._handle_file)
        self._in('overlay', lambda msg: None)
        self.announce()
        self._send_file(p.text('file', ''))

    def config(self):
        p = self.params
        return {'scale': p.flag('scaleImage'), 'fixed': p.flag('fixedsize'),
                'width': p.int('width', 0), 'height': p.int('height', 0)}

    def _send_file(self, path):
        path = unquote(path)
        if not path or not os.path.isfile(path) or os.path.getsize(path) > 8 * 1024 * 1024:
            return
        with open(path, 'rb') as fp:
            data = fp.read()
        ext = os.path.splitext(path)[1].lower().lstrip('.') or 'png'
        self.ch.publish(self.item_name, {'kind': 'image', 'name': self.item_name,
                                         'mime': 'image/' + ('jpeg' if ext == 'jpg' else ext)}, data)

    def _handle_file(self, msg):
        try:
            self._send_file(str(pmt.to_python(pmt.cdr(msg))))
        except Exception as error:
            self.ch.log('>>> {}: bad message ({})'.format(self.item_name, error))


WIDGETS = {
    'range': Range, 'chooser': Chooser, 'check_box': CheckBox, 'push_button': PushButton,
    'entry': Entry, 'label': Label, 'dial': Dial, 'digital_number': DigitalNumber,
    'msg_push_button': MsgPushButton, 'edit_box_msg': EditBoxMsg, 'led': Led,
    'level_gauge': LevelGauge, 'dial_gauge': DialGauge, 'compass': Compass,
    'distance_radar': DistanceRadar, 'azel': AzEl, 'graphic_item': GraphicItem,
    'toggle_button': lambda tb, name, p: ToggleButton(tb, name, p, 'toggle_button'),
    'toggle_switch': lambda tb, name, p: ToggleButton(tb, name, p, 'toggle_switch'),
    'msg_check_box': lambda tb, name, p: ToggleButton(tb, name, p, 'msg_check_box'),
}

"""Web replacements for the QT GUI sinks.

Like the Qt sinks, they only look at the stream once per update period: a
snapshot of the most recent samples is processed (FFT, histogram, ...) and
published. Everything else is consumed untouched, so CPU usage does not grow
with the sample rate beyond a copy of the last few samples.
"""

import collections
import time

import numpy as np
import pmt
from gnuradio import gr
from gnuradio.fft import window as grwindow

from .base import Item, line_styles, css_color

MAX_POINTS = 4096        # line plot resolution sent to the browser
MAX_WATERFALL_COLS = 2048
TAG_LIMIT = 200

ITEM_TYPES = {
    'complex': np.complex64, 'float': np.float32, 'short': np.int16,
    'byte': np.int8, 'int': np.int32,
}


def trigger_mode(text):
    text = str(text or '').upper()
    for mode in ('FREE', 'AUTO', 'NORM', 'TAG'):
        if text.endswith(mode):
            return mode.lower()
    return 'free'


def build_window(key, size, normalize=False):
    name = str(key).split('.')[-1]
    wintype = getattr(grwindow, name, grwindow.WIN_BLACKMAN_hARRIS)
    return np.asarray(grwindow.build(wintype, size, 6.76, normalize), dtype=np.float32)


def power_db(spectrum):
    """|X|^2 in dB, scaled like volk_32fc_s32f_x2_power_spectral_density_32f(.., N, 1.0, N)."""
    power = spectrum.real ** 2 + spectrum.imag ** 2
    return (10.0 * np.log10(power + 1e-20)).astype(np.float32)


def peak_decimate(data, limit):
    """Reduce the last axis to at most ``limit`` points keeping the peaks."""
    n = data.shape[-1]
    if n <= limit:
        return data, 1
    factor = int(np.ceil(n / limit))
    usable = (n // factor) * factor
    shaped = data[..., :usable].reshape(data.shape[:-1] + (usable // factor, factor))
    return shaped.max(axis=-1), factor


def quantize_rows(rows):
    """Float rows (..., cols) -> uint8 + per-row (min, max)."""
    rows = np.asarray(rows, dtype=np.float32)
    lo = rows.min(axis=-1, keepdims=True)
    hi = rows.max(axis=-1, keepdims=True)
    span = np.where(hi - lo > 1e-12, hi - lo, 1.0)
    q = np.clip((rows - lo) * (255.0 / span), 0, 255).astype(np.uint8)
    scales = np.concatenate([lo, hi], axis=-1).reshape(-1, 2).round(4).tolist()
    return q, scales


class Tail:
    """The most recent ``size`` items of each input."""

    def __init__(self, nchan, size, dtype):
        self.size = size
        self.buf = np.zeros((nchan, size), dtype=dtype)
        self.count = 0

    def push(self, inputs):
        n = len(inputs[0])
        if n >= self.size:
            for i, data in enumerate(inputs):
                self.buf[i] = data[-self.size:]
        elif n:
            self.buf = np.roll(self.buf, -n, axis=1)
            for i, data in enumerate(inputs):
                self.buf[i, -n:] = data
        self.count = min(self.size, self.count + n)

    @property
    def full(self):
        return self.count >= self.size


def pdu_vector(msg):
    """Uniform vector of a PDU (or of a plain vector message)."""
    if pmt.is_pair(msg):
        msg = pmt.cdr(msg)
    if pmt.is_uniform_vector(msg) or pmt.is_vector(msg):
        return np.asarray(pmt.to_python(msg))
    return None


class _Sink(Item):
    """Shared helpers for stream sinks."""

    def _init_sink(self, tb, name, params, block_name, in_sig, out_sig=None):
        gr.sync_block.__init__(self, name=block_name, in_sig=in_sig or None, out_sig=out_sig)
        self.setup_item(tb, name, params)

    def _set_chunk(self, rate):
        """Ask the scheduler for bigger chunks at high sample rates.

        Each call into Python has a fixed cost; with a few ms of samples per call
        the overhead stays small at tens of Msps while the added latency is
        far below a plot update period.
        """
        try:
            rate = float(rate)
        except (TypeError, ValueError):
            return
        multiple = 1
        while multiple * 2 <= min(rate * 0.006, 131072):
            multiple *= 2
        if multiple > 1:
            self.set_output_multiple(multiple)

    def _publish(self, header, payload, key=None):
        header['name'] = self.item_name
        self.ch.publish(key or self.item_name, header, payload)

    def _msg_in(self, port, handler):
        self.message_port_register_in(pmt.intern(port))
        self.set_msg_handler(pmt.intern(port), handler)


# ---------------------------------------------------------------------------
class TimeSink(_Sink, gr.sync_block):
    impl = 'time'

    def __init__(self, tb, name, p):
        kind = p.enum('type', 'complex')
        self.is_msg = kind.startswith('msg')
        self.cplx = kind.endswith('complex')
        self.nconn = 0 if self.is_msg else max(1, p.int('nconnections', 1))
        dtype = np.complex64 if self.cplx else np.float32
        self._init_sink(tb, name, p, 'web_time_sink', [dtype] * self.nconn)
        if self.is_msg:
            self._msg_in('in', self._handle_pdu)
        self._buf = None
        self._tags = collections.deque(maxlen=TAG_LIMIT)
        self._armed_at = None
        self._next_start = 0
        self._pending = None
        self.apply()
        if self.nconn:
            self._set_chunk(self.srate)
        self.announce()

    def apply(self):
        p = self.params
        self.size = max(2, p.int('size', 1024))
        self.srate = p.num('srate', 1.0) or 1.0
        self.update_time = max(0.01, p.num('update_time', 0.1))
        self.mode = trigger_mode(p.enum('tr_mode'))
        self.slope_pos = not str(p.enum('tr_slope')).upper().endswith('NEG')
        self.level = p.num('tr_level', 0.0)
        self.delay = max(0, min(self.size - 1, int(round(p.num('tr_delay', 0.0) * self.srate))))
        self.chan = max(0, p.int('tr_chan', 0))
        self.tag_key = p.text('tr_tag', '')
        self.entags = p.flag('entags', True)
        ntraces = (2 if self.cplx else 1) * max(1, self.nconn)
        self.ntraces = ntraces
        self._history = 2 * self.size + self.delay
        if self.nconn and (self._buf is None or self._buf.shape[0] != self.nconn):
            self._buf = np.zeros((self.nconn, 0), dtype=np.complex64 if self.cplx else np.float32)

    def config(self):
        p = self.params
        lines = line_styles(p, self.ntraces)
        for i, line in enumerate(lines):
            if not line['label']:
                if self.cplx:
                    line['label'] = '{}{{Data {}}}'.format('Re' if i % 2 == 0 else 'Im', i // 2)
                else:
                    line['label'] = 'Data {}'.format(i)
        return {
            'title': p.text('name', ''), 'ylabel': p.text('ylabel', 'Amplitude'), 'yunit': p.text('yunit', ''),
            'ymin': p.num('ymin', -1), 'ymax': p.num('ymax', 1), 'autoscale': p.flag('autoscale'),
            'grid': p.flag('grid'), 'legend': p.flag('legend', True), 'axislabels': p.flag('axislabels', True),
            'stem': p.flag('stemplot'), 'ctrlpanel': p.flag('ctrlpanel'), 'srate': self.srate,
            'size': self.size, 'lines': lines, 'trigger': {
                'mode': self.mode, 'slope': 'pos' if self.slope_pos else 'neg', 'level': self.level,
                'delay': self.delay / self.srate, 'chan': self.chan, 'tag': self.tag_key},
        }

    def on_ui(self, event, data):
        super().on_ui(event, data)
        if event == 'trigger' and isinstance(data, dict):
            self.mode = data.get('mode', self.mode)
            self.slope_pos = data.get('slope', 'pos') == 'pos'
            self.level = float(data.get('level', self.level))
            self.chan = int(data.get('chan', self.chan))
            self.announce()

    def _traces(self, window):
        if self.cplx:
            out = np.empty((window.shape[0] * 2, window.shape[1]), dtype=np.float32)
            out[0::2] = window.real
            out[1::2] = window.imag
            return out
        return window.astype(np.float32, copy=False)

    def _send(self, window, start_abs):
        traces = self._traces(window)
        tags = []
        if self.entags or self.mode == 'tag':
            end_abs = start_abs + window.shape[1]
            tags = [[off - start_abs, chan, key, val] for off, chan, key, val in self._tags
                    if start_abs <= off < end_abs][:50]
        self._publish({'kind': 'time', 'traces': traces.shape[0], 'n': traces.shape[1],
                       'dx': 1.0 / self.srate, 'x0': -self.delay / self.srate if self.mode != 'free' else 0.0,
                       'tags': tags}, np.ascontiguousarray(traces).tobytes())

    def _collect_tags(self, n):
        for i in range(self.nconn):
            for tag in self.get_tags_in_window(i, 0, n):
                try:
                    value = str(pmt.to_python(tag.value))
                except Exception:
                    value = str(tag.value)
                self._tags.append((tag.offset, i, pmt.symbol_to_string(tag.key), value[:40]))

    def _find_trigger(self, data, start_abs, first_abs):
        """Absolute index of the first trigger at or after first_abs (or None)."""
        lo = max(first_abs - start_abs, 1)
        if lo >= data.shape[1]:
            return None
        if self.mode == 'tag':
            hits = [off for off, chan, key, _ in self._tags
                    if (not self.tag_key or key == self.tag_key) and off >= start_abs + lo]
            return min(hits) if hits else None
        trace = self.chan
        source = data[min(trace // (2 if self.cplx else 1), data.shape[0] - 1)]
        if self.cplx:
            source = source.real if trace % 2 == 0 else source.imag
        x = source[lo - 1:]
        if self.slope_pos:
            hit = np.flatnonzero((x[:-1] < self.level) & (x[1:] >= self.level))
        else:
            hit = np.flatnonzero((x[:-1] > self.level) & (x[1:] <= self.level))
        if hit.size == 0:
            return None
        return start_abs + lo + int(hit[0])

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active or self.paused:
            return n
        if self.entags or self.mode == 'tag':
            self._collect_tags(n)
        end_abs = self.nitems_read(0) + n
        if self.mode == 'free':
            if self._tail_push(input_items) and self.due(self.update_time):
                self._send(self._buf[:, -self.size:], end_abs - self.size)
            return n
        # triggered modes keep enough history for the pre-trigger samples
        data = np.concatenate([self._buf, np.stack([np.asarray(x) for x in input_items])], axis=1)
        start_abs = end_abs - data.shape[1]
        now = time.monotonic()
        if self._pending is None and now - self._last_publish >= self.update_time:
            if self._armed_at is None:
                self._armed_at = now
            trig = self._find_trigger(data, start_abs, max(self._next_start, start_abs + self.delay))
            if trig is not None:
                self._pending = trig
            elif self.mode == 'auto' and now - self._armed_at > max(0.25, 2 * self.update_time) \
                    and data.shape[1] >= self.size:
                self._pending = end_abs - self.size + self.delay
        if self._pending is not None:
            first = self._pending - self.delay
            if first + self.size <= end_abs:
                if first >= start_abs:
                    i0 = first - start_abs
                    self._send(data[:, i0:i0 + self.size], first)
                    self._last_publish = now
                    self._next_start = first + self.size
                self._pending = None
                self._armed_at = None
        self._buf = data[:, -self._history:]
        return n

    def _tail_push(self, inputs):
        n = len(inputs[0])
        if n >= self.size:
            self._buf = np.stack([np.asarray(x[-self.size:]) for x in inputs])
        else:
            data = np.concatenate([self._buf, np.stack([np.asarray(x) for x in inputs])], axis=1)
            self._buf = data[:, -self.size:]
        return self._buf.shape[1] >= self.size

    def _handle_pdu(self, msg):
        data = pdu_vector(msg)
        if data is None or not self.ch.active:
            return
        data = data.astype(np.complex64 if self.cplx else np.float32)[None, :]
        self._send(data, 0)

    # setters used by GRC callbacks of the Qt block
    def set_update_time(self, t):
        self.params._values['update_time'] = t
        self.apply()

    def set_samp_rate(self, rate):
        self.params._values['srate'] = rate
        self.apply()
        self.announce()


# ---------------------------------------------------------------------------
class _SpectrumSink(_Sink):
    """FFT based sinks (frequency and waterfall)."""

    def _setup_spectrum(self, p):
        kind = p.enum('type', 'complex')
        self.is_msg = kind.startswith('msg')
        self.cplx = kind.endswith('complex')
        self.nconn = 0 if self.is_msg else max(1, p.int('nconnections', 1))
        return [np.complex64 if self.cplx else np.float32] * self.nconn

    def _register_freq_ports(self):
        self._msg_in('freq', self._handle_freq)
        self._msg_in('bw', self._handle_bw)
        self.message_port_register_out(pmt.intern('freq'))
        if self.is_msg:
            self._msg_in('in', self._handle_pdu)

    def _apply_spectrum(self):
        p = self.params
        self.fftsize = max(8, p.int('fftsize', 1024))
        self.fc = p.num('fc', 0.0)
        self.bw = p.num('bw', 1.0) or 1.0
        self.update_time = max(0.01, p.num('update_time', 0.1))
        self.half = (not self.cplx) and not p.flag('freqhalf', True)
        self.window = build_window(p.enum('wintype', 'window.WIN_BLACKMAN_hARRIS'), self.fftsize,
                                   p.flag('norm_window', False))
        if not hasattr(self, '_tail') or self._tail.size != self.fftsize or self._tail.buf.shape[0] != max(1, self.nconn):
            self._tail = Tail(max(1, self.nconn), self.fftsize, np.complex64 if self.cplx else np.float32)

    def _axis(self, npoints, factor):
        if self.half:
            return self.fc, self.bw / 2 / npoints
        return self.fc - self.bw / 2, self.bw / self.fftsize * factor

    def _spectrum(self, samples):
        """samples: (nchan, fftsize) -> dB (nchan, bins), shifted, half if needed."""
        n = samples.shape[-1]
        window = self.window if self.window.size == n else build_window('WIN_BLACKMAN_hARRIS', n)
        spec = np.fft.fft(samples * window, axis=-1) / n
        db = power_db(spec)
        if self.half:
            return db[..., :n // 2]
        return np.fft.fftshift(db, axes=-1)

    def _handle_freq(self, msg):
        value = pmt.cdr(msg) if pmt.is_pair(msg) else msg
        if pmt.is_real(value) or pmt.is_integer(value):
            self.set_frequency_range(pmt.to_double(value) if pmt.is_real(value) else pmt.to_long(value), self.bw)

    def _handle_bw(self, msg):
        value = pmt.cdr(msg) if pmt.is_pair(msg) else msg
        if pmt.is_real(value) or pmt.is_integer(value):
            self.set_frequency_range(self.fc, pmt.to_double(value) if pmt.is_real(value) else pmt.to_long(value))

    def _handle_pdu(self, msg):
        data = pdu_vector(msg)
        if data is None or data.size < 8:
            return
        data = data[-self.fftsize:].astype(np.complex64 if self.cplx else np.float32)
        if data.size < self.fftsize:
            data = np.concatenate([np.zeros(self.fftsize - data.size, dtype=data.dtype), data])
        self._process(data[None, :])

    def on_ui(self, event, data):
        super().on_ui(event, data)
        if event == 'freq_click':
            freq = float(data)
            self.message_port_pub(pmt.intern('freq'), pmt.cons(pmt.intern('freq'), pmt.from_double(freq)))

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active or self.paused:
            return n
        self._tail.push(input_items)
        if self._tail.full and self.due(self.update_time):
            self._process(self._tail.buf)
        return n

    def set_frequency_range(self, fc, bw):
        self.params._values['fc'] = fc
        self.params._values['bw'] = bw
        self.apply()
        self.announce()

    def set_update_time(self, t):
        self.params._values['update_time'] = t
        self.apply()


class FreqSink(_SpectrumSink, gr.sync_block):
    impl = 'freq'

    def __init__(self, tb, name, p):
        in_sig = self._setup_spectrum(p)
        self._init_sink(tb, name, p, 'web_freq_sink', in_sig)
        self._register_freq_ports()
        self._avg = None
        self.apply()
        if self.nconn:
            self._set_chunk(self.bw)
        self.announce()

    def apply(self):
        self._apply_spectrum()
        p = self.params
        self.alpha = p.num('average', 1.0) or 1.0
        self.mode = trigger_mode(p.enum('tr_mode'))
        self.level = p.num('tr_level', 0.0)
        self.chan = p.int('tr_chan', 0)
        self._avg = None

    def config(self):
        p = self.params
        nlines = max(1, self.nconn)
        lines = line_styles(p, nlines)
        for i, line in enumerate(lines):
            line['label'] = line['label'] or 'Data {}'.format(i)
        return {
            'title': p.text('name', ''), 'ylabel': p.text('label', 'Relative Gain'), 'yunit': p.text('units', 'dB'),
            'ymin': p.num('ymin', -140), 'ymax': p.num('ymax', 10), 'autoscale': p.flag('autoscale'),
            'grid': p.flag('grid'), 'legend': p.flag('legend', True), 'axislabels': p.flag('axislabels', True),
            'ctrlpanel': p.flag('ctrlpanel'), 'fc': self.fc, 'bw': self.bw, 'fftsize': self.fftsize,
            'average': self.alpha, 'half': self.half, 'lines': lines,
            'window': p.enum('wintype', 'window.WIN_BLACKMAN_hARRIS').split('.')[-1],
        }

    def on_ui(self, event, data):
        super().on_ui(event, data)
        if event == 'fft' and isinstance(data, dict):
            if 'fftsize' in data:
                self.params._values['fftsize'] = int(data['fftsize'])
            if 'average' in data:
                self.params._values['average'] = float(data['average'])
            if 'window' in data:
                self.params._values['wintype'] = 'window.' + str(data['window'])
            self.apply()
            self.announce()

    def _process(self, samples):
        db = self._spectrum(samples)
        if self.mode == 'norm' and db[min(self.chan, db.shape[0] - 1)].max() < self.level:
            return
        if self.alpha < 1.0:
            if self._avg is None or self._avg.shape != db.shape:
                self._avg = db.copy()
            else:
                self._avg = self.alpha * db + (1.0 - self.alpha) * self._avg
            db = self._avg
        out, factor = peak_decimate(db, MAX_POINTS)
        x0, dx = self._axis(out.shape[-1], factor)
        self._publish({'kind': 'freq', 'traces': out.shape[0], 'n': out.shape[1], 'x0': x0, 'dx': dx},
                      np.ascontiguousarray(out, dtype=np.float32).tobytes())

    def set_y_axis(self, ymin, ymax):
        self.params._values['ymin'] = ymin
        self.params._values['ymax'] = ymax
        self.announce()


class WaterfallSink(_SpectrumSink, gr.sync_block):
    impl = 'waterfall'

    def __init__(self, tb, name, p):
        in_sig = self._setup_spectrum(p)
        self._init_sink(tb, name, p, 'web_waterfall_sink', in_sig)
        self._register_freq_ports()
        self.apply()
        if self.nconn:
            self._set_chunk(self.bw)
        self.announce()

    def apply(self):
        self._apply_spectrum()

    def config(self):
        p = self.params
        nlines = max(1, self.nconn)
        lines = []
        for i in range(1, nlines + 1):
            lines.append({'label': p.text('label{}'.format(i), '') or 'Data {}'.format(i - 1),
                          'colormap': p.int('color{}'.format(i), 0), 'alpha': p.num('alpha{}'.format(i), 1.0)})
        return {
            'title': p.text('name', ''), 'zmin': p.num('int_min', -140), 'zmax': p.num('int_max', 10),
            'grid': p.flag('grid'), 'legend': p.flag('legend', True), 'axislabels': p.flag('axislabels', True),
            'fc': self.fc, 'bw': self.bw, 'fftsize': self.fftsize, 'half': self.half,
            'update_time': self.update_time, 'lines': lines,
        }

    def _process(self, samples):
        db = self._spectrum(samples)
        out, factor = peak_decimate(db, MAX_WATERFALL_COLS)
        x0, dx = self._axis(out.shape[-1], factor)
        q, scales = quantize_rows(out)
        header = {'kind': 'waterfall', 'rows': 1, 'cols': out.shape[-1], 'inputs': out.shape[0],
                  'x0': x0, 'dx': dx, 'scale': scales, 'name': self.item_name}
        self.ch.publish_rows(self.item_name, header, q.tobytes())

    def set_intensity_range(self, zmin, zmax):
        self.params._values['int_min'] = zmin
        self.params._values['int_max'] = zmax
        self.announce()


# ---------------------------------------------------------------------------
class ConstSink(_Sink, gr.sync_block):
    impl = 'const'

    def __init__(self, tb, name, p):
        self.is_msg = p.enum('type', 'complex').startswith('msg')
        self.nconn = 0 if self.is_msg else max(1, p.int('nconnections', 1))
        self._init_sink(tb, name, p, 'web_const_sink', [np.complex64] * self.nconn)
        if self.is_msg:
            self._msg_in('in', self._handle_pdu)
        self.apply()
        self.announce()

    def apply(self):
        p = self.params
        self.size = max(2, p.int('size', 1024))
        self.update_time = max(0.01, p.num('update_time', 0.1))
        self._tail = Tail(max(1, self.nconn), self.size, np.complex64)

    def config(self):
        p = self.params
        lines = line_styles(p, max(1, self.nconn), {'style': 0, 'marker': 0})
        for i, line in enumerate(lines):
            line['label'] = line['label'] or 'Data {}'.format(i)
        return {
            'title': p.text('name', ''), 'xmin': p.num('xmin', -2), 'xmax': p.num('xmax', 2),
            'ymin': p.num('ymin', -2), 'ymax': p.num('ymax', 2), 'autoscale': p.flag('autoscale'),
            'grid': p.flag('grid'), 'legend': p.flag('legend', True), 'axislabels': p.flag('axislabels', True),
            'lines': lines,
        }

    def _send(self, data):
        pts = np.empty(data.shape + (2,), dtype=np.float32)
        pts[..., 0] = data.real
        pts[..., 1] = data.imag
        self._publish({'kind': 'const', 'traces': data.shape[0], 'n': data.shape[1]}, pts.tobytes())

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active or self.paused:
            return n
        self._tail.push(input_items)
        if self._tail.full and self.due(self.update_time):
            self._send(self._tail.buf)
        return n

    def _handle_pdu(self, msg):
        data = pdu_vector(msg)
        if data is not None and self.ch.active:
            self._send(data.astype(np.complex64)[None, :])

    def set_update_time(self, t):
        self.params._values['update_time'] = t
        self.apply()


# ---------------------------------------------------------------------------
class HistogramSink(_Sink, gr.sync_block):
    impl = 'histogram'

    def __init__(self, tb, name, p):
        self.is_msg = p.enum('type', 'float').startswith('msg')
        self.nconn = 0 if self.is_msg else max(1, p.int('nconnections', 1))
        self._init_sink(tb, name, p, 'web_histogram_sink', [np.float32] * self.nconn)
        if self.is_msg:
            self._msg_in('in', self._handle_pdu)
        self._accum = None
        self.apply()
        self.announce()

    def apply(self):
        p = self.params
        self.size = max(2, p.int('size', 1024))
        self.bins = max(2, p.int('bins', 100))
        self.xmin, self.xmax = p.num('xmin', -1), p.num('xmax', 1)
        self.accumulate = p.flag('accum')
        self.autoscale = p.flag('autoscale', True)
        self.update_time = max(0.01, p.num('update_time', 0.1))
        self._tail = Tail(max(1, self.nconn), self.size, np.float32)
        self._accum = None

    def config(self):
        p = self.params
        lines = line_styles(p, max(1, self.nconn))
        for i, line in enumerate(lines):
            line['label'] = line['label'] or 'Data {}'.format(i)
        return {'title': p.text('name', ''), 'grid': p.flag('grid'), 'legend': p.flag('legend', True),
                'axislabels': p.flag('axislabels', True), 'bins': self.bins, 'xmin': self.xmin,
                'xmax': self.xmax, 'autoscale': self.autoscale, 'accum': self.accumulate, 'lines': lines}

    def _send(self, data):
        lo, hi = self.xmin, self.xmax
        if self.autoscale and not self.accumulate:
            lo, hi = float(np.min(data)), float(np.max(data))
            if hi <= lo:
                hi = lo + 1.0
        counts = np.stack([np.histogram(row, bins=self.bins, range=(lo, hi))[0] for row in data]).astype(np.float32)
        if self.accumulate:
            if self._accum is None or self._accum.shape != counts.shape:
                self._accum = np.zeros_like(counts)
            self._accum += counts
            counts = self._accum
        dx = (hi - lo) / self.bins
        self._publish({'kind': 'histogram', 'traces': counts.shape[0], 'n': counts.shape[1],
                       'x0': lo + dx / 2, 'dx': dx}, counts.tobytes())

    def on_ui(self, event, data):
        super().on_ui(event, data)
        if event == 'clear':
            self._accum = None

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active or self.paused:
            return n
        self._tail.push(input_items)
        if self._tail.full and self.due(self.update_time):
            self._send(self._tail.buf)
        return n

    def _handle_pdu(self, msg):
        data = pdu_vector(msg)
        if data is not None and self.ch.active:
            self._send(data.astype(np.float32)[None, :])

    def set_update_time(self, t):
        self.params._values['update_time'] = t
        self.apply()

    def set_bins(self, bins):
        self.params._values['bins'] = bins
        self.apply()
        self.announce()

    def set_x_axis(self, xmin, xmax):
        self.params._values['xmin'] = xmin
        self.params._values['xmax'] = xmax
        self.apply()
        self.announce()


# ---------------------------------------------------------------------------
class NumberSink(_Sink, gr.sync_block):
    impl = 'number'

    def __init__(self, tb, name, p):
        self.nconn = max(1, p.int('nconnections', 1))
        dtype = ITEM_TYPES.get(p.enum('type', 'float'), np.float32)
        self._init_sink(tb, name, p, 'web_number_sink', [dtype] * self.nconn)
        self._state = np.zeros(self.nconn)
        self._values = np.zeros(self.nconn)
        self.apply()
        self.announce()

    def apply(self):
        p = self.params
        self.update_time = max(0.01, p.num('update_time', 0.1))
        self.avg = min(max(p.num('avg', 0.0), 0.0), 1.0)

    def config(self):
        p = self.params
        rows = []
        for i in range(1, self.nconn + 1):
            colors = p.raw('color{}'.format(i), '("black", "black")')
            try:
                pair = eval(str(colors), {}) if isinstance(colors, str) else colors
                pair = [css_color(c) for c in pair]
            except Exception:
                pair = ['', '']
            rows.append({'label': p.text('label{}'.format(i), '') or 'Data {}'.format(i - 1),
                         'unit': p.text('unit{}'.format(i), ''), 'factor': p.num('factor{}'.format(i), 1.0),
                         'colors': pair})
        graph = p.enum('graph_type', 'qtgui.NUM_GRAPH_HORIZ').split('_')[-1].lower()
        return {'title': p.text('name', ''), 'min': p.num('min', -1), 'max': p.num('max', 1),
                'autoscale': p.flag('autoscale'), 'graph': graph, 'rows': rows}

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active:
            return n
        for i, data in enumerate(input_items):
            if self.avg > 0:
                # same as a single pole IIR over every sample, done per chunk
                a = self.avg
                weights = (1.0 - a) ** np.arange(n - 1, -1, -1, dtype=np.float64)
                self._state[i] = (1.0 - a) ** n * self._state[i] + a * float(np.dot(weights, data))
                self._values[i] = self._state[i]
            else:
                self._values[i] = float(data[-1])
        if self.due(self.update_time):
            self._publish({'kind': 'number', 'values': self._values.tolist()}, b'')
        return n

    def set_update_time(self, t):
        self.params._values['update_time'] = t
        self.apply()

    def set_average(self, avg):
        self.params._values['avg'] = avg
        self.apply()


# ---------------------------------------------------------------------------
class VectorSink(_Sink, gr.sync_block):
    impl = 'vector'

    def __init__(self, tb, name, p):
        self.nconn = max(1, p.int('nconnections', 1))
        self.vlen = max(1, p.int('vlen', 1024))
        self._init_sink(tb, name, p, 'web_vector_sink', [(np.float32, self.vlen)] * self.nconn)
        self.message_port_register_out(pmt.intern('xval'))
        self._avg = None
        self.apply()
        self.announce()

    def apply(self):
        p = self.params
        self.update_time = max(0.01, p.num('update_time', 0.1))
        self.alpha = p.num('average', 1.0) or 1.0
        self._avg = None

    def config(self):
        p = self.params
        lines = line_styles(p, self.nconn)
        for i, line in enumerate(lines):
            line['label'] = line['label'] or 'Data {}'.format(i)
        return {'title': p.text('name', ''), 'xlabel': p.text('x_axis_label', 'x-Axis'),
                'ylabel': p.text('y_axis_label', 'y-Axis'), 'xunit': p.text('x_units', ''),
                'yunit': p.text('y_units', ''), 'x0': p.num('x_start', 0), 'dx': p.num('x_step', 1),
                'ref': p.num('ref_level', 0), 'ymin': p.num('ymin', -140), 'ymax': p.num('ymax', 10),
                'autoscale': p.flag('autoscale'), 'grid': p.flag('grid'), 'legend': p.flag('legend', True),
                'lines': lines}

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active or self.paused or n == 0:
            return n
        if self.due(self.update_time):
            data = np.stack([np.asarray(x[-1], dtype=np.float32) for x in input_items])
            if self.alpha < 1.0:
                if self._avg is None or self._avg.shape != data.shape:
                    self._avg = data.copy()
                self._avg = self.alpha * data + (1.0 - self.alpha) * self._avg
                data = self._avg.astype(np.float32)
            out, factor = peak_decimate(data, MAX_POINTS)
            self._publish({'kind': 'vector', 'traces': out.shape[0], 'n': out.shape[1],
                           'x0': self.params.num('x_start', 0), 'dx': self.params.num('x_step', 1) * factor},
                          np.ascontiguousarray(out, dtype=np.float32).tobytes())
        return n

    def on_ui(self, event, data):
        super().on_ui(event, data)
        if event == 'x_click':
            self.message_port_pub(pmt.intern('xval'), pmt.cons(pmt.intern('xval'), pmt.from_double(float(data))))

    def set_update_time(self, t):
        self.params._values['update_time'] = t
        self.apply()

    def set_x_axis(self, x_start, x_step):
        self.params._values['x_start'] = x_start
        self.params._values['x_step'] = x_step
        self.announce()

    def set_y_axis(self, ymin, ymax):
        self.params._values['ymin'] = ymin
        self.params._values['ymax'] = ymax
        self.announce()

    def set_ref_level(self, ref):
        self.params._values['ref_level'] = ref
        self.announce()

    def set_x_axis_units(self, units):
        self.params._values['x_units'] = units
        self.announce()

    def set_y_axis_units(self, units):
        self.params._values['y_units'] = units
        self.announce()


# ---------------------------------------------------------------------------
class RasterSink(_Sink, gr.sync_block):
    impl = 'raster'

    def __init__(self, tb, name, p):
        kind = p.enum('type', 'float')
        self.is_msg = kind.startswith('msg')
        dtype = np.int8 if kind.endswith('byte') else np.float32
        self.nconn = 0 if self.is_msg else max(1, p.int('nconnections', 1))
        self._init_sink(tb, name, p, 'web_raster_sink', [dtype] * self.nconn)
        if self.is_msg:
            self._msg_in('in', self._handle_pdu)
        self._rows = []
        self._partial = None
        self.apply()
        self.announce()

    def apply(self):
        p = self.params
        self.nrows = max(1, p.int('nrows', 256))
        self.ncols = max(1, p.int('ncols', 256))
        self.update_time = max(0.01, p.num('update_time', 0.1))
        self._partial = np.zeros((max(1, self.nconn), 0), dtype=np.float32)
        self._rows = []

    def config(self):
        p = self.params
        return {'title': p.text('name', ''), 'zmin': p.num('zmin', -1), 'zmax': p.num('zmax', 1),
                'nrows': self.nrows, 'ncols': self.ncols, 'grid': p.flag('grid'),
                'xlabel': p.text('x_label', ''), 'ylabel': p.text('y_label', ''),
                'colormap': p.int('color1', 0), 'srate': p.num('samp_rate', 1.0)}

    def _scaled(self, data, i):
        p = self.params
        mult = p.raw('mult', []) or []
        offset = p.raw('offset', []) or []
        out = data.astype(np.float32)
        if i < len(mult):
            out = out * float(mult[i])
        if i < len(offset):
            out = out + float(offset[i])
        return out

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active or self.paused:
            return n
        keep = self.nrows * self.ncols
        chunk = np.stack([self._scaled(np.asarray(x[-keep:]), i) for i, x in enumerate(input_items)])
        data = np.concatenate([self._partial, chunk], axis=1)
        whole = (data.shape[1] // self.ncols) * self.ncols
        if whole:
            rows = data[:, :whole].reshape(data.shape[0], -1, self.ncols).transpose(1, 0, 2)
            self._rows.extend(rows[-self.nrows:])
            del self._rows[:-self.nrows]
        self._partial = data[:, whole:]
        if self._rows and self.due(self.update_time):
            self._send(np.stack(self._rows))
            self._rows = []
        return n

    def _send(self, rows):
        q, scales = quantize_rows(rows)
        header = {'kind': 'raster', 'rows': rows.shape[0], 'cols': rows.shape[-1], 'inputs': rows.shape[1],
                  'scale': scales, 'name': self.item_name}
        self.ch.publish_rows(self.item_name, header, q.tobytes())

    def _handle_pdu(self, msg):
        data = pdu_vector(msg)
        if data is None or not self.ch.active:
            return
        data = data.astype(np.float32)
        rows = data[: (data.size // self.ncols) * self.ncols].reshape(-1, 1, self.ncols)
        if rows.size:
            self._send(rows[-self.nrows:])

    def set_num_rows(self, rows):
        self.params._values['nrows'] = rows
        self.apply()
        self.announce()

    def set_num_cols(self, cols):
        self.params._values['ncols'] = cols
        self.apply()
        self.announce()

    def set_multiplier(self, mult):
        self.params._values['mult'] = mult

    def set_offset(self, offset):
        self.params._values['offset'] = offset

    def set_update_time(self, t):
        self.params._values['update_time'] = t
        self.apply()


# ---------------------------------------------------------------------------
class EyeSink(_Sink, gr.sync_block):
    impl = 'eye'

    def __init__(self, tb, name, p):
        kind = p.enum('type', 'complex')
        self.is_msg = kind.startswith('msg')
        self.cplx = kind.endswith('complex')
        self.nconn = 0 if self.is_msg else max(1, p.int('nconnections', 1))
        self._init_sink(tb, name, p, 'web_eye_sink', [np.complex64 if self.cplx else np.float32] * self.nconn)
        if self.is_msg:
            self._msg_in('in', self._handle_pdu)
        self.apply()
        if self.nconn:
            self._set_chunk(self.srate)
        self.announce()

    def apply(self):
        p = self.params
        self.size = max(4, p.int('size', 1024))
        self.sps = max(1, p.int('samp_per_symbol', 4))
        self.update_time = max(0.01, p.num('update_time', 0.1))
        self.srate = p.num('srate', 1.0) or 1.0
        self._tail = Tail(max(1, self.nconn), self.size, np.complex64 if self.cplx else np.float32)

    def config(self):
        p = self.params
        ntraces = (2 if self.cplx else 1) * max(1, self.nconn)
        lines = line_styles(p, ntraces)
        for i, line in enumerate(lines):
            if not line['label'] or line['label'].startswith('Signal'):
                line['label'] = ('{}{{Data {}}}'.format('Re' if i % 2 == 0 else 'Im', i // 2)
                                 if self.cplx else 'Data {}'.format(i))
        return {'title': p.text('name', ''), 'ylabel': p.text('ylabel', 'Amplitude'), 'yunit': p.text('yunit', ''),
                'ymin': p.num('ymin', -1), 'ymax': p.num('ymax', 1), 'autoscale': p.flag('autoscale'),
                'grid': p.flag('grid'), 'legend': p.flag('legend', True), 'sps': self.sps,
                'srate': self.srate, 'lines': lines}

    def _send(self, data):
        if self.cplx:
            traces = np.empty((data.shape[0] * 2, data.shape[1]), dtype=np.float32)
            traces[0::2] = data.real
            traces[1::2] = data.imag
        else:
            traces = data.astype(np.float32)
        seg = 2 * self.sps + 1
        nseg = max(0, (traces.shape[1] - seg) // self.sps + 1)
        if nseg == 0:
            return
        idx = np.arange(nseg)[:, None] * self.sps + np.arange(seg)[None, :]
        segs = traces[:, idx]
        self._publish({'kind': 'eye', 'traces': traces.shape[0], 'nseg': nseg, 'seglen': seg,
                       'dx': 1.0 / self.srate}, np.ascontiguousarray(segs).tobytes())

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active or self.paused:
            return n
        self._tail.push(input_items)
        if self._tail.full and self.due(self.update_time):
            self._send(self._tail.buf)
        return n

    def _handle_pdu(self, msg):
        data = pdu_vector(msg)
        if data is not None and self.ch.active:
            self._send(data.astype(np.complex64 if self.cplx else np.float32)[None, :])

    def set_update_time(self, t):
        self.params._values['update_time'] = t
        self.apply()

    def set_samp_per_symbol(self, sps):
        self.params._values['samp_per_symbol'] = sps
        self.apply()
        self.announce()

    def set_samp_rate(self, rate):
        self.params._values['srate'] = rate
        self.apply()

    def set_y_axis(self, ymin, ymax):
        self.params._values['ymin'] = ymin
        self.params._values['ymax'] = ymax
        self.announce()


# ---------------------------------------------------------------------------
class ComboSink(_SpectrumSink, gr.sync_block):
    """QT GUI Sink: frequency, waterfall, time and constellation views."""
    impl = 'combo'

    def __init__(self, tb, name, p):
        self.cplx = p.enum('type', 'complex') == 'complex'
        self.is_msg = False
        self.nconn = 1
        self._init_sink(tb, name, p, 'web_sink', [np.complex64 if self.cplx else np.float32])
        self._msg_in('freq', self._handle_freq)
        self.message_port_register_out(pmt.intern('freq'))
        self.apply()
        self._set_chunk(self.bw)
        self.announce()

    def apply(self):
        self._apply_spectrum()
        rate = self.params.num('rate', 10) or 10
        self.update_time = 1.0 / max(rate, 0.1)
        self.half = False

    def config(self):
        p = self.params
        views = [v for v, key in (('freq', 'plotfreq'), ('waterfall', 'plotwaterfall'),
                                  ('time', 'plottime'), ('const', 'plotconst')) if p.flag(key, True)]
        if not self.cplx and 'const' in views:
            views.remove('const')
        return {'title': p.text('name', ''), 'views': views, 'fc': self.fc, 'bw': self.bw,
                'fftsize': self.fftsize, 'cplx': self.cplx, 'showrf': p.flag('showrf')}

    def _process(self, samples):
        db = self._spectrum(samples)
        out, factor = peak_decimate(db, MAX_POINTS)
        x0, dx = self._axis(out.shape[-1], factor)
        self._publish({'kind': 'freq', 'view': 'freq', 'traces': 1, 'n': out.shape[-1], 'x0': x0, 'dx': dx},
                      np.ascontiguousarray(out, dtype=np.float32).tobytes(), key=self.item_name + '/freq')
        wf, wfactor = peak_decimate(db, MAX_WATERFALL_COLS)
        wx0, wdx = self._axis(wf.shape[-1], wfactor)
        q, scales = quantize_rows(wf)
        self.ch.publish_rows(self.item_name + '/waterfall',
                             {'kind': 'waterfall', 'view': 'waterfall', 'rows': 1, 'cols': wf.shape[-1],
                              'inputs': 1, 'x0': wx0, 'dx': wdx, 'scale': scales, 'name': self.item_name},
                             q.tobytes())
        data = samples[0]
        if self.cplx:
            traces = np.stack([data.real, data.imag]).astype(np.float32)
            pts = np.stack([data.real, data.imag], axis=-1).astype(np.float32)
            self._publish({'kind': 'const', 'view': 'const', 'traces': 1, 'n': data.size}, pts.tobytes(),
                          key=self.item_name + '/const')
        else:
            traces = data[None, :].astype(np.float32)
        rate = self.bw or 1.0
        self._publish({'kind': 'time', 'view': 'time', 'traces': traces.shape[0], 'n': traces.shape[1],
                       'dx': 1.0 / rate, 'x0': 0.0, 'tags': []}, traces.tobytes(), key=self.item_name + '/time')


class AutoCorrSink(_Sink, gr.sync_block):
    impl = 'autocorr'

    def __init__(self, tb, name, p):
        self._init_sink(tb, name, p, 'web_autocorr_sink', [np.complex64])
        self.apply()
        self.announce()

    def apply(self):
        p = self.params
        self.size = max(8, p.int('fac_size', 512))
        self.decim = max(1, p.int('fac_decimation', 10))
        self.rate = p.num('sampRate', 1.0) or 1.0
        self._tail = Tail(1, self.size, np.complex64)

    def config(self):
        p = self.params
        return {'title': p.text('title', ''), 'db': p.flag('useDB', True), 'grid': p.flag('grid', True),
                'autoscale': p.flag('autoScale', True), 'ymin': p.num('yMin', 0), 'ymax': p.num('yMax', 1),
                'lines': [{'label': 'Autocorrelation', 'color': '', 'width': 1, 'style': 1, 'marker': -1, 'alpha': 1}]}

    def work(self, input_items, output_items):
        n = len(input_items[0])
        if not self.ch.active or self.paused:
            return n
        self._tail.push(input_items)
        if self._tail.full and self.due(0.1 * self.decim / 10):
            x = self._tail.buf[0]
            spec = np.fft.fft(x, 2 * self.size)
            corr = np.abs(np.fft.ifft(spec * np.conj(spec)))[:self.size]
            corr = corr / (corr[0] or 1.0)
            if self.params.flag('useDB', True):
                corr = 10 * np.log10(corr + 1e-12)
            self._publish({'kind': 'autocorr', 'traces': 1, 'n': self.size, 'x0': 0.0, 'dx': 1.0 / self.rate},
                          corr.astype(np.float32).tobytes())
        return n


class FallbackSink(gr.basic_block):
    """Keeps a flow graph with an unsupported Qt block running."""

    def __init__(self, name, info):
        in_sig = [np.dtype((np.uint8, p['size'])) if p['size'] > 1 else np.uint8
                  for p in info.get('in', []) if not p['msg']]
        out_sig = [np.dtype((np.uint8, p['size'])) if p['size'] > 1 else np.uint8
                   for p in info.get('out', []) if not p['msg']]
        gr.basic_block.__init__(self, name='web_placeholder', in_sig=in_sig or None, out_sig=out_sig or None)
        for port in info.get('in', []):
            if port['msg']:
                self.message_port_register_in(pmt.intern(port['key']))
                self.set_msg_handler(pmt.intern(port['key']), lambda msg: None)
        for port in info.get('out', []):
            if port['msg']:
                self.message_port_register_out(pmt.intern(port['key']))
        self._has_out = bool(out_sig)

    def general_work(self, input_items, output_items):
        for i, data in enumerate(input_items):
            self.consume(i, len(data))
        if self._has_out and not input_items:
            time.sleep(0.05)
        return 0


SINKS = {
    'time': TimeSink, 'freq': FreqSink, 'waterfall': WaterfallSink, 'const': ConstSink,
    'histogram': HistogramSink, 'number': NumberSink, 'vector': VectorSink, 'raster': RasterSink,
    'eye': EyeSink, 'combo': ComboSink, 'autocorr': AutoCorrSink,
}

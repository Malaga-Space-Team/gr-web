"""Build the test flow graphs in tests/flowgraphs with the GRC core API.

They cover every Qt GUI block that has a web version, tabs and GUI hints,
triggers, message widgets and embedded Python, and only use simulated
sources (no hardware, no sockets).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from grcweb.document import Document  # noqa: E402
from grcweb.platforms import build_platforms, install_messenger  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'flowgraphs')


class Builder:
    def __init__(self, platform, fg_id, title, generate='qt_gui'):
        self.doc = Document(platform)
        self.y = 20
        opts = self.doc.fg.options_block.name
        self.doc.set_params(opts, {'id': fg_id, 'title': repr(title), 'generate_options': generate})

    def block(self, block_key, x, y, **params):
        name = self.doc.add_block(block_key, x, y)
        params = {k: str(v) for k, v in params.items()}
        new_id = params.pop('id', None)
        if params:
            self.doc.set_params(name, params)
        if new_id:
            self.doc.set_params(name, {'id': new_id})
            name = new_id
        return name

    def var(self, name, value, x, y):
        return self.block('variable', x, y, id=name, value=value)

    def connect(self, src, dst, sp='0', dp='0'):
        self.doc.connect(src, sp, dst, dp)

    def save(self, filename):
        errors = self.doc.fg.get_error_messages()
        if errors:
            raise SystemExit('{}: {} errors\n{}'.format(filename, len(errors), '\n'.join(errors[:10])))
        path = os.path.join(OUT, filename)
        self.doc.save(path)
        print('wrote', path)


def complex_sinks(p):
    b = Builder(p, 'web_complex_sinks', 'Complex sinks')
    samp = 'samp_rate'
    b.doc.set_params('samp_rate', {'value': '256000'})
    b.block('qtgui_tab_widget', 10, 300, id='tabs', num_tabs='2', label0="'Spectrum'", label1="'Time'",
            gui_hint='1,0,1,2')
    b.block('variable_qtgui_range', 200, 10, id='freq', value='10000', start='-100000', stop='100000',
            step='1000', label="'Tone frequency'", gui_hint='0,0,1,1')
    b.block('variable_qtgui_range', 400, 10, id='noise', value='0.05', start='0', stop='1', step='0.01',
            label="'Noise'", gui_hint='0,1,1,1')
    b.block('variable_qtgui_chooser', 600, 10, id='wave', value='analog.GR_COS_WAVE', type='raw',
            num_opts='3', option0='analog.GR_COS_WAVE', label0="'Cosine'", option1='analog.GR_SQR_WAVE',
            label1="'Square'", option2='analog.GR_TRI_WAVE', label2="'Triangle'", label="'Waveform'")
    b.block('variable_qtgui_check_box', 800, 10, id='enable_noise', value='True', type='bool',
            true='True', false='False', label="'Enable noise'")
    b.block('variable_qtgui_label', 1000, 10, id='freq_label', value='freq', type='real',
            label="'Frequency is'")
    src = b.block('analog_sig_source_x', 20, 120, type='complex', samp_rate=samp, waveform='wave',
                  freq='freq', amp='1', offset='0')
    nz = b.block('analog_noise_source_x', 20, 260, type='complex', noise_type='analog.GR_GAUSSIAN',
                 amp='noise if enable_noise else 0')
    add = b.block('blocks_add_xx', 300, 180, type='complex', num_inputs='2')
    thr = b.block('blocks_throttle2', 450, 180, type='complex', samples_per_second=samp)
    freq = b.block('qtgui_freq_sink_x', 700, 100, type='complex', fftsize='2048', bw=samp,
                   average='0.2', name="'Spectrum'", gui_hint='tabs@0: 0,0,1,1', ymin='-120', ymax='10')
    wf = b.block('qtgui_waterfall_sink_x', 700, 250, type='complex', fftsize='1024', bw=samp,
                 name="'Waterfall'", gui_hint='tabs@0: 1,0,1,1')
    time_ = b.block('qtgui_time_sink_x', 700, 400, type='complex', size='512', srate=samp,
                    name="'Time'", gui_hint='tabs@1: 0,0,1,1', nconnections='1', ymin='-1.5', ymax='1.5')
    const = b.block('qtgui_const_sink_x', 700, 550, type='complex', size='512', name="'Constellation'",
                    gui_hint='tabs@1: 0,1,1,1')
    b.connect(src, add, '0', '0')
    b.connect(nz, add, '0', '1')
    b.connect(add, thr)
    for sink in (freq, wf, time_, const):
        b.connect(thr, sink)
    b.save('complex_sinks.grc')


def float_sinks(p):
    b = Builder(p, 'web_float_sinks', 'Float sinks')
    b.doc.set_params('samp_rate', {'value': '48000'})
    b.block('variable_qtgui_entry', 200, 10, id='amp', value='1.0', type='real', label="'Amplitude'")
    b.block('variable_qtgui_push_button', 400, 10, id='boost', value='1', type='int', pressed='4',
            released='1', label="'Hold to boost'")
    src = b.block('analog_sig_source_x', 20, 120, type='float', samp_rate='samp_rate', freq='1000',
                  amp='amp*boost', waveform='analog.GR_SIN_WAVE')
    nz = b.block('analog_fastnoise_source_x', 20, 260, type='float', amp='0.1')
    add = b.block('blocks_add_xx', 300, 180, type='float', num_inputs='2')
    thr = b.block('blocks_throttle2', 450, 180, type='float', samples_per_second='samp_rate')
    hist = b.block('qtgui_histogram_sink_x', 700, 50, type='float', size='1000', bins='60',
                   xmin='-4', xmax='4', name="'Histogram'", gui_hint='0,0')
    num = b.block('qtgui_number_sink', 700, 180, type='float', nconnections='1', avg='0.01',
                  name="'Level'", min='-5', max='5', gui_hint='0,1')
    raster = b.block('qtgui_time_raster_sink_x', 700, 300, type='float', samp_rate='samp_rate',
                     nrows='100', ncols='48', zmin='-3', zmax='3', name="'Raster'", gui_hint='1,0')
    eye = b.block('qtgui_eye_sink_x', 700, 450, type='float', size='600', samp_per_symbol='12',
                  srate='samp_rate', name="'Eye'", gui_hint='1,1')
    s2v = b.block('blocks_stream_to_vector', 450, 400, type='float', num_items='256')
    fft = b.block('fft_vxx', 520, 480, type='float', fft_size='256', forward='True', shift='True',
                  window='window.blackmanharris(256)')
    mag = b.block('blocks_complex_to_mag_squared', 600, 560, vlen='256')
    vec = b.block('qtgui_vector_sink_f', 900, 560, vlen='256', name="'Vector'", ymin='0', ymax='5000',
                  gui_hint='2,0,1,2')
    combo = b.block('qtgui_sink_x', 900, 50, type='float', bw='samp_rate', fftsize='1024',
                    name="'QT GUI Sink'", gui_hint='3,0,1,2')
    b.connect(src, add, '0', '0')
    b.connect(nz, add, '0', '1')
    b.connect(add, thr)
    for sink in (hist, num, raster, eye, combo, s2v):
        b.connect(thr, sink)
    b.connect(s2v, fft)
    b.connect(fft, mag)
    b.connect(mag, vec)
    b.save('float_sinks.grc')


def triggers(p):
    b = Builder(p, 'web_triggers', 'Triggers, tags and PDUs')
    b.doc.set_params('samp_rate', {'value': '32000'})
    src = b.block('analog_sig_source_x', 20, 100, type='float', samp_rate='samp_rate', freq='250',
                  amp='1', waveform='analog.GR_SAW_WAVE')
    thr = b.block('blocks_throttle2', 250, 100, type='float', samples_per_second='samp_rate')
    tags = b.block('blocks_tags_strobe', 20, 250, type='float', key="pmt.intern('burst')",
                   value='pmt.from_long(1)', nsamps='4000')
    add = b.block('blocks_add_xx', 400, 160, type='float', num_inputs='2')
    norm = b.block('qtgui_time_sink_x', 650, 40, type='float', size='256', srate='samp_rate',
                   tr_mode='qtgui.TRIG_MODE_NORM', tr_level='0.5', tr_delay='0.001',
                   name="'Normal trigger'", gui_hint='0,0', ymin='-1.5', ymax='1.5')
    tagged = b.block('qtgui_time_sink_x', 650, 200, type='float', size='256', srate='samp_rate',
                     tr_mode='qtgui.TRIG_MODE_TAG', tr_tag='"burst"', name="'Tag trigger'",
                     gui_hint='0,1', ymin='-1.5', ymax='1.5')
    # PDUs into the message inputs of the sinks
    s2t = b.block('blocks_stream_to_tagged_stream', 250, 350, type='float', packet_len='128',
                  len_tag_key='"packet_len"')
    pdu = b.block('pdu_tagged_stream_to_pdu', 450, 350, type='float', tag='packet_len')
    msg_time = b.block('qtgui_time_sink_x', 700, 350, type='msg_float', size='128', srate='samp_rate',
                       name="'PDU time'", gui_hint='1,0')
    msg_freq = b.block('qtgui_freq_sink_x', 700, 480, type='msg_float', fftsize='128', bw='samp_rate',
                       name="'PDU spectrum'", gui_hint='1,1')
    b.connect(src, thr)
    b.connect(thr, add, '0', '0')
    b.connect(tags, add, '0', '1')
    b.connect(add, norm)
    b.connect(add, tagged)
    b.connect(add, s2t)
    b.connect(s2t, pdu)
    b.connect(pdu, msg_time, 'pdus', 'in')
    b.connect(pdu, msg_freq, 'pdus', 'in')
    b.save('triggers.grc')


def message_widgets(p):
    b = Builder(p, 'web_message_widgets', 'Message widgets')
    dbg = b.block('blocks_message_debug', 700, 300)
    b.block('variable_qtgui_msg_push_button', 20, 20, id='push', label="'Send'", msgName='"pressed"',
            value='42', gui_hint='0,0')
    b.block('variable_qtgui_toggle_button_msg', 20, 120, id='toggle', label="'Toggle'", value='0',
            gui_hint='0,1')
    b.block('variable_qtgui_toggle_switch', 20, 220, id='switch', label="'Switch'", value='0',
            gui_hint='0,2')
    b.block('variable_qtgui_msgcheckbox', 20, 320, id='check', label="'Check'", value='0', gui_hint='0,3')
    b.block('variable_qtgui_dial_control', 20, 420, id='dial', label="'Dial'", value='25', gui_hint='1,0')
    b.block('qtgui_msgdigitalnumbercontrol', 20, 520, id='tuner', value='100e6', lbl="'Tuner'",
            gui_hint='1,1,1,2')
    b.block('qtgui_edit_box_msg', 20, 620, id='edit', label="'Edit'", key="'cmd'", value="'hello'",
            gui_hint='1,3')
    for name, port in (('push', 'pressed'), ('toggle', 'state'), ('switch', 'state'), ('check', 'state'),
                       ('dial', 'value'), ('tuner', 'valueout'), ('edit', 'msg')):
        b.connect(name, dbg, port, 'print')
    strobe_led = b.block('blocks_message_strobe', 300, 700, msg="pmt.cons(pmt.intern('state'), pmt.from_bool(True))",
                         period='500')
    led = b.block('qtgui_ledindicator', 600, 700, label="'LED'", gui_hint='2,0')
    b.connect(strobe_led, led, 'strobe', 'state')
    strobe_v = b.block('blocks_message_strobe', 300, 820, msg="pmt.cons(pmt.intern('value'), pmt.from_double(63.0))",
                       period='300')
    level = b.block('qtgui_levelgauge', 600, 820, label="'Level'", gui_hint='2,1')
    dgauge = b.block('qtgui_dialgauge', 600, 920, label="'Gauge'", gui_hint='2,2')
    compass = b.block('qtgui_compass', 600, 1020, name="'Compass'", usemsg='True', gui_hint='2,3')
    radar = b.block('variable_qtgui_distanceradar', 600, 1120, label="'Radar'", gui_hint='3,0')
    azel = b.block('variable_qtgui_azelplot', 600, 1220, label="'AzEl'", gui_hint='3,1')
    strobe_a = b.block('blocks_message_strobe', 300, 1020, msg="pmt.cons(pmt.intern('angle'), pmt.from_double(135.0))",
                       period='300')
    strobe_r = b.block('blocks_message_strobe', 300, 1120, msg="pmt.cons(pmt.intern('radius'), pmt.from_double(55.0))",
                       period='300')
    strobe_z = b.block('blocks_message_strobe', 300, 1220,
                       msg="pmt.cons(pmt.to_pmt({'az': 120.0, 'el': 35.0}), pmt.PMT_NIL)", period='300')
    b.connect(strobe_v, level, 'strobe', 'value')
    b.connect(strobe_v, dgauge, 'strobe', 'value')
    b.connect(strobe_a, compass, 'strobe', 'angle')
    b.connect(strobe_r, radar, 'strobe', 'radius')
    b.connect(strobe_z, azel, 'strobe', 'azel')
    b.save('message_widgets.grc')


EPY_CODE = '''"""
Gain block written in the browser: multiplies by a gain and counts calls.
"""
import numpy as np
from gnuradio import gr


class blk(gr.sync_block):
    """Scale the input"""

    def __init__(self, gain=2.0):
        gr.sync_block.__init__(self, name='Web gain', in_sig=[np.complex64], out_sig=[np.complex64])
        self.gain = gain

    def work(self, input_items, output_items):
        output_items[0][:] = input_items[0] * self.gain
        return len(output_items[0])
'''


def python_blocks(p):
    b = Builder(p, 'web_python_blocks', 'Embedded Python')
    b.doc.set_params('samp_rate', {'value': '100000'})
    b.block('epy_module', 20, 400, id='helpers', source_code='def tone():\n    return 2500.0\n')
    b.block('variable_qtgui_range', 300, 10, id='gain', value='0.5', start='0', stop='2', step='0.05',
            label="'Python block gain'")
    src = b.block('analog_sig_source_x', 20, 120, type='complex', samp_rate='samp_rate', freq='helpers.tone()')
    thr = b.block('blocks_throttle2', 250, 120, type='complex', samples_per_second='samp_rate')
    epy = b.block('epy_block', 420, 120, _source_code=EPY_CODE)
    b.doc.set_params(epy, {'gain': 'gain'})
    sink = b.block('qtgui_time_sink_x', 650, 120, type='complex', size='256', srate='samp_rate',
                   name="'After Python block'", ymin='-2', ymax='2')
    b.block('snippet', 20, 520, section='main_after_start', code="print('snippet: flow graph started')")
    b.connect(src, thr)
    b.connect(thr, epy)
    b.connect(epy, sink)
    b.save('python_blocks.grc')


def no_gui(p):
    b = Builder(p, 'web_no_gui', 'No GUI run to completion', generate='no_gui')
    b.doc.set_params(b.doc.fg.options_block.name, {'run_options': 'run'})
    src = b.block('analog_sig_source_x', 20, 120, type='float', samp_rate='samp_rate', freq='1000')
    head = b.block('blocks_head', 250, 120, type='float', num_items='100000')
    sink = b.block('blocks_null_sink', 450, 120, type='float')
    b.connect(src, head)
    b.connect(head, sink)
    b.save('no_gui.grc')


def main():
    install_messenger()
    os.makedirs(OUT, exist_ok=True)
    editor, _ = build_platforms()
    for build in (complex_sinks, float_sinks, triggers, message_widgets, python_blocks, no_gui):
        build(editor)


if __name__ == '__main__':
    main()

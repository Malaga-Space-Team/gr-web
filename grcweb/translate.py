"""Turn the Qt GUI blocks of the *run* platform into web GUI blocks.

Only the code templates change. Parameters, ports, asserts and variable
definitions come from the original block YAML, so a .grc file loads into the
run platform exactly as it does into the editor platform, and the generated
connections still match.

Every web block is created through ``grcweb_rt.make(tb, name, impl, params)``
where ``params`` maps each parameter id to a lambda returning the evaluated
expression (enums are passed as the option key string). Parameter changes at
runtime arrive through one callback per parameter; GRC only keeps the
callbacks whose expression depends on a variable.

Blocks that need Qt but have no web implementation are replaced by a
placeholder that keeps the flow graph running (see ``grcweb_rt.fallback``).
"""

import copy
import logging
import re

from gnuradio.grc.core.blocks._flags import Flags
from gnuradio.grc.core.io import yaml as grc_yaml

log = logging.getLogger(__name__)

RUNTIME_IMPORT = 'import grcweb.runtime as grcweb_rt'

# block id -> runtime implementation name
WEB_GUI = {
    'qtgui_time_sink_x': 'time',
    'qtgui_freq_sink_x': 'freq',
    'qtgui_waterfall_sink_x': 'waterfall',
    'qtgui_const_sink_x': 'const',
    'qtgui_histogram_sink_x': 'histogram',
    'qtgui_number_sink': 'number',
    'qtgui_vector_sink_f': 'vector',
    'qtgui_time_raster_sink_x': 'raster',
    'qtgui_eye_sink_x': 'eye',
    'qtgui_sink_x': 'combo',
    'qtgui_auto_correlator_sink': 'autocorr',
    'qtgui_edit_box_msg': 'edit_box_msg',
    'qtgui_ledindicator': 'led',
    'qtgui_levelgauge': 'level_gauge',
    'qtgui_dialgauge': 'dial_gauge',
    'qtgui_compass': 'compass',
    'qtgui_msgdigitalnumbercontrol': 'digital_number',
    'qtgui_graphicitem': 'graphic_item',
    'qtgui_grbackground': 'background',
    'qtgui_tab_widget': 'tabs',
    'variable_qtgui_range': 'range',
    'variable_qtgui_chooser': 'chooser',
    'variable_qtgui_check_box': 'check_box',
    'variable_qtgui_push_button': 'push_button',
    'variable_qtgui_entry': 'entry',
    'variable_qtgui_label': 'label',
    'variable_qtgui_dial_control': 'dial',
    'variable_qtgui_toggle_button_msg': 'toggle_button',
    'variable_qtgui_toggle_switch': 'toggle_switch',
    'variable_qtgui_msgcheckbox': 'msg_check_box',
    'variable_qtgui_msg_push_button': 'msg_push_button',
    'variable_qtgui_distanceradar': 'distance_radar',
    'variable_qtgui_azelplot': 'azel',
}

# Blocks that only organise the layout (handled by the web page).
LAYOUT_ONLY = {'qtgui_tab_widget', 'qtgui_grbackground'}

_SKIP_PARAM_DTYPES = {'gui_hint', '_multiline'}
_QT_IMPORT = re.compile(r'\b(PyQt[56]?|sip|qtgui|Qt)\b')
_QT_CODE = re.compile(r'top_layout|top_grid_layout|sip\.wrapinstance|\bQt\.|\bqtgui\.|PyQt')


def _flags_list(flags):
    if isinstance(flags, str):
        flags = [f.strip() for f in flags.replace(',', ' ').split()]
    return [f for f in (flags or []) if f]


def _param_arg(param_id):
    """Mako snippet: enum -> option key as a string, anything else -> its code."""
    return '${{(repr(str({p})) if {p}._param.is_enum() else {p})}}'.format(p=param_id)


def _keep_imports(imports):
    lines = [line for line in (imports or '').splitlines()
             if line.strip() and not _QT_IMPORT.search(line)]
    return '\n'.join([RUNTIME_IMPORT] + lines)


def web_block_data(data, impl):
    """Return a copy of the block description with web templates."""
    data = copy.deepcopy(data)
    block_id = data['id']
    data['label'] = re.sub(r'^QT GUI', 'Web GUI', data.get('label') or block_id)
    flags = [f for f in _flags_list(data.get('flags')) if f not in ('need_qt_gui', 'cpp')]
    if 'python' not in flags:
        flags.append('python')
    data['flags'] = flags
    data.pop('cpp_templates', None)

    templates = data.get('templates') or {}
    params = [p for p in data.get('parameters') or []
              if p.get('dtype') not in _SKIP_PARAM_DTYPES and p['id'] not in ('id', 'comment')]
    is_variable = bool(data.get('value'))
    ports = (data.get('inputs') or []) + (data.get('outputs') or [])
    has_ports = bool(ports)
    ref = 'self._${id}_web' if is_variable else 'self.${id}'

    new_templates = {'imports': _keep_imports(templates.get('imports'))}
    if templates.get('var_make'):
        new_templates['var_make'] = templates['var_make']

    if block_id in LAYOUT_ONLY:
        new_templates['make'] = ''
        new_templates['callbacks'] = []
    else:
        args = ', '.join("'{0}': (lambda: ({1}))".format(p['id'], _param_arg(p['id'])) for p in params)
        call = "grcweb_rt.make(self, ${{repr(str(id))}}, '{impl}', {{{args}}})".format(impl=impl, args=args)
        if is_variable:
            make = 'self._${id}_web = ' + call
            if has_ports:
                # same as the Qt version: message connections use self.<id>
                make += '\nself.${id} = self._${id}_web'
        else:
            make = call
        new_templates['make'] = make

        callbacks = [cb for cb in templates.get('callbacks') or []
                     if cb.replace(' ', '').startswith('self.set_${id}(')]
        callbacks += ["{0}.set_param('{1}', lambda: ({2}))".format(ref, p['id'], _param_arg(p['id']))
                      for p in params]
        if is_variable:
            callbacks.append(ref + '.set_value(lambda: (${id}))')
        new_templates['callbacks'] = callbacks

    data['templates'] = new_templates
    return data


def fallback_block_data(data):
    """A placeholder for Qt blocks without a web implementation."""
    data = copy.deepcopy(data)
    flags = [f for f in _flags_list(data.get('flags')) if f not in ('need_qt_gui', 'cpp')]
    data['flags'] = flags
    data['label'] = re.sub(r'^QT GUI', 'Web GUI (unsupported)', data.get('label') or data['id'])
    data.pop('cpp_templates', None)
    templates = data.get('templates') or {}
    new_templates = {'imports': RUNTIME_IMPORT}
    if templates.get('var_make'):
        new_templates['var_make'] = templates['var_make']
    call = "grcweb_rt.fallback(self, ${repr(str(id))})"
    new_templates['make'] = ('self.${id} = ' + call) if data.get('value') else call
    new_templates['callbacks'] = []
    data['templates'] = new_templates
    return data


def needs_qt(block_cls):
    if block_cls.key == 'options':
        return False
    if Flags.NEED_QT_GUI in block_cls.flags or block_cls.label.upper().startswith('QT GUI'):
        return True
    if any(p.get('dtype') == 'gui_hint' for p in block_cls.parameters_data):
        return True
    return bool(_QT_CODE.search(block_cls.templates.get('make') or ''))


def _load_description(block_cls):
    path = getattr(block_cls, 'loaded_from', '')
    if not path or not path.endswith('.block.yml'):
        return None
    with open(path, encoding='utf-8') as fp:
        data = grc_yaml.safe_load(fp)
    data['id'] = data['id'].rstrip('_')
    return data


def webify_platform(platform):
    """Replace Qt GUI blocks of ``platform`` in place."""
    replaced, fallbacks = 0, []
    for block_id, block_cls in list(platform.blocks.items()):
        if block_id in platform.block_classes_build_in:
            continue
        impl = WEB_GUI.get(block_id)
        if impl is None and not needs_qt(block_cls):
            continue
        try:
            data = _load_description(block_cls)
            if data is None:
                continue
            new_data = web_block_data(data, impl) if impl else fallback_block_data(data)
            new_cls = platform.new_block_class(**new_data)
            new_cls.loaded_from = block_cls.loaded_from
            new_cls.category = block_cls.category
            platform.blocks[block_id] = new_cls
            if impl:
                replaced += 1
            else:
                fallbacks.append(block_id)
        except Exception:
            log.exception('Could not create web version of %s', block_id)
    log.info('Run platform: %d Qt GUI blocks mapped to web, %d placeholders %s',
             replaced, len(fallbacks), fallbacks)

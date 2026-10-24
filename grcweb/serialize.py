"""JSON views of GRC core objects for the browser."""

import numbers

from gnuradio.grc.core import Constants

_TYPE_COLORS = {key: color for _, key, _, color in Constants.CORE_TYPES}
_TYPE_COLORS.update((key, color) for key, (_, color) in Constants.ALIAS_TYPES.items())
_DISABLED_COLOR = '#CCCCCC'
_MESSAGE_COLOR = _TYPE_COLORS['message']
_VLEN_DARKEN = (0, 0, 30, 50, 70)


def _darken(color, amount):
    color = color.lstrip('#')
    rgb = [max(int(color[i:i + 2], 16) - amount, 0) for i in (0, 2, 4)]
    return '#' + ''.join('{:02X}'.format(c) for c in rgb)


def port_color(port):
    if not port.parent_block.enabled:
        return _DISABLED_COLOR
    if port.domain == Constants.GR_MESSAGE_DOMAIN:
        return _MESSAGE_COLOR
    color = _TYPE_COLORS.get(port.dtype) or _TYPE_COLORS['']
    if port.vlen > 1:
        color = _darken(color, _VLEN_DARKEN[min(4, port.vlen)])
    return color


def num_to_str(num):
    """Same display logic as gnuradio-companion."""
    def eng_notation(value, fmt='g'):
        template = '{:' + fmt + '}{}'
        magnitude = abs(value)
        for exp, symbol in zip(range(9, -15 - 1, -3), 'GMk munpf'):
            factor = 10 ** exp
            if magnitude >= factor:
                return template.format(value / factor, symbol.strip())
        return template.format(value, '')

    if isinstance(num, numbers.Complex):
        num = complex(num)
        if num == 0:
            return '0'
        output = eng_notation(num.real) if num.real else ''
        output += eng_notation(num.imag, '+g' if output else 'g') + 'j' if num.imag else ''
        return output
    return str(num)


def truncate(param, string, style=0):
    max_len = max(27 - len(param.name), 3)
    if len(string) > max_len:
        if style < 0:
            string = '...' + string[3 - max_len:]
        elif style == 0:
            string = string[:max_len // 2 - 3] + '...' + string[-max_len // 2:]
        else:
            string = string[:max_len - 3] + '...'
    return string


def pretty_print(param):
    value = param.get_value()
    if not param.is_valid():
        return truncate(param, value)
    if value in param.options:
        return param.options[value]
    style = 0
    evaluated = param.get_evaluated()
    if isinstance(evaluated, bool):
        return str(evaluated)
    if isinstance(evaluated, numbers.Complex):
        text = num_to_str(evaluated)
    elif isinstance(evaluated, Constants.VECTOR_TYPES):
        if len(evaluated) > 8:
            text = value
            style = 1
        else:
            text = ', '.join(map(num_to_str, evaluated))
    elif param.dtype in ('file_open', 'file_save'):
        text = value
        style = -1
    else:
        text = str(evaluated).encode('utf-8', 'backslashreplace').decode('utf-8')
    return truncate(param, text.replace('\n', ' '), style)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def port_json(port):
    return {
        'k': port.key,
        'n': port.name,
        'dt': port.dtype,
        'vl': _safe(lambda: port.vlen, 1),
        'msg': port.domain == Constants.GR_MESSAGE_DOMAIN,
        'dom': port.domain,
        'c': port_color(port),
        'opt': bool(_safe(lambda: port.optional, False)),
    }


def surface_params(block):
    if block.is_dummy_block:
        return [['key', block.key, False, None]]
    rows = []
    for param in block.params.values():
        hide = _safe(lambda: param.hide, 'none')
        if hide in ('all', 'part'):
            continue
        shown = pretty_print(param)
        expr = None
        if param.value != str(param.get_evaluated()) and param.value not in param.options:
            expr = truncate(param, param.value)
        rows.append([param.name, shown, param.is_valid(), expr])
    return rows


def block_json(block):
    states = block.states
    x, y = states.get('coordinate', (0, 0))
    valid = block.is_valid()
    return {
        'name': block.name,
        'key': block.key,
        'label': block.label,
        'x': int(x),
        'y': int(y),
        'rot': int(states.get('rotation', 0)) % 360,
        'state': block.state,
        'dummy': block.is_dummy_block,
        'deprecated': bool(block.deprecated),
        'var': bool(block.is_variable),
        'valid': valid,
        'errors': [] if valid else block.get_error_messages()[:20],
        'params': surface_params(block),
        'comment': block.comment or '',
        'in': [port_json(p) for p in block.active_sinks],
        'out': [port_json(p) for p in block.active_sources],
        'bypass': bool(_safe(block.can_bypass, False)),
    }


def connection_id(conn):
    return '{}:{}>{}:{}'.format(conn.source_block.name, conn.source_port.key,
                                conn.sink_block.name, conn.sink_port.key)


def connection_json(conn):
    valid = conn.is_valid()
    return {
        'id': connection_id(conn),
        'src': conn.source_block.name,
        'sp': conn.source_port.key,
        'dst': conn.sink_block.name,
        'dp': conn.sink_port.key,
        'msg': conn.source_port.domain == Constants.GR_MESSAGE_DOMAIN,
        'enabled': conn.enabled,
        'valid': valid,
        'errors': [] if valid else conn.get_error_messages()[:5],
    }


def param_tooltip(param):
    lines = ['Key: ' + param.key, 'Type: ' + str(param.dtype)]
    errors = param.get_error_messages()
    if param.is_valid():
        value = param.get_evaluated()
        if hasattr(value, '__len__') and not isinstance(value, str):
            lines.append('Length: {}'.format(len(value)))
        value = str(value).encode('utf-8', 'backslashreplace').decode('utf-8')
        if len(value) > 100:
            value = '{}...{}'.format(value[:50], value[-50:])
        lines.append('Value: ' + value)
    elif len(errors) == 1:
        lines.append('Error: ' + errors[0])
    elif errors:
        lines.append('Error:')
        lines.extend(' * ' + msg for msg in errors)
    return '\n'.join(lines)


def _has_callback(block, key):
    callbacks = block.templates.get('callbacks') or []
    return any(key in cb for cb in callbacks)


def param_json(block, param):
    options = None
    if param.options:
        options = [[str(k), str(v)] for k, v in param.options.items()]
    return {
        'key': param.key,
        'name': param.name,
        'dtype': str(param.dtype),
        'value': param.get_value(),
        'category': param.category,
        'hide': _safe(lambda: param.hide, 'none'),
        'options': options,
        'enum': param.is_enum(),
        'valid': param.is_valid(),
        'cb': _has_callback(block, param.key),
        'tip': param_tooltip(param),
    }


def generated_code(block):
    parts = []

    def add(header, text):
        if text:
            parts.append('# {}\n{}'.format(header, text.strip('\n')))
    try:
        add('Imports', block.templates.render('imports'))
        if block.is_variable:
            add('Variables', block.templates.render('var_make'))
        add('Blocks', block.templates.render('make'))
        callbacks = block.templates.render('callbacks')
        if callbacks:
            add('Callbacks', '\n'.join(callbacks))
    except Exception as error:
        parts.append('# Template error\n# ' + str(error).replace('\n', '\n# '))
    return '\n\n'.join(parts)


def props_json(block):
    params = [param_json(block, p) for p in block.params.values()
              if p.key == 'id' or _safe(lambda: p.hide, 'none') != 'all']
    docs = {k: v for k, v in (block.documentation or {}).items() if v}
    code_param = None
    if block.key == 'epy_block':
        code_param = '_source_code'
    elif block.key == 'epy_module':
        code_param = 'source_code'
    return {
        'name': block.name,
        'key': block.key,
        'label': block.label,
        'state': block.state,
        'params': params,
        'docs': docs,
        'doc_url': getattr(block, 'doc_url', '') or '',
        'errors': block.get_error_messages(),
        'code': generated_code(block),
        'code_param': code_param,
    }

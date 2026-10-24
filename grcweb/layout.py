"""Window layout of a running flow graph, computed from the GUI hints.

This mirrors what the generated Qt code does: every GUI block goes into a
container (the main window or a page of a "QT GUI Tab Widget"). Blocks with a
position are placed on that container's grid, the others are stacked below the
grid in generation order.
"""

from .translate import WEB_GUI

MAIN = 'main'


def parse_gui_hint(expr, evaluate):
    """Return (container, (row, col, rowspan, colspan) or None)."""
    expr = (expr or '').strip()
    if ':' in expr:
        tab, pos = expr.split(':', 1)
    elif ',' in expr:
        tab, pos = '', expr
    else:
        tab, pos = expr, ''
    tab = tab.strip()
    index = 0
    if '@' in tab:
        tab, index = tab.split('@', 1)
        tab, index = tab.strip(), int(index)
    container = '{}@{}'.format(tab, index) if tab else MAIN
    position = None
    if pos.strip():
        value = evaluate(pos)
        value = [int(v) for v in value]
        if len(value) == 2:
            value += [1, 1]
        if len(value) != 4:
            raise ValueError('bad GUI hint position {!r}'.format(pos))
        position = tuple(value)
    return container, position


def is_gui_block(block):
    return block.key in WEB_GUI or block.label.startswith('Web GUI (unsupported)')


def build(flow_graph):
    containers = {MAIN: {'grid': [], 'stack': []}}
    tabs = {}
    items = {}
    warnings = []

    blocks = sorted((b for b in flow_graph.blocks
                     if b.enabled and not b.get_bypassed() and is_gui_block(b)),
                    key=lambda b: b.name)

    for block in blocks:
        if block.key == 'qtgui_tab_widget':
            count = int(block.params['num_tabs'].get_value())
            labels = []
            for i in range(count):
                param = block.params.get('label{}'.format(i))
                labels.append(str(param.get_evaluated()) if param is not None else 'Tab {}'.format(i))
            tabs[block.name] = {'labels': labels}
            for i in range(count):
                containers.setdefault('{}@{}'.format(block.name, i), {'grid': [], 'stack': []})

    for block in blocks:
        impl = WEB_GUI.get(block.key, 'fallback')
        if impl == 'background':
            continue
        items[block.name] = {'impl': impl, 'label': block.label, 'key': block.key}
        hint = block.params.get('gui_hint')
        container, position = MAIN, None
        if hint is not None:
            try:
                container, position = parse_gui_hint(hint.get_value(), flow_graph.evaluate)
            except Exception as error:
                warnings.append('{}: ignoring GUI hint {!r} ({})'.format(block.name, hint.get_value(), error))
        if container not in containers:
            warnings.append('{}: unknown tab {!r}, shown in the main window'.format(block.name, container))
            container = MAIN
        if position is None:
            containers[container]['stack'].append(block.name)
        else:
            row, col, rowspan, colspan = position
            containers[container]['grid'].append(
                {'name': block.name, 'row': row, 'col': col, 'rowspan': rowspan, 'colspan': colspan})

    return {'containers': containers, 'tabs': tabs, 'items': items, 'warnings': warnings}


def runtime_info(flow_graph):
    """Port layout of the placeholder blocks, read by grcweb.runtime.fallback."""
    info = {}
    for block in flow_graph.blocks:
        if not block.label.startswith('Web GUI (unsupported)') or not block.enabled:
            continue

        def ports(lst):
            return [{'key': p.key, 'msg': p.domain == 'message',
                     'size': 0 if p.domain == 'message' else p.item_size} for p in lst]
        info[block.name] = {'label': block.label, 'in': ports(block.active_sinks),
                            'out': ports(block.active_sources)}
    return info

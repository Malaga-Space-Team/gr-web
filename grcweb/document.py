# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""An open flow graph: GRC core FlowGraph + undo history + change tracking.

All editing goes through the GRC core API (new_block, connect, Param.set_value,
rewrite, validate, import/export_data), mirroring what gnuradio-companion's
GTK canvas does.
"""

import itertools
import json
import os
import secrets

from . import serialize
from .platforms import collect_messages

GRID = 8
UNDO_LIMIT = 42
STATES = ('enabled', 'disabled', 'bypassed')


class OpError(Exception):
    """An operation the user asked for cannot be done (shown in the UI)."""


def _snap(value):
    return int(round(float(value) / GRID) * GRID)


def _rotate_coordinate(x, y, rotation):
    cos_r, sin_r = {0: (1, 0), 90: (0, 1), 180: (-1, 0), 270: (0, -1)}[rotation % 360]
    return x * cos_r + y * sin_r, -x * sin_r + y * cos_r


class Document:
    def __init__(self, platform, path=None, data=None):
        self.id = secrets.token_hex(6)
        self.platform = platform
        self.messages = []
        self.fg = platform.make_flow_graph()
        self.path = os.path.realpath(path) if path else ''
        if path:
            with collect_messages(self.messages):
                data = platform.parse_flow_graph(path)
            self.fg.grc_file_path = self.path
        elif data is None:
            data = platform.parse_flow_graph(None)  # default flow graph
        self._import(data)
        self.undo_stack = []
        self.redo_stack = []
        # a new flow graph only counts as modified once it is edited
        self.saved_snapshot = self._snapshot()
        self.version = 0
        self._sent_blocks = {}
        self._sent_conns = {}
        self._sent_meta = None
        self.pending_props = None  # (block name, data) while a properties dialog is open

    @classmethod
    def restore(cls, platform, path, data, dirty):
        """Rebuild a document from an autosave (see grcweb.server)."""
        doc = cls(platform, data=data)
        doc.path = path or ''
        doc.fg.grc_file_path = doc.path
        doc.saved_snapshot = None if dirty else doc._snapshot()
        return doc

    # ------------------------------------------------------------------ core
    def _import(self, data):
        with collect_messages(self.messages):
            self.fg.import_data(data)
            for block in self.fg.blocks:
                # what the GTK canvas adds to every block; existing values are
                # kept untouched so saving does not rewrite unrelated lines
                block.states.setdefault('coordinate', (0, 0))
                block.states.setdefault('rotation', 0)
            self.refresh()

    def refresh(self):
        self.fg.rewrite()
        # The core gives parameters that are new in a Python block's source an
        # empty value, and only fills in the defaults on the next extraction.
        # Run that second extraction right away.
        stale = [b for b in self.fg.blocks if b.key == 'epy_block' and any(
            getattr(p, '__epy_param__', False) and p.get_value() == '' for p in b.params.values())]
        if stale:
            for block in stale:
                block._epy_source_hash = -1
            self.fg.rewrite()
        self.fg.validate()

    def export(self):
        return self.fg.export_data()

    def _snapshot(self):
        return json.dumps(self.export(), sort_keys=True, default=str)

    def checkpoint(self):
        self.undo_stack.append(self.export())
        del self.undo_stack[:-UNDO_LIMIT]
        self.redo_stack.clear()

    @property
    def dirty(self):
        return self.saved_snapshot != self._snapshot()

    @property
    def title(self):
        if self.path:
            return os.path.basename(self.path)
        return 'untitled'

    def block(self, name):
        try:
            return self.fg.get_block(name)
        except KeyError:
            raise OpError('No block named {!r}'.format(name))

    def unique_id(self, base):
        names = {b.name for b in self.fg.blocks}
        for index in itertools.count():
            candidate = '{}_{}'.format(base, index)
            if candidate not in names:
                return candidate

    # ----------------------------------------------------------- state sync
    def full_state(self):
        self._sent_blocks = {b.name: serialize.block_json(b) for b in self.fg.blocks}
        self._sent_conns = {serialize.connection_id(c): serialize.connection_json(c)
                            for c in self.fg.connections}
        self._sent_meta = self.meta()
        return {
            'doc': self.id,
            'version': self.version,
            'meta': self._sent_meta,
            'blocks': list(self._sent_blocks.values()),
            'connections': list(self._sent_conns.values()),
        }

    def diff(self):
        """Changes since the last full_state()/diff() call (None if nothing changed)."""
        blocks = {b.name: serialize.block_json(b) for b in self.fg.blocks}
        conns = {serialize.connection_id(c): serialize.connection_json(c) for c in self.fg.connections}
        meta = self.meta()
        patch = {
            'blocks': [v for k, v in blocks.items() if self._sent_blocks.get(k) != v],
            'removed_blocks': [k for k in self._sent_blocks if k not in blocks],
            'connections': [v for k, v in conns.items() if self._sent_conns.get(k) != v],
            'removed_connections': [k for k in self._sent_conns if k not in conns],
        }
        if meta != self._sent_meta:
            patch['meta'] = meta
        self._sent_blocks, self._sent_conns, self._sent_meta = blocks, conns, meta
        if not any(patch.values()):
            return None
        self.version += 1
        patch['doc'] = self.id
        patch['version'] = self.version
        return patch

    def variables(self):
        rows = []
        for block in self.fg.blocks:
            if not (block.is_variable or block.key in ('import', 'parameter')):
                continue
            if block.key == 'import':
                value = block.params['imports'].get_value() if 'imports' in block.params else ''
                shown = value
            else:
                param = block.params.get('value')
                value = param.get_value() if param else ''
                shown = serialize.pretty_print(param) if param else ''
            rows.append({'name': block.name, 'key': block.key, 'label': block.label,
                         'value': value, 'shown': shown, 'valid': block.is_valid(),
                         'state': block.state})
        order = {'import': 0, 'parameter': 2}
        rows.sort(key=lambda r: (order.get(r['key'], 1), r['name']))
        return rows

    def meta(self):
        options = self.fg.options_block
        errors = self.fg.get_error_messages()
        return {
            'title': self.title,
            'path': self.path,
            'dirty': self.dirty,
            'undo': len(self.undo_stack),
            'redo': len(self.redo_stack),
            'errors': errors[:200],
            'n_errors': len(errors),
            'variables': self.variables(),
            'fg_id': options.params['id'].get_value(),
            'fg_title': options.params['title'].get_value(),
            'generate_options': options.params['generate_options'].get_value(),
            'output_language': options.params['output_language'].get_value()
            if 'output_language' in options.params else 'python',
        }

    def pop_messages(self):
        messages, self.messages = self.messages, []
        return ''.join(messages)

    # ---------------------------------------------------------- operations
    def add_block(self, key, x, y, params=None):
        if key == 'options' or key not in self.platform.blocks:
            raise OpError('Unknown block {!r}'.format(key))
        self.checkpoint()
        block = self.fg.new_block(key)
        block.params['id'].set_value(self.unique_id(key))
        block.states['coordinate'] = (_snap(x), _snap(y))
        block.states['rotation'] = 0
        for pkey, value in (params or {}).items():
            if pkey in block.params:
                block.params[pkey].set_value(value)
        self.refresh()
        return block.name

    def move(self, positions):
        moved = False
        for name, (x, y) in positions.items():
            block = self.block(name)
            coordinate = (int(x), int(y))
            if tuple(block.states['coordinate']) != coordinate:
                if not moved:
                    self.checkpoint()
                    moved = True
                block.states['coordinate'] = coordinate
        return moved

    def rotate(self, names, rotation):
        blocks = [self.block(n) for n in names]
        if not blocks:
            return
        self.checkpoint()
        xs = [b.states['coordinate'][0] for b in blocks]
        ys = [b.states['coordinate'][1] for b in blocks]
        cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
        for block in blocks:
            block.states['rotation'] = (block.states.get('rotation', 0) + rotation) % 360
            x, y = block.states['coordinate']
            rx, ry = _rotate_coordinate(x - cx, y - cy, rotation)
            block.states['coordinate'] = (_snap(rx + cx), _snap(ry + cy))
        self.refresh()

    def set_state(self, names, state):
        if state not in STATES:
            raise OpError('Unknown state {!r}'.format(state))
        self.checkpoint()
        for name in names:
            block = self.block(name)
            if block is self.fg.options_block:
                continue
            if state == 'bypassed':
                block.set_bypassed()
            else:
                block.state = state
        self.refresh()

    def _find_connection(self, conn_id):
        for conn in self.fg.connections:
            if serialize.connection_id(conn) == conn_id:
                return conn
        return None

    def delete(self, names=(), connections=()):
        self.checkpoint()
        for conn_id in connections:
            conn = self._find_connection(conn_id)
            if conn is not None:
                self.fg.remove_element(conn)
        for name in names:
            block = self.block(name)
            if block is not self.fg.options_block:
                self.fg.remove_element(block)
        self.refresh()

    def _port(self, block_name, key, direction):
        block = self.block(block_name)
        ports = block.active_sources if direction == 'source' else block.active_sinks
        for port in ports:
            if port.key == key:
                return port
        raise OpError('Block {} has no {} port {!r}'.format(block_name, direction, key))

    def connect(self, src, src_port, dst, dst_port):
        source = self._port(src, src_port, 'source')
        sink = self._port(dst, dst_port, 'sink')
        for conn in self.fg.connections:
            if conn.source_port is source and conn.sink_port is sink:
                raise OpError('These ports are already connected')
        if source.domain != sink.domain:
            raise OpError('Cannot connect a {} port to a {} port'.format(source.domain, sink.domain))
        self.checkpoint()
        self.fg.connect(source, sink)
        self.refresh()

    def set_params(self, name, values, checkpoint=True):
        block = self.block(name)
        if checkpoint:
            self.checkpoint()
        for key, value in values.items():
            if key not in block.params:
                continue
            block.params[key].set_value(value)
        self.refresh()
        try:
            return self.fg.get_block(values.get('id', name)).name
        except KeyError:
            return name

    # properties dialog: live preview, then commit or cancel
    def props_begin(self, name):
        block = self.block(name)
        self.pending_props = (name, self.export(), len(self.undo_stack))
        return serialize.props_json(block)

    def props_preview(self, name, values):
        new_name = self.set_params(name, values, checkpoint=False)
        return serialize.props_json(self.block(new_name)), new_name

    def props_end(self, commit):
        if not self.pending_props:
            return
        _, data, _ = self.pending_props
        self.pending_props = None
        current = self.export()
        if commit:
            if json.dumps(current, sort_keys=True, default=str) != json.dumps(data, sort_keys=True, default=str):
                self.undo_stack.append(data)
                del self.undo_stack[:-UNDO_LIMIT]
                self.redo_stack.clear()
        else:
            self._import(data)

    def props(self, name):
        return serialize.props_json(self.block(name))

    def copy(self, names):
        blocks = [self.block(n) for n in names if n != 'options']
        blocks = [b for b in blocks if b is not self.fg.options_block]
        if not blocks:
            return None
        x_min = min(b.states['coordinate'][0] for b in blocks)
        y_min = min(b.states['coordinate'][1] for b in blocks)
        connections = [c.export_data() for c in self.fg.connections
                       if c.source_block in blocks and c.sink_block in blocks]
        return {'origin': [x_min, y_min],
                'blocks': [b.export_data() for b in blocks],
                'connections': connections}

    def paste(self, clipboard, x, y):
        if not clipboard:
            return []
        self.checkpoint()
        x0, y0 = clipboard['origin']
        dx, dy = _snap(x - x0), _snap(y - y0)
        names = {b.name for b in self.fg.blocks}
        pasted = {}
        for data in clipboard['blocks']:
            key = data.get('id')
            if key == 'options':
                continue
            block = self.fg.new_block(key)
            if block is None:
                continue
            data = dict(data)
            original = data.get('name')
            if original in names:
                data['name'] = self.unique_id(original.rsplit('_', 1)[0] if original[-1:].isdigit() else original)
            data['states'] = dict(data.get('states', {}))
            bx, by = data['states'].get('coordinate', (0, 0))
            data['states']['coordinate'] = (int(bx + dx), int(by + dy))
            data['states'].setdefault('rotation', 0)
            block.import_data(**data)
            names.add(block.name)
            pasted[original] = block
        self.fg.rewrite()
        for conn in clipboard['connections']:
            if isinstance(conn, dict):
                src, sp, dst, dp = conn['src_blk_id'], conn['src_port_id'], conn['snk_blk_id'], conn['snk_port_id']
            else:
                src, sp, dst, dp = conn
            try:
                source = next(p for p in pasted[src].sources if p.key == sp)
                sink = next(p for p in pasted[dst].sinks if p.key == dp)
                self.fg.connect(source, sink)
            except (KeyError, StopIteration):
                continue
        self.refresh()
        return [b.name for b in pasted.values()]

    def undo(self):
        if not self.undo_stack:
            return False
        self.redo_stack.append(self.export())
        self._import(self.undo_stack.pop())
        return True

    def redo(self):
        if not self.redo_stack:
            return False
        self.undo_stack.append(self.export())
        self._import(self.redo_stack.pop())
        return True

    def _controller_param(self, block, attr, enum):
        """The parameter GRC would use as type/port-count controller."""
        templates = []
        for port in block.sinks + block.sources:
            try:
                templates.append(str(port.get_raw(attr) or ''))
            except Exception:
                continue
        text = ' '.join(templates)
        for param in block.params.values():
            if param.is_enum() == enum and param.key != 'id' and param.key in text:
                return param
        return None

    def cycle_type(self, names, direction):
        changed = False
        self.checkpoint()
        for name in names:
            param = self._controller_param(self.block(name), 'dtype', True)
            if param is None:
                continue
            keys = list(param.options.keys())
            try:
                index = keys.index(param.get_value())
            except ValueError:
                index = 0
            param.set_value(keys[(index + direction) % len(keys)])
            changed = True
        if changed:
            self.refresh()
        else:
            self.undo_stack.pop()
        return changed

    def change_ports(self, names, direction):
        changed = False
        self.checkpoint()
        for name in names:
            param = self._controller_param(self.block(name), 'multiplicity', False)
            if param is None:
                continue
            try:
                value = int(param.get_evaluated()) + direction
            except (TypeError, ValueError):
                continue
            if value >= 1:
                param.set_value(str(value))
                changed = True
        if changed:
            self.refresh()
        else:
            self.undo_stack.pop()
        return changed

    def save(self, path=None):
        path = os.path.realpath(path or self.path)
        if not path:
            raise OpError('No file name')
        if not path.endswith('.grc'):
            path += '.grc'
        with collect_messages(self.messages):
            self.platform.save_flow_graph(path, self.fg)
        self.path = path
        self.fg.grc_file_path = path
        self.saved_snapshot = self._snapshot()
        return path

    def generate(self):
        """Generate the Python/C++ file next to the .grc, like gnuradio-companion."""
        if not self.path:
            raise OpError('Save the flow graph before generating it')
        errors = self.fg.get_error_messages()
        if errors:
            raise OpError('The flow graph has {} error(s); fix them before generating'.format(len(errors)))
        generate_options = self.fg.get_option('generate_options')
        if generate_options.startswith('hb'):
            out_dir = self.platform.config.hier_block_lib_dir
            os.makedirs(out_dir, exist_ok=True)
        else:
            out_dir = os.path.dirname(self.path)
        with collect_messages(self.messages):
            generator = self.platform.Generator(self.fg, out_dir)
            generator.write()
        return generator.file_path, generate_options.startswith('hb')

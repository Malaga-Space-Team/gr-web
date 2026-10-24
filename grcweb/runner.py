# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""Execution of flow graphs from the browser.

A run takes a snapshot of the document, loads it into the run platform (Qt GUI
blocks replaced by web ones), generates the Python file with the stock GRC
generator and starts it as a child process. The process talks to the server
through a private unix socket (see grcweb.runtime.channel): it sends widget
descriptions and plot frames, and receives variable changes and UI events.
"""

import asyncio
import collections
import ctypes
import json
import logging
import os
import secrets
import shlex
import shutil
import signal
import struct
import sys
import time

from . import layout
from .config import runtime_dir, state_dir
from .document import OpError
from .platforms import collect_messages

log = logging.getLogger(__name__)

PACKAGE_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONSOLE_LINES = 4000
CONSOLE_FLUSH = 0.1   # seconds
CONSOLE_BATCH = 500   # lines per flush at most
_HEADER = struct.Struct('<II')


def _die_with_parent():
    """In the child: get SIGTERM if the server dies, so no flow graph is left behind."""
    try:
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        libc.prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except OSError:
        pass


def run_command(fg, file_path):
    """The command line of the flow graph's "Run Command" option, as GRC runs it."""
    try:
        template = fg.get_option('run_command') or '{python} -u {filename}'
    except KeyError:
        template = '{python} -u {filename}'
    return shlex.split(template.format(python=shlex.quote(sys.executable), filename=shlex.quote(file_path)))


def prepare(platform, data, grc_path, out_dir):
    """Build the runnable flow graph. Returns (file_path, manifest, runtime_info, messages)."""
    messages = []
    with collect_messages(messages):
        fg = platform.make_flow_graph()
        fg.grc_file_path = grc_path or ''
        fg.import_data(data)
        options = fg.options_block.params
        generate_options = options['generate_options'].get_value()
        if generate_options.startswith('hb'):
            raise OpError('This flow graph is a hier block: use Generate to build it')
        if generate_options not in ('qt_gui', 'no_gui'):
            raise OpError('Generate option {!r} is not supported in the browser'.format(generate_options))
        if 'output_language' in options and options['output_language'].get_value() != 'python':
            options['output_language'].set_value('python')
            messages.append('>>> Note: running the C++ flow graph through its Python templates\n')
        options['generate_options'].set_value('no_gui')
        # GRC versions with workflows give the Options block the parameters of
        # the selected workflow when it is rewritten: look them up again
        fg.rewrite()
        options = fg.options_block.params
        if generate_options == 'qt_gui' and 'run_options' in options:
            # a Qt window stays open until it is closed; do the same
            options['run_options'].set_value('prompt')
            fg.rewrite()
        fg.validate()
        errors = fg.get_error_messages()
        if errors:
            raise OpError('Flow graph has {} error(s):\n{}'.format(len(errors), '\n'.join(errors[:20])))
        manifest = layout.build(fg)
        info = layout.runtime_info(fg)
        generator = platform.Generator(fg, out_dir)
        generator.write()
        command = run_command(fg, generator.file_path)
        title = fg.get_option('title') or fg.get_option('id')
    manifest['title'] = title
    return generator.file_path, command, manifest, info, messages


class Run:
    def __init__(self, manager, owner, doc, title):
        self.manager = manager
        self.id = secrets.token_hex(5)
        self.owner = owner
        self.doc_id = doc.id if doc else None
        self.title = title
        self.state = 'starting'
        self.exit_code = None
        self.started = time.time()
        self.console = collections.deque(maxlen=CONSOLE_LINES)
        self.manifest = {}
        self.items = {}      # name -> config sent by the runtime
        self.values = {}     # name -> current widget value
        self.last_frames = {}
        self.subscribers = set()
        self.proc = None
        self.writer = None
        self.dir = manager.run_dir / self.id
        self.sock_path = str(manager.sock_dir / '{}.sock'.format(self.id))
        self._server = None
        self._stop_requested = False
        self._console_out = []
        self._console_timer = None

    def info(self):
        return {'id': self.id, 'owner': self.owner, 'title': self.title, 'doc': self.doc_id,
                'state': self.state, 'exit_code': self.exit_code, 'started': self.started}

    # ------------------------------------------------------------ console
    def add_console(self, text, stream='out'):
        for line in text.splitlines():
            if line.startswith('Press Enter to quit'):
                line = line[len('Press Enter to quit: '):]
                if not line:
                    continue
            entry = {'s': stream, 't': line[:2000]}
            self.console.append(entry)
            self._console_out.append(entry)
        # lines are sent in batches so a chatty flow graph cannot flood the browsers
        if self._console_out and self._console_timer is None:
            self._console_timer = asyncio.get_running_loop().call_later(CONSOLE_FLUSH, self._flush_console)

    def _flush_console(self):
        self._console_timer = None
        lines, self._console_out = self._console_out, []
        if len(lines) > CONSOLE_BATCH:
            skipped = len(lines) - CONSOLE_BATCH
            lines = [{'s': 'grc', 't': '>>> ({} lines skipped)'.format(skipped)}] + lines[-CONSOLE_BATCH:]
        if lines:
            self.broadcast({'ev': 'run.console', 'run': self.id, 'lines': lines})

    def broadcast(self, message):
        for client in list(self.subscribers):
            client.send_json(message)

    def set_state(self, state):
        self.state = state
        self.broadcast({'ev': 'run.state', 'run': self.id, 'info': self.info()})
        self.manager.notify_runs()

    # ------------------------------------------------------------ process
    async def start(self, platform, data, grc_path):
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            file_path, command, manifest, info, messages = prepare(platform, data, grc_path, str(self.dir))
        except OpError:
            raise
        except Exception as error:
            log.exception('generation failed')
            raise OpError('Generation failed: {}'.format(error))
        self.title = manifest.get('title') or self.title
        self.manifest = manifest
        for text in messages:
            self.add_console(text, 'grc')
        for warning in manifest.get('warnings', []):
            self.add_console('>>> Warning: ' + warning, 'grc')
        info_path = self.dir / 'runtime.json'
        info_path.write_text(json.dumps(info))

        self._server = await asyncio.start_unix_server(self._handle_process, path=self.sock_path)
        os.chmod(self.sock_path, 0o600)

        env = dict(os.environ)
        env['PYTHONPATH'] = os.pathsep.join(p for p in (PACKAGE_PARENT, env.get('PYTHONPATH')) if p)
        env['GRCWEB_SOCKET'] = self.sock_path
        env['GRCWEB_RUNTIME_INFO'] = str(info_path)
        env['PYTHONUNBUFFERED'] = '1'
        env['QT_QPA_PLATFORM'] = 'offscreen'  # never open windows on the server
        cwd = os.path.dirname(grc_path) if grc_path else os.path.expanduser('~')
        self.add_console('>>> Executing: {}'.format(' '.join(command)), 'grc')
        self.proc = await asyncio.create_subprocess_exec(
            *command, cwd=cwd, env=env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            start_new_session=True, preexec_fn=_die_with_parent)
        self.set_state('running')
        asyncio.ensure_future(self._pump_output())

    async def _pump_output(self):
        stream = self.proc.stdout
        while True:
            line = await stream.readline()
            if not line:
                break
            self.add_console(line.decode('utf-8', 'replace').rstrip('\n'))
        code = await self.proc.wait()
        self.exit_code = code
        self.add_console('>>> Done (return code {})'.format(code), 'grc')
        self.set_state('exited' if code == 0 or self._stop_requested else 'failed')
        await self._cleanup()

    async def _cleanup(self):
        if self._server is not None:
            self._server.close()
            self._server = None
        try:
            os.unlink(self.sock_path)
        except FileNotFoundError:
            pass
        shutil.rmtree(self.dir, ignore_errors=True)

    async def stop(self):
        if self.proc is None or self.proc.returncode is not None:
            return
        self._stop_requested = True
        self.set_state('stopping')
        for sig, wait in ((signal.SIGINT, 5), (signal.SIGTERM, 3), (signal.SIGKILL, 3)):
            try:
                os.killpg(self.proc.pid, sig)
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(self.proc.wait(), wait)
                return
            except asyncio.TimeoutError:
                continue

    # ------------------------------------------------------ runtime link
    async def _handle_process(self, reader, writer):
        self.writer = writer
        self.send_process({'t': 'viewers', 'n': len(self.subscribers)})
        try:
            while True:
                head = await reader.readexactly(_HEADER.size)
                hlen, plen = _HEADER.unpack(head)
                header = json.loads(await reader.readexactly(hlen))
                payload = await reader.readexactly(plen) if plen else b''
                self._on_process_message(header, payload)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        except Exception:
            log.exception('runtime link error')
        finally:
            self.writer = None
            writer.close()

    def _on_process_message(self, header, payload):
        kind = header.get('t')
        name = header.get('name')
        if kind == 'frame':
            header['run'] = self.id
            self.last_frames[name] = (header, payload)
            for client in list(self.subscribers):
                client.send_frame(header, payload)
        elif kind == 'item':
            self.items[name] = header['config']
            self.broadcast({'ev': 'run.item', 'run': self.id, 'name': name, 'config': header['config']})
        elif kind == 'value':
            self.values[name] = header['value']
            self.broadcast({'ev': 'run.value', 'run': self.id, 'name': name, 'value': header['value']})
        elif kind == 'log':
            self.add_console(header.get('text', ''), 'grc')

    def send_process(self, message):
        if self.writer is None:
            return False
        self.writer.write((json.dumps(message) + '\n').encode())
        return True

    # ------------------------------------------------------- subscribers
    def subscribe(self, client):
        self.subscribers.add(client)
        self.send_process({'t': 'viewers', 'n': len(self.subscribers)})
        for header, payload in self.last_frames.values():
            client.send_frame(header, payload)
        return {'info': self.info(), 'manifest': self.manifest, 'items': self.items,
                'values': self.values, 'console': list(self.console)}

    def unsubscribe(self, client):
        self.subscribers.discard(client)
        self.send_process({'t': 'viewers', 'n': len(self.subscribers)})


def _private_dir(base, name):
    base.mkdir(parents=True, exist_ok=True)
    for entry in base.iterdir():
        if entry.is_dir() and entry.name.isdigit() and entry.name != name and not _alive(int(entry.name)):
            shutil.rmtree(entry, ignore_errors=True)
    path = base / name
    path.mkdir(mode=0o700, exist_ok=True)
    return path


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


class RunManager:
    KEEP_FINISHED = 20

    def __init__(self, settings, on_change):
        self.settings = settings
        self.runs = collections.OrderedDict()
        self._on_change = on_change
        # one folder per server process; those of dead servers are removed
        # (their flow graphs died with them, see _die_with_parent)
        self.sock_dir = _private_dir(runtime_dir(), str(os.getpid()))
        self.run_dir = _private_dir(state_dir() / 'runs', str(os.getpid()))

    def notify_runs(self):
        self._on_change()

    def list(self):
        return [run.info() for run in self.runs.values()]

    def get(self, run_id):
        run = self.runs.get(run_id)
        if run is None:
            raise OpError('No such run')
        return run

    async def start(self, owner, platform, doc):
        active = [r for r in self.runs.values() if r.owner == owner and r.state in ('starting', 'running')]
        if len(active) >= self.settings.max_runs_per_user:
            raise OpError('You already have {} flow graphs running'.format(len(active)))
        run = Run(self, owner, doc, doc.fg.get_option('title') or doc.title)
        data = doc.export()
        self.runs[run.id] = run
        try:
            await run.start(platform, data, doc.path)
        except Exception:
            self.runs.pop(run.id, None)
            await run._cleanup()
            raise
        self._prune()
        self.notify_runs()
        return run

    def _prune(self):
        finished = [r for r in self.runs.values() if r.state in ('exited', 'failed')]
        for run in finished[:-self.KEEP_FINISHED]:
            self.runs.pop(run.id, None)

    def forget(self, run_id):
        run = self.runs.get(run_id)
        if run and run.state in ('exited', 'failed'):
            self.runs.pop(run_id)
            self.notify_runs()

    async def shutdown(self):
        await asyncio.gather(*(run.stop() for run in self.runs.values()), return_exceptions=True)
        shutil.rmtree(self.sock_dir, ignore_errors=True)
        shutil.rmtree(self.run_dir, ignore_errors=True)


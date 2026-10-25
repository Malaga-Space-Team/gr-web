# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""Interactive shells on pseudo-terminals, shown in the browser with xterm.js.

A terminal belongs to one GRC Web user and keeps running while no browser is
attached, so a page reload reconnects to it and replays the recent output.
The shell runs as the account of the server, like the flow graphs do.
"""

import asyncio
import collections
import ctypes
import errno
import fcntl
import logging
import os
import pwd
import signal
import struct
import termios
import time
import uuid

log = logging.getLogger(__name__)

SCROLLBACK_BYTES = 512 * 1024  # output replayed to a browser that attaches
HIGH_WATER = 1024 * 1024       # stop reading the shell when a browser lags this much
LOW_WATER = 128 * 1024
MAX_INPUT = 4 * 1024 * 1024
SEND_CHUNK = 256 * 1024


def _child_setup():
    """In the child: take the pseudo-terminal as controlling terminal and get
    SIGHUP if the server dies."""
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    try:
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        libc.prctl(1, signal.SIGHUP)  # PR_SET_PDEATHSIG
    except OSError:
        pass


def login_shell():
    for shell in (os.environ.get('SHELL'), _passwd_shell(), '/bin/bash', '/bin/sh'):
        if shell and os.access(shell, os.X_OK) and not shell.endswith(('/nologin', '/false')):
            return shell
    return '/bin/sh'


def _passwd_shell():
    try:
        return pwd.getpwuid(os.getuid()).pw_shell
    except KeyError:
        return None


class Attachment:
    """One browser connected to a terminal, with its own send queue."""

    def __init__(self, terminal, ws):
        self.terminal = terminal
        self.ws = ws
        self.queue = collections.deque()
        self.queued = 0
        self.paused = False  # the browser asked to pause (xterm.js is behind)
        self._wake = asyncio.Event()
        self._task = asyncio.ensure_future(self._sender())

    def push(self, data):
        self.queue.append(data)
        self.queued += len(data)
        self._wake.set()

    def send_json(self, text):
        self.queue.append(text)
        self._wake.set()

    async def _sender(self):
        try:
            while True:
                await self._wake.wait()
                self._wake.clear()
                while self.queue:
                    item = self.queue.popleft()
                    if isinstance(item, str):
                        await self.ws.send_str(item)
                        continue
                    parts = [item]
                    size = len(item)
                    while self.queue and isinstance(self.queue[0], bytes) and size < SEND_CHUNK:
                        parts.append(self.queue.popleft())
                        size += len(parts[-1])
                    await self.ws.send_bytes(b''.join(parts))
                    self.queued -= size
                    self.terminal.flow_changed()
        except (ConnectionError, RuntimeError, asyncio.CancelledError):
            pass
        except Exception:
            log.exception('terminal sender failed')

    def close(self):
        self._task.cancel()


class Terminal:
    def __init__(self, owner, number, cwd):
        self.id = uuid.uuid4().hex[:12]
        self.owner = owner
        self.number = number
        self.cwd = cwd
        self.started = time.time()
        self.proc = None
        self.fd = -1
        self.cols, self.rows = 80, 24
        self.exit_code = None
        self.output = collections.deque()
        self.output_size = 0
        self.attachments = set()
        self._reading = False
        self._input = bytearray()
        self._writing = False
        self.on_exit = None

    @property
    def alive(self):
        return self.exit_code is None

    def info(self):
        return {'id': self.id, 'number': self.number, 'owner': self.owner, 'started': self.started,
                'alive': self.alive, 'exit_code': self.exit_code}

    async def start(self, cols, rows):
        shell = login_shell()
        env = dict(os.environ)
        for key in ('INVOCATION_ID', 'JOURNAL_STREAM', 'NOTIFY_SOCKET', 'LISTEN_FDS', 'LISTEN_PID'):
            env.pop(key, None)
        # the launcher puts GRC Web on PYTHONPATH; the user's shell does not need it
        package_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        python_path = [p for p in env.get('PYTHONPATH', '').split(os.pathsep) if p and p != package_parent]
        if python_path:
            env['PYTHONPATH'] = os.pathsep.join(python_path)
        else:
            env.pop('PYTHONPATH', None)
        env.update(TERM='xterm-256color', COLORTERM='truecolor', SHELL=shell)
        env.setdefault('LANG', 'C.UTF-8')
        master, slave = os.openpty()
        try:
            self.fd = master
            self.resize(cols, rows)
            self.proc = await asyncio.create_subprocess_exec(
                shell, '-l', stdin=slave, stdout=slave, stderr=slave, cwd=self.cwd, env=env,
                start_new_session=True, preexec_fn=_child_setup)
        except Exception:
            os.close(master)
            self.fd = -1
            raise
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        self._resume()
        asyncio.ensure_future(self._wait())
        log.info('terminal %s of %s started (%s, pid %d)', self.id, self.owner, shell, self.proc.pid)

    # ------------------------------------------------------------- output
    def _resume(self):
        if not self._reading and self.fd >= 0:
            asyncio.get_running_loop().add_reader(self.fd, self._on_readable)
            self._reading = True

    def _pause(self):
        if self._reading:
            asyncio.get_running_loop().remove_reader(self.fd)
            self._reading = False

    def _on_readable(self):
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno != errno.EIO:
                log.warning('terminal %s: %s', self.id, error)
            data = b''
        if not data:  # every process closed the pseudo-terminal
            self._pause()
            return
        self.output.append(data)
        self.output_size += len(data)
        while self.output_size > SCROLLBACK_BYTES and len(self.output) > 1:
            self.output_size -= len(self.output.popleft())
        for attachment in self.attachments:
            attachment.push(data)
        self.flow_changed()

    def flow_changed(self):
        """Read the shell only while every attached browser keeps up."""
        if not self.alive:
            return
        if any(a.paused or a.queued > HIGH_WATER for a in self.attachments):
            self._pause()
        elif all(not a.paused and a.queued < LOW_WATER for a in self.attachments):
            self._resume()

    def replay(self):
        return b''.join(self.output)

    async def _wait(self):
        code = await self.proc.wait()
        # whatever the shell printed last is still in the pseudo-terminal
        await asyncio.sleep(0.05)
        for _ in range(64):
            if self.fd < 0 or not self._drain_once():
                break
        self._pause()
        self.exit_code = code
        if self.fd >= 0:
            if self._writing:
                asyncio.get_running_loop().remove_writer(self.fd)
                self._writing = False
            os.close(self.fd)
            self.fd = -1
        log.info('terminal %s of %s exited (%s)', self.id, self.owner, code)
        message = '{{"t":"exit","code":{}}}'.format(code)
        for attachment in self.attachments:
            attachment.send_json(message)
        if self.on_exit:
            self.on_exit(self)

    def _drain_once(self):
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            return False
        if data:
            self.output.append(data)
            self.output_size += len(data)
            for attachment in self.attachments:
                attachment.push(data)
        return bool(data)

    # -------------------------------------------------------------- input
    def write(self, data):
        if self.fd < 0 or not data:
            return
        if len(self._input) + len(data) > MAX_INPUT:
            return  # a huge paste nobody reads: drop it rather than grow
        self._input += data
        self._flush()

    def _flush(self):
        try:
            while self._input:
                written = os.write(self.fd, self._input)
                del self._input[:written]
        except BlockingIOError:
            pass
        except OSError:
            self._input.clear()
        loop = asyncio.get_running_loop()
        if self._input and not self._writing and self.fd >= 0:
            loop.add_writer(self.fd, self._flush)
            self._writing = True
        elif not self._input and self._writing:
            loop.remove_writer(self.fd)
            self._writing = False

    def resize(self, cols, rows):
        cols = max(2, min(1000, int(cols)))
        rows = max(1, min(500, int(rows)))
        self.cols, self.rows = cols, rows
        if self.fd >= 0:
            try:
                fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            except OSError:
                pass

    # ------------------------------------------------------------ attach
    def attach(self, ws):
        attachment = Attachment(self, ws)
        self.attachments.add(attachment)
        return attachment

    def detach(self, attachment):
        self.attachments.discard(attachment)
        attachment.close()
        self.flow_changed()

    # --------------------------------------------------------------- end
    def signal_group(self, sig):
        if self.proc is None or not self.alive:
            return
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    async def kill(self, timeout=2.0):
        if not self.alive or self.proc is None:
            return
        self.signal_group(signal.SIGHUP)
        try:
            await asyncio.wait_for(asyncio.shield(self.proc.wait()), timeout)
        except asyncio.TimeoutError:
            self.signal_group(signal.SIGKILL)
            await self.proc.wait()


class TerminalManager:
    def __init__(self, settings, on_change=None):
        self.settings = settings
        self.terminals = collections.OrderedDict()
        self.on_change = on_change  # (owner, event, info)

    def list(self, owner):
        return [t.info() for t in self.terminals.values() if t.owner == owner]

    def get(self, owner, term_id):
        terminal = self.terminals.get(term_id)
        if terminal is None or terminal.owner != owner:
            raise KeyError(term_id)
        return terminal

    async def create(self, owner, cols=80, rows=24):
        mine = [t for t in self.terminals.values() if t.owner == owner]
        if len(mine) >= self.settings.max_terminals_per_user:
            # make room by forgetting terminals whose shell already exited
            for terminal in mine:
                if not terminal.alive:
                    self.terminals.pop(terminal.id, None)
                    self._notify(owner, 'term.closed', terminal.info())
            mine = [t for t in self.terminals.values() if t.owner == owner]
            if len(mine) >= self.settings.max_terminals_per_user:
                raise ValueError('At most {} terminals per user'.format(self.settings.max_terminals_per_user))
        used = {t.number for t in mine}
        number = next(n for n in range(1, len(mine) + 2) if n not in used)
        terminal = Terminal(owner, number, self.settings.roots[0])
        terminal.on_exit = self._exited
        await terminal.start(cols, rows)
        self.terminals[terminal.id] = terminal
        self._notify(owner, 'term.opened', terminal.info())
        return terminal

    def _exited(self, terminal):
        if terminal.id in self.terminals:  # not when closed on purpose
            self._notify(terminal.owner, 'term.exited', terminal.info())

    async def close(self, owner, term_id):
        terminal = self.get(owner, term_id)
        self.terminals.pop(term_id, None)
        await terminal.kill()
        for attachment in list(terminal.attachments):
            terminal.detach(attachment)
            await attachment.ws.close()
        self._notify(owner, 'term.closed', terminal.info())

    async def close_user(self, owner):
        for terminal in [t for t in self.terminals.values() if t.owner == owner]:
            await self.close(owner, terminal.id)

    def _notify(self, owner, event, info):
        if self.on_change:
            self.on_change(owner, event, info)

    async def shutdown(self):
        await asyncio.gather(*(t.kill(1.0) for t in self.terminals.values()), return_exceptions=True)
        self.terminals.clear()

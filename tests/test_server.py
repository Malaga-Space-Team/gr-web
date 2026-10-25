# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""End-to-end checks of the server: authentication, permissions, editing, runs and terminals.

Starts its own server on a free port with a throw-away configuration, so it
can run next to a real instance:  python tests/test_server.py
"""

import asyncio
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile

import aiohttp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLOWGRAPHS = os.path.join(ROOT, 'tests', 'flowgraphs')
PASSWORDS = {'alice': 'alice-password-1', 'bob': 'bob-password-12', 'root': 'root-password-1'}


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, base, user):
        self.base = base
        self.user = user
        self.http = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
        self.ws = None
        self.ids = 0
        self.events = []
        self.frames = 0
        self.pending = {}

    async def login(self, password=None):
        async with self.http.post(self.base + '/api/login', json={
                'user': self.user, 'password': password or PASSWORDS[self.user]}) as r:
            return r.status, await r.json()

    async def connect(self, origin=None):
        headers = {'Origin': origin or self.base}
        self.ws = await self.http.ws_connect(self.base.replace('http', 'ws') + '/ws', headers=headers)
        self.reader = asyncio.ensure_future(self._read())

    async def _read(self):
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                self.frames += 1
                continue
            data = json.loads(msg.data)
            if 'ev' in data:
                self.events.append(data)
            elif data.get('id') in self.pending:
                self.pending.pop(data['id']).set_result(data)

    async def call(self, op, **args):
        self.ids += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.ids] = fut
        await self.ws.send_str(json.dumps({'id': self.ids, 'op': op, 'args': args}))
        reply = await asyncio.wait_for(fut, 30)
        if not reply['ok']:
            raise RuntimeError(reply['error'])
        return reply['result']

    async def close(self):
        if self.ws is not None:
            await self.ws.close()
        await self.http.close()


async def expect_error(coro, text):
    try:
        await coro
    except RuntimeError as error:
        assert text in str(error), error
        return
    raise AssertionError('expected an error containing ' + repr(text))


class TermConnection:
    """The byte stream of one terminal, as the browser sees it."""

    def __init__(self, client, term_id):
        self.client = client
        self.term_id = term_id
        self.output = b''
        self.messages = []

    async def open(self, cols=80, rows=24, origin=None):
        url = self.client.base.replace('http', 'ws') + '/ws/term?id=' + self.term_id
        self.ws = await self.client.http.ws_connect(url, headers={'Origin': origin or self.client.base})
        await self.ws.send_str(json.dumps({'t': 'hello', 'cols': cols, 'rows': rows}))
        self.reader = asyncio.ensure_future(self._read())
        await self.wait_for(lambda: self.messages)
        return self.messages[0]

    async def _read(self):
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                self.output += msg.data
            elif msg.type == aiohttp.WSMsgType.TEXT:
                self.messages.append(json.loads(msg.data))

    async def send(self, **message):
        await self.ws.send_str(json.dumps(message))

    async def wait_for(self, condition, timeout=10):
        for _ in range(int(timeout * 20)):
            if condition():
                return
            await asyncio.sleep(0.05)
        raise AssertionError('timeout; output so far: {!r}'.format(self.output[-500:]))

    async def close(self):
        await self.ws.close()
        await self.reader


async def terminal_checks(alice, bob, base):
    hello = await alice.call('hello')
    assert hello['terminal'] and hello['terminals'] == [], hello['terminals']
    info = await alice.call('term.new', cols=80, rows=24)
    assert info['alive'] and info['number'] == 1, info
    assert any(e['ev'] == 'term.opened' for e in alice.events)

    term = TermConnection(alice, info['id'])
    first = await term.open()
    assert first['t'] == 'hello' and first['alive'], first
    await term.send(t='in', d='echo grcweb-$((40 + 2))\n')
    await term.wait_for(lambda: b'grcweb-42' in term.output)
    await term.send(t='resize', cols=101, rows=31)
    await term.send(t='in', d='stty size\n')
    await term.wait_for(lambda: b'31 101' in term.output)
    print('ok  terminal: input, output and resize')

    # every byte of a large output arrives, in order
    await term.send(t='in', d='seq 1 200000 | tail -c 2000000; echo seq-$((1 + 1))-done\n')
    await term.wait_for(lambda: b'seq-2-done' in term.output, 30)
    assert b'\r\n199999\r\n200000\r\n' in term.output
    print('ok  terminal: large output arrives complete')

    # flow control: while the browser asks to pause, the shell is not read
    await term.send(t='pause')
    await asyncio.sleep(0.2)
    size = len(term.output)
    await term.send(t='in', d='head -c 20000000 /dev/zero | tr "\\\\0" x; echo; echo flow-$((2 + 2))\n')
    await asyncio.sleep(1)
    assert len(term.output) == size, 'output arrived while paused'
    await term.send(t='resume')
    await term.wait_for(lambda: b'flow-4' in term.output, 30)
    assert term.output.count(b'x') >= 20000000
    print('ok  terminal: flow control pauses and resumes the shell')

    # a reload attaches again and replays the recent output
    await term.send(t='in', d='echo replay-$((5 + 5))\n')
    await term.wait_for(lambda: b'replay-10' in term.output)
    await term.close()
    again = TermConnection(alice, info['id'])
    first = await again.open()
    assert first['replay'] > 0
    await again.wait_for(lambda: len(again.output) >= first['replay'])
    assert b'replay-10' in again.output and len(again.output) <= 512 * 1024 + 65536
    print('ok  terminal: reconnecting replays the recent output')

    # other users and other sites cannot reach it
    intruder = TermConnection(bob, info['id'])
    try:
        await intruder.open()
        raise AssertionError('bob attached to the terminal of alice')
    except aiohttp.WSServerHandshakeError as error:
        assert error.status == 404, error.status
    await bob.call('term.close', term=info['id'])
    assert [t['id'] for t in await alice.call('term.list')] == [info['id']], 'bob cannot close it'
    assert await bob.call('term.list') == []
    try:
        await TermConnection(alice, info['id']).open(origin='http://evil.example')
        raise AssertionError('cross-origin terminal accepted')
    except aiohttp.WSServerHandshakeError as error:
        assert error.status == 403, error.status
    print('ok  terminal: private to its user, cross-origin refused')

    # the shell exits: the browser and the other tabs are told
    await again.send(t='in', d='exit 3\n')
    await again.wait_for(lambda: any(m.get('t') == 'exit' for m in again.messages))
    assert [m for m in again.messages if m.get('t') == 'exit'][0]['code'] == 3
    await again.wait_for(lambda: any(e['ev'] == 'term.exited' for e in alice.events))
    await alice.call('term.close', term=info['id'])
    assert await alice.call('term.list') == []
    await again.close()

    # closing a terminal ends the processes started in it
    info = await alice.call('term.new')
    term = TermConnection(alice, info['id'])
    await term.open()
    await term.send(t='in', d='sleep 1000 & echo job-pid:$!:end\n')
    await term.wait_for(lambda: re.search(rb'job-pid:(\d+):end', term.output))
    pid = int(re.search(rb'job-pid:(\d+):end', term.output).group(1))
    await alice.call('term.close', term=info['id'])
    for _ in range(40):
        if not os.path.exists('/proc/{}'.format(pid)):
            break
        await asyncio.sleep(0.1)
    assert not os.path.exists('/proc/{}'.format(pid)), 'a job of a closed terminal survived'
    print('ok  terminal: exit status reported, closing ends its processes')


WORK = None
ENV = None


def manage(*args):
    subprocess.run([sys.executable, '-m', 'grcweb', 'user'] + list(args), cwd=ROOT, env=ENV, check=True,
                   stdout=subprocess.DEVNULL)


async def run_checks(base):
    alice, bob, root = Client(base, 'alice'), Client(base, 'bob'), Client(base, 'root')
    try:
        # --- no session: everything is closed
        async with alice.http.get(base + '/api/library') as r:
            assert r.status == 401, r.status
        async with alice.http.get(base + '/', allow_redirects=False) as r:
            assert r.status == 302 and r.headers['Location'] == '/login'
        async with alice.http.get(base + '/static/js/editor/main.js', allow_redirects=False) as r:
            assert r.status == 302
        print('ok  anonymous requests are refused')

        # --- repeated wrong passwords lock the login
        intruder = Client(base, 'bob')
        for _ in range(5):
            status, _ = await intruder.login('wrong-password')
            assert status == 401
        status, data = await intruder.login('wrong-password')
        assert status == 429, (status, data)
        status, data = await intruder.login()
        assert status == 429, 'even the right password waits while locked'
        await intruder.close()
        print('ok  repeated wrong passwords lock the login')

        # the lock is per user name and per address; use other names from here on
        status, data = await alice.login()
        assert status == 429, 'same address is locked too'
        await asyncio.sleep(31)
        for c in (alice, root):
            status, data = await c.login()
            assert status == 200 and data['ok'], data
        print('ok  login works again after the lock expires')

        # --- cross-site WebSocket is refused
        try:
            await alice.connect(origin='http://evil.example')
            raise AssertionError('cross-origin websocket accepted')
        except aiohttp.WSServerHandshakeError as error:
            assert error.status == 403
        await alice.connect()
        await root.connect()
        print('ok  cross-origin WebSocket refused')

        # --- editing through the API
        hello = await alice.call('hello')
        assert hello['user'] == 'alice' and not hello['admin']
        state = await alice.call('doc.open', path=os.path.join(FLOWGRAPHS, 'complex_sinks.grc'))
        doc = state['doc']
        name = await alice.call('doc.edit', doc=doc, action='add', args={'key': 'blocks_null_sink', 'x': 10, 'y': 10})
        assert name.startswith('blocks_null_sink')
        await alice.call('doc.edit', doc=doc, action='undo', args={})
        await expect_error(alice.call('doc.edit', doc=doc, action='add', args={'key': 'no_such_block'}), 'Unknown block')
        await expect_error(alice.call('files.list', path='/etc'), 'outside the allowed folders')
        print('ok  editing, undo and path checks')

        # --- runs and permissions
        run = await alice.call('run.start', doc=doc)
        await asyncio.sleep(3)
        snapshot = await alice.call('run.subscribe', run=run['id'])
        assert snapshot['info']['state'] == 'running', snapshot['info']
        assert 'freq' in snapshot['values'] or snapshot['items'], snapshot.keys()
        await asyncio.sleep(1)
        assert alice.frames > 5, alice.frames
        await alice.call('run.ui', run=run['id'], name='freq', event='value', data=25000)
        await asyncio.sleep(0.5)
        assert any(e['ev'] == 'run.value' and e['name'] == 'freq' and e['value'] == 25000 for e in alice.events)
        print('ok  run streams frames and widgets change variables')

        # bob logs in now (the lock above has expired)
        status, data = await bob.login()
        assert status == 200, data
        await bob.connect()
        runs = await bob.call('run.list')
        assert any(r['id'] == run['id'] for r in runs), 'other users can see running flow graphs'
        await expect_error(bob.call('run.stop', run=run['id']), 'Only alice')
        await expect_error(bob.call('doc.state', doc=doc), 'no longer open')  # documents are per user
        print('ok  other users can watch but not stop or edit')

        await root.call('run.stop', run=run['id'])
        await asyncio.sleep(1)
        runs = await alice.call('run.list')
        assert [r for r in runs if r['id'] == run['id']][0]['state'] in ('exited', 'failed')
        print('ok  an admin can stop any flow graph')

        # --- validation errors stop a run before it starts
        bad = await alice.call('doc.new')
        await alice.call('doc.edit', doc=bad['doc'], action='add', args={'key': 'blocks_throttle2', 'x': 0, 'y': 0})
        await expect_error(alice.call('run.start', doc=bad['doc']), 'error')
        print('ok  invalid flow graphs are not executed')

        # --- hier blocks: build one, generate it and use it in another flow graph
        hb = await alice.call('doc.new')
        d = hb['doc']
        edit = lambda action, **a: alice.call('doc.edit', doc=d, action=action, args=a)
        await edit('params', name='default', values={'id': 'web_hier_gain', 'title': "'Web hier gain'",
                                                     'generate_options': 'hb', 'category': "'[Test]'"})
        pad_in = await edit('add', key='pad_source', x=0, y=100)
        mul = await edit('add', key='blocks_multiply_const_vxx', x=200, y=100)
        pad_out = await edit('add', key='pad_sink', x=400, y=100)
        await edit('params', name=mul, values={'const': '2'})
        await edit('connect', src=pad_in, sp='0', dst=mul, dp='0')
        await edit('connect', src=mul, sp='0', dst=pad_out, dp='0')
        await alice.call('doc.save', doc=d, path=os.path.join(WORK, 'web_hier_gain.grc'))
        result = await alice.call('doc.generate', doc=d)
        assert result['path'].endswith('web_hier_gain.py'), result
        top = await alice.call('doc.new')
        d = top['doc']
        src = await edit('add', key='analog_sig_source_x', x=0, y=100)
        thr = await edit('add', key='blocks_throttle2', x=200, y=100)
        hier = await edit('add', key='web_hier_gain', x=400, y=100)
        sink = await edit('add', key='qtgui_time_sink_x', x=600, y=100)
        for a, b in ((src, thr), (thr, hier), (hier, sink)):
            await edit('connect', src=a, sp='0', dst=b, dp='0')
        await alice.call('doc.save', doc=d, path=os.path.join(WORK, 'uses_hier.grc'))
        run = await alice.call('run.start', doc=d)
        await asyncio.sleep(3)
        before = alice.frames
        await alice.call('run.subscribe', run=run['id'])
        await asyncio.sleep(1.5)
        assert alice.frames > before + 3, 'the flow graph with the hier block streams data'
        await alice.call('run.stop', run=run['id'])
        print('ok  hier blocks are generated, loaded and executed')

        await terminal_checks(alice, bob, base)

        # --- users managed with the command line while the server runs
        carol = Client(base, 'carol')
        manage('add', 'carol', '--password', 'carol-password-1')
        status, _ = await carol.login('carol-password-1')
        assert status == 200, 'a user added while the server runs can log in'
        await carol.connect()
        shell = TermConnection(carol, (await carol.call('term.new'))['id'])
        await shell.open()
        await shell.send(t='in', d='echo shell-pid:$$:end\n')
        await shell.wait_for(lambda: re.search(rb'shell-pid:(\d+):end', shell.output))
        pid = int(re.search(rb'shell-pid:(\d+):end', shell.output).group(1))
        manage('del', 'carol')
        async with carol.http.get(base + '/api/library') as r:
            assert r.status == 401, 'the session of a deleted user ends'
        for _ in range(100):
            if not os.path.exists('/proc/{}'.format(pid)):
                break
            await asyncio.sleep(0.1)
        assert not os.path.exists('/proc/{}'.format(pid)), 'the terminal of a deleted user keeps running'
        await carol.close()
        print('ok  users added or deleted from the command line apply without a restart (and their shells end)')
    finally:
        for c in (alice, bob, root):
            await c.close()


def main():
    global WORK, ENV
    config = tempfile.mkdtemp(prefix='grcweb-test-')
    WORK = os.path.join(config, 'work')
    os.makedirs(WORK)
    env = dict(os.environ, GRCWEB_CONFIG_DIR=config, GRCWEB_STATE_DIR=os.path.join(config, 'state'),
               GRC_HIER_PATH=os.path.join(config, 'hier'))
    ENV = env
    python = sys.executable
    for user, password in PASSWORDS.items():
        args = [python, '-m', 'grcweb', 'user', 'add', user, '--password', password]
        if user == 'root':
            args.append('--admin')
        subprocess.run(args, cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    port = free_port()
    server = subprocess.Popen([python, '-m', 'grcweb', 'serve', '--port', str(port), '--root', ROOT, '--root', WORK],
                              cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for line in server.stdout:
            if b'GRC Web' in line and b'http' in line:
                break
        asyncio.run(run_checks('http://127.0.0.1:{}'.format(port)))
        print('all server checks passed')
    finally:
        server.terminate()
        server.wait(10)
        shutil.rmtree(config, ignore_errors=True)


if __name__ == '__main__':
    main()

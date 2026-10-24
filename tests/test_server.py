# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""End-to-end checks of the server: authentication, permissions, editing and runs.

Starts its own server on a free port with a throw-away configuration, so it
can run next to a real instance:  python tests/test_server.py
"""

import asyncio
import json
import os
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


WORK = None


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

        # --- brute force throttling (on a separate client address key: user name)
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
    finally:
        for c in (alice, bob, root):
            await c.close()


def main():
    global WORK
    config = tempfile.mkdtemp(prefix='grcweb-test-')
    WORK = os.path.join(config, 'work')
    os.makedirs(WORK)
    env = dict(os.environ, GRCWEB_CONFIG_DIR=config, GRCWEB_STATE_DIR=os.path.join(config, 'state'),
               GRC_HIER_PATH=os.path.join(config, 'hier'))
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

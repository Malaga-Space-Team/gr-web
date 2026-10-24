# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""Minimal WebDriver BiDi client to drive a headless Firefox in UI tests.

Only what the tests need: navigate, evaluate JavaScript, real pointer/keyboard
input, screenshots and console logs. No third party dependencies besides
aiohttp (already used by the server).
"""

import asyncio
import base64
import itertools
import json
import os
import shutil
import socket
import subprocess
import tempfile

import aiohttp


def _free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Browser:
    def __init__(self, width=1500, height=950, headless=True):
        self.headless = headless
        self.width = width
        self.height = height
        self.ids = itertools.count(1)
        self.pending = {}
        self.logs = []
        self.proc = None
        self.profile = None

    async def start(self):
        try:
            return await self._start()
        except BaseException:
            await self.close()
            raise

    async def _start(self):
        port = _free_port()
        self.profile = tempfile.mkdtemp(prefix='grcweb-ff-')
        with open(os.path.join(self.profile, 'user.js'), 'w') as fp:
            fp.write('user_pref("browser.shell.checkDefaultBrowser", false);\n'
                     'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n'
                     'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);\n'
                     'user_pref("webgl.force-enabled", true);\n')
        # without --headless (run under xvfb-run) Firefox gets WebGL through Mesa
        args = ['firefox', '--no-remote', '--profile', self.profile, '--remote-debugging-port', str(port),
                '--width', str(self.width), '--height', str(self.height)]
        if self.headless:
            args.insert(1, '--headless')
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.http = aiohttp.ClientSession()
        for _ in range(100):
            try:
                self.ws = await self.http.ws_connect('ws://127.0.0.1:{}/session'.format(port), max_msg_size=0)
                break
            except aiohttp.ClientError:
                await asyncio.sleep(0.2)
        else:
            raise RuntimeError('Firefox did not start')
        self.reader = asyncio.ensure_future(self._read())
        await self.cmd('session.new', {'capabilities': {'alwaysMatch': {'acceptInsecureCerts': True}}})
        await self.cmd('session.subscribe', {'events': ['log.entryAdded']})
        created = await self.cmd('browsingContext.create', {'type': 'tab'})
        self.context = created['context']
        await self.cmd('browsingContext.setViewport', {'context': self.context,
                                                         'viewport': {'width': self.width, 'height': self.height}})
        return self

    async def _read(self):
        async for msg in self.ws:
            data = json.loads(msg.data)
            if 'id' in data and data['id'] in self.pending:
                self.pending.pop(data['id']).set_result(data)
            elif data.get('method') == 'log.entryAdded':
                p = data['params']
                self.logs.append('{}: {}'.format(p.get('level'), p.get('text')))

    async def cmd(self, method, params):
        cid = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[cid] = fut
        await self.ws.send_str(json.dumps({'id': cid, 'method': method, 'params': params}))
        data = await asyncio.wait_for(fut, 60)
        if data.get('type') == 'error':
            raise RuntimeError('{}: {} {}'.format(method, data.get('error'), data.get('message')))
        return data['result']

    async def goto(self, url):
        await self.cmd('browsingContext.navigate', {'context': self.context, 'url': url, 'wait': 'complete'})

    async def js(self, expression):
        result = await self.cmd('script.evaluate', {
            'expression': expression, 'target': {'context': self.context}, 'awaitPromise': True,
            'resultOwnership': 'none', 'serializationOptions': {'maxObjectDepth': 6}})
        if result.get('type') == 'exception':
            raise RuntimeError('JS: ' + result['exceptionDetails'].get('text', ''))
        return _value(result['result'])

    async def wait_for(self, expression, timeout=15):
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while loop.time() < end:
            try:
                if await self.js(expression):
                    return True
            except RuntimeError:
                pass
            await asyncio.sleep(0.2)
        raise TimeoutError('timed out waiting for: ' + expression)

    async def screenshot(self, path):
        data = await self.cmd('browsingContext.captureScreenshot', {'context': self.context})
        with open(path, 'wb') as fp:
            fp.write(base64.b64decode(data['data']))
        return path

    async def mouse(self, steps):
        """steps: list of ('move', x, y) / ('down', button) / ('up', button) / ('pause', ms)."""
        actions = []
        for step in steps:
            if step[0] == 'move':
                actions.append({'type': 'pointerMove', 'x': int(step[1]), 'y': int(step[2]), 'duration': step[3] if len(step) > 3 else 0})
            elif step[0] == 'down':
                actions.append({'type': 'pointerDown', 'button': step[1] if len(step) > 1 else 0})
            elif step[0] == 'up':
                actions.append({'type': 'pointerUp', 'button': step[1] if len(step) > 1 else 0})
            elif step[0] == 'pause':
                actions.append({'type': 'pause', 'duration': step[1]})
        await self.cmd('input.performActions', {'context': self.context, 'actions': [
            {'type': 'pointer', 'id': 'mouse', 'parameters': {'pointerType': 'mouse'}, 'actions': actions}]})

    async def click(self, x, y, button=0, double=False):
        steps = [('move', x, y), ('down', button), ('up', button)]
        if double:
            steps += [('down', button), ('up', button)]
        await self.mouse(steps)

    async def drag(self, x0, y0, x1, y1, button=0):
        await self.mouse([('move', x0, y0), ('down', button), ('move', (x0 + x1) / 2, (y0 + y1) / 2, 100),
                          ('move', x1, y1, 100), ('up', button)])

    async def keys(self, text, modifiers=()):
        actions = [{'type': 'keyDown', 'value': m} for m in modifiers]
        for ch in text:
            actions += [{'type': 'keyDown', 'value': ch}, {'type': 'keyUp', 'value': ch}]
        actions += [{'type': 'keyUp', 'value': m} for m in reversed(modifiers)]
        await self.cmd('input.performActions', {'context': self.context, 'actions': [
            {'type': 'key', 'id': 'kbd', 'actions': actions}]})

    async def close(self):
        if getattr(self, 'reader', None) is not None:
            try:
                await asyncio.wait_for(self.cmd('session.end', {}), 5)
            except Exception:
                pass
            self.reader.cancel()
        if getattr(self, 'ws', None) is not None:
            await self.ws.close()
        if getattr(self, 'http', None) is not None:
            await self.http.close()
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.profile:
            shutil.rmtree(self.profile, ignore_errors=True)


KEYS = {'Delete': '', 'Backspace': '', 'Enter': '', 'Escape': '',
        'Control': '', 'Shift': '', 'ArrowLeft': '', 'ArrowRight': '',
        'ArrowUp': '', 'ArrowDown': '', 'F5': '', 'F6': '', 'F7': '', 'Tab': ''}


def _value(remote):
    kind = remote.get('type')
    if kind in ('undefined', 'null'):
        return None
    if kind in ('string', 'number', 'boolean'):
        return remote['value']
    if kind == 'array':
        return [_value(v) for v in remote.get('value', [])]
    if kind == 'object':
        return {k if isinstance(k, str) else _value(k): _value(v) for k, v in remote.get('value', [])}
    return remote.get('value')

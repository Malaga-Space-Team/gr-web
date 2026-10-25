# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""Browser test: drives Firefox through the editor, the run window and the terminal.

Needs firefox; run it under xvfb-run to get WebGL (headless Firefox falls back
to the 2D plots, which are tested that way):

    xvfb-run -a -s "-screen 0 1600x1000x24" .venv/bin/python tests/test_ui.py
    .venv/bin/python tests/test_ui.py --headless

Screenshots are written to the folder given with --shots (default: a temp dir).
"""

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from bidi import Browser, KEYS  # noqa: E402
from test_server import ROOT, free_port  # noqa: E402

FLOWGRAPHS = os.path.join(HERE, 'flowgraphs')
USER, PASSWORD = 'uitest', 'ui-test-password'


async def center(b, selector):
    return await b.js('(()=>{const r=document.querySelector(%s).getBoundingClientRect(); '
                      'return [r.x + r.width / 2, r.y + r.height / 2]})()' % json.dumps(selector))


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print('ok  ' + message)


async def login(b, base):
    await b.goto(base + '/login')
    await b.js("document.getElementById('user').value=%s; document.getElementById('password').value=%s;"
               "document.getElementById('login').requestSubmit(); true" % (json.dumps(USER), json.dumps(PASSWORD)))
    await b.wait_for("location.pathname === '/' && window.app && app.active && app.api.connected")


async def add_block(b, query):
    await b.js("app.library.focus(); app.library.search.value=%s; app.library.render(); true" % json.dumps(query))
    count = await b.js('app.active.blocks.size')
    await b.keys(KEYS['Enter'])
    await b.wait_for('app.active.blocks.size > %d' % count)
    return await b.js('app.canvas.selectedBlocks()[0]')


async def open_props(b, name):
    """Double click a block; Enter (same action) if a slow machine missed the double click."""
    await b.click(*(await center(b, '[data-block="%s"] rect.body' % name)), double=True)
    try:
        await b.wait_for("document.querySelector('.modal .params')", timeout=3)
    except TimeoutError:
        await b.click(*(await center(b, '[data-block="%s"] rect.body' % name)))
        await b.keys(KEYS['Enter'])
        await b.wait_for("document.querySelector('.modal .params')")


async def plot_has_pixels(b, selector='.plot-canvas'):
    """True if every plot canvas has drawn something besides the background."""
    return await b.js("""(() => {
        const canvases = [...document.querySelectorAll(%s)].filter(c => c.width > 50 && c.offsetParent);
        if (!canvases.length) return false;
        return canvases.every(c => {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            const colors = new Set();
            for (let i = 0; i < d.length; i += 4 * 97) colors.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]);
            return colors.size > 6;
        });
    })()""" % json.dumps(selector))


async def test_editor(b, base, work, shots):
    await b.js('app.newDoc()')
    await asyncio.sleep(0.5)
    names = []
    # each new block lands near the centre: move it away before adding the next one
    for query, (x, y) in (('Signal Source', (250, 420)), ('throttle', (560, 450)), ('QT GUI Frequency Sink', (850, 420))):
        name = await add_block(b, query)
        await b.drag(*(await center(b, '[data-block="%s"] rect.body' % name)), x, y)
        await asyncio.sleep(0.4)
        names.append(name)
    src, thr, snk = names
    for a, z in ((src, thr), (thr, snk)):
        await b.drag(*(await center(b, '[data-block="%s"] .port[data-dir="out"] rect' % a)),
                     *(await center(b, '[data-block="%s"] .port[data-dir="in"] rect' % z)))
        await asyncio.sleep(0.4)
    check(await b.js('app.active.conns.size') == 2, 'blocks connected by dragging between ports')
    check(await b.js('app.active.meta.n_errors') == 0, 'new flow graph validates without errors')

    await open_props(b, src)
    await b.js("{const i=document.querySelector('.modal [data-key=\"freq\"]'); i.focus(); i.select();} true")
    await b.keys('5000')
    await asyncio.sleep(0.8)
    await b.keys(KEYS['Enter'])
    await b.wait_for("!document.querySelector('.modal')")
    freq = "JSON.stringify(app.active.blocks.get('%s').params.find(p => p[0] === 'Frequency'))" % src
    check('"5k"' in await b.js(freq), 'properties dialog changes a parameter')
    await b.keys('z', modifiers=[KEYS['Control']])
    await asyncio.sleep(0.6)
    check('"1k"' in await b.js(freq), 'undo restores it')
    await b.keys('y', modifiers=[KEYS['Control']])
    await asyncio.sleep(0.6)
    check('"5k"' in await b.js(freq), 'redo applies it again')

    await b.click(*(await center(b, '[data-block="%s"] rect.body' % thr)))
    await b.keys('c', modifiers=[KEYS['Control']])
    await b.mouse([('move', 600, 650)])
    await b.keys('v', modifiers=[KEYS['Control']])
    await asyncio.sleep(0.6)
    pasted = await b.js('app.canvas.selectedBlocks()')
    check(len(pasted) == 1 and pasted[0] != thr, 'copy and paste creates a new block')
    await b.keys(KEYS['Delete'])
    await asyncio.sleep(0.5)
    check(not await b.js("app.active.blocks.has(%s)" % json.dumps(pasted[0])), 'delete removes it')

    await b.click(*(await center(b, '[data-block="%s"] rect.body' % snk)))
    await b.keys(KEYS['ArrowLeft'])
    await b.keys('d')
    await asyncio.sleep(0.6)
    state = await b.js("(() => {const x = app.active.blocks.get('%s'); return x.rot + ' ' + x.state})()" % snk)
    check(state == '90 disabled', 'rotate and disable with the keyboard')
    await b.keys('e')
    await b.keys(KEYS['ArrowRight'])
    await asyncio.sleep(0.4)
    await b.screenshot(os.path.join(shots, 'editor.png'))

    await b.keys('s', modifiers=[KEYS['Control']])
    await b.wait_for("document.querySelector('.modal .files-list')")
    await b.js("{const r=document.querySelector('.modal select'); r.value=%s; r.dispatchEvent(new Event('change'));} true"
               % json.dumps(work))
    await asyncio.sleep(0.6)
    await b.js("{const i=document.querySelector('.files-name input'); i.value='built_in_browser';} true")
    await b.js("[...document.querySelectorAll('.modal .btn.primary')].pop().click(); true")
    await b.wait_for("app.active.meta.path.endsWith('built_in_browser.grc') && !app.active.meta.dirty")
    check(os.path.exists(os.path.join(work, 'built_in_browser.grc')), 'save as through the file dialog')


async def start_run(b, base, flowgraph):
    await b.goto(base + '/')
    await b.wait_for('window.app && app.active && app.api.connected')
    await b.js('app.openDoc(%s)' % json.dumps(os.path.join(FLOWGRAPHS, flowgraph)))
    await b.wait_for('app.active && app.active.meta.title === %s' % json.dumps(flowgraph))
    count = await b.js('app.runs.length')
    await b.js('app.run()')
    await b.wait_for('app.runs.length > %d' % count)
    run_id = await b.js('app.runs[app.runs.length - 1].id')
    await b.goto(base + '/run?id=' + run_id)
    await b.wait_for('window.runPage && runPage.items.size > 0')
    return run_id


async def stop_run(b, run_id):
    await b.js('runPage.api.call("run.stop", {run: %s})' % json.dumps(run_id))
    await asyncio.sleep(1)


async def test_runs(b, base, shots):
    for flowgraph in ('complex_sinks.grc', 'float_sinks.grc', 'triggers.grc'):
        run_id = await start_run(b, base, flowgraph)
        await asyncio.sleep(4)
        await b.screenshot(os.path.join(shots, flowgraph.replace('.grc', '.png')))
        check(await plot_has_pixels(b), '%s: every visible plot shows data' % flowgraph)
        if flowgraph == 'complex_sinks.grc':
            await b.js("{const s = document.querySelector('.ctl.range input[type=range]'); s.value = 50000;"
                       "s.dispatchEvent(new Event('input'));} true")
            await asyncio.sleep(1)
            label = await b.js("document.querySelector('.label-ctl .ctl-value').textContent")
            check(label == '50.0k', 'moving a slider updates the variable and the labels that use it')
        await stop_run(b, run_id)

    run_id = await start_run(b, base, 'message_widgets.grc')
    await asyncio.sleep(2)
    await b.js("[...document.querySelectorAll('.ctl.push .btn')].forEach(x => x.click());"
               "document.querySelector('.toggle-btn').click(); true")
    await b.js("{const i = document.querySelector('.ctl.editbox input:not([readonly])'); i.value = 'world';"
               "document.querySelector('.ctl.editbox button').click();} true")
    await asyncio.sleep(1.5)
    console = await b.js("document.getElementById('console').textContent")
    check('(pressed . 42)' in console and '(cmd . world)' in console and '(value . 1)' in console,
          'message widgets publish their messages')
    await b.screenshot(os.path.join(shots, 'message_widgets.png'))
    await stop_run(b, run_id)


async def test_python_block(b, base):
    await b.goto(base + '/')
    await b.wait_for('window.app && app.active && app.api.connected')
    await b.js('app.openDoc(%s)' % json.dumps(os.path.join(FLOWGRAPHS, 'python_blocks.grc')))
    await b.wait_for("app.active && app.active.meta.title === 'python_blocks.grc'")
    epy = await b.js("[...app.active.blocks.values()].find(x => x.key === 'epy_block').name")
    await open_props(b, epy)
    await b.js("[...document.querySelectorAll('.modal .btn')].find(x => x.textContent.startsWith('Open in editor')).click(); true")
    await b.wait_for("document.querySelector('.code-editor textarea')")
    await b.js("""{const ta = [...document.querySelectorAll('.code-editor textarea')].pop();
        ta.value = ta.value.replace("def __init__(self, gain=2.0):", "def __init__(self, gain=2.0, offset=0.25):")
                           .replace("self.gain = gain", "self.gain = gain\\n        self.offset = offset");
        ta.dispatchEvent(new Event('input'));} true""")
    await b.js("[...document.querySelectorAll('.modal .btn')].find(x => x.textContent === 'Apply & close').click(); true")
    await asyncio.sleep(1.2)
    await b.js("[...document.querySelectorAll('.modal .btn')].find(x => x.textContent === 'OK').click(); true")
    await b.wait_for("!document.querySelector('.modal')")
    params = await b.js("JSON.stringify(app.active.blocks.get(%s).params)" % json.dumps(epy))
    check('"Offset","250m"' in params, 'editing a Python block adds its new parameter with the default value')
    await b.js("app.edit('undo')")
    await asyncio.sleep(0.6)
    await b.js('app.api.call("doc.close", {doc: app.active.id})')


TERM_TEXT = """(() => {
    const item = app.terminals.items.get(app.terminals.current);
    if (!item || !item.view) return '';
    const buf = item.view.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
    return lines.join('\\n');
})()"""


async def test_terminal(b, base, shots):
    await b.goto(base + '/')
    await b.wait_for('window.app && app.active && app.api.connected')
    await b.keys('`', modifiers=[KEYS['Control']])
    await b.wait_for("document.querySelector('.term-pane:not(.hidden) .xterm') && app.terminals.items.size === 1")
    await b.wait_for("document.activeElement && document.activeElement.closest('.term-pane')")
    check(True, 'Ctrl+` opens a terminal in the bottom panel and focuses it')
    await asyncio.sleep(1.5)  # the login shell prints its prompt
    await b.keys('echo ui-$((6 * 7))' + KEYS['Enter'])
    await b.wait_for("%s.includes('ui-42')" % TERM_TEXT)
    check(True, 'typing in the terminal runs commands')
    await b.keys('stty size' + KEYS['Enter'])
    size = await b.js("(() => {const t = app.terminals.items.get(app.terminals.current).view.term; return t.rows + ' ' + t.cols})()")
    await b.wait_for("%s.includes(%s)" % (TERM_TEXT, json.dumps(size)))
    check(int(size.split()[1]) > 80, 'the shell gets the size of the panel ({})'.format(size))
    await b.keys("printf '\\033[1;31mred \\033[32mgreen \\033[34mblue\\033[0m\\n'; ls --color=always /" + KEYS['Enter'])
    await asyncio.sleep(1)
    await b.screenshot(os.path.join(shots, 'terminal.png'))

    await b.keys('`', modifiers=[KEYS['Control']])
    await b.wait_for("document.activeElement === app.canvas.svg")
    check(True, 'Ctrl+` again goes back to the canvas')

    # the shell survives a reload, and its output comes back
    term_id = await b.js('app.terminals.current')
    await b.goto(base + '/')
    await b.wait_for('window.app && app.api.connected && app.terminals.items.size === 1')
    await b.js("app.terminals.show(%s)" % json.dumps(term_id))
    await b.wait_for("%s.includes('ui-42')" % TERM_TEXT)
    check(True, 'after a reload the terminal is still there with its output')

    # the same shell in its own browser tab
    await b.goto(base + '/terminal?id=' + term_id)
    await b.wait_for("document.querySelector('.xterm-rows') && document.querySelector('.xterm-rows').textContent.includes('ui-42')")
    title = await b.js('document.title')
    check('GRC Web' in title, 'the terminal opens in its own page ({})'.format(title))
    await b.goto(base + '/terminal?id=nonexistent')
    await b.wait_for("document.querySelector('.term-missing')")

    await b.goto(base + '/')
    await b.wait_for('window.app && app.api.connected && app.terminals.items.size === 1')
    await b.js("app.terminals.show(%s)" % json.dumps(term_id))
    await b.wait_for("document.activeElement && document.activeElement.closest('.term-pane')")
    await b.keys('exit' + KEYS['Enter'])
    await b.wait_for("%s.includes('Shell exited with code 0')" % TERM_TEXT)
    await b.wait_for("document.querySelector('.term-tab.exited')")
    await b.keys(KEYS['Enter'])
    await b.wait_for("app.terminals.items.size === 0 && !document.querySelector('.term-tab')")
    check(await b.js("app.terminals.current") == 'console', 'exit, then Enter closes the terminal tab')
    check(await b.js("app.api.call('term.list').then(l => l.length)") == 0, 'and the server forgets it')


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--shots', default=None)
    args = parser.parse_args()
    shots = args.shots or tempfile.mkdtemp(prefix='grcweb-shots-')
    os.makedirs(shots, exist_ok=True)
    config = tempfile.mkdtemp(prefix='grcweb-ui-')
    work = os.path.join(config, 'work')
    os.makedirs(work)
    env = dict(os.environ, GRCWEB_CONFIG_DIR=config, GRCWEB_STATE_DIR=os.path.join(config, 'state'),
               GRC_HIER_PATH=os.path.join(config, 'hier'))
    subprocess.run([sys.executable, '-m', 'grcweb', 'user', 'add', USER, '--password', PASSWORD],
                   cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    port = free_port()
    base = 'http://127.0.0.1:{}'.format(port)
    server = subprocess.Popen([sys.executable, '-m', 'grcweb', 'serve', '--port', str(port),
                               '--root', FLOWGRAPHS, '--root', work],
                              cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for line in server.stdout:
        if b'GRC Web' in line and b'http' in line:
            break
    browser = await Browser(headless=args.headless).start()
    try:
        await login(browser, base)
        print('ok  login')
        await test_editor(browser, base, work, shots)
        await test_runs(browser, base, shots)
        await test_python_block(browser, base)
        await test_terminal(browser, base, shots)
        errors = [line for line in browser.logs if line.startswith('error')]
        check(not errors, 'no JavaScript errors ({})'.format(errors[:3]))
        print('all UI checks passed; screenshots in', shots)
    except Exception:
        await browser.screenshot(os.path.join(shots, 'failure.png'))
        print('failure screenshot:', os.path.join(shots, 'failure.png'))
        print('browser log:', browser.logs[-10:])
        raise
    finally:
        await browser.close()
        server.terminate()
        server.wait(10)
        shutil.rmtree(config, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(main())

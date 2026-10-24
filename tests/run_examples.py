# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""Run .grc flow graphs headless through the web runtime and report what arrives.

Usage: python tests/run_examples.py [--seconds N] FILE_OR_DIR...

Each flow graph is translated, generated and executed exactly as when it is
started from the browser; a fake viewer counts the frames and widget
descriptions coming back.
"""

import argparse
import asyncio
import glob
import logging
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from grcweb.config import Settings  # noqa: E402
from grcweb.document import Document, OpError  # noqa: E402
from grcweb.platforms import build_platforms, install_messenger  # noqa: E402
from grcweb.runner import RunManager  # noqa: E402

SKIP_KEYS = ('uhd_', 'soapy_', 'audio_', 'osmosdr', 'iio_', 'zeromq_', 'network_', 'blocks_udp',
             'blocks_tcp', 'blocks_socket', 'video_sdl', 'blocks_file_source', 'blocks_wavfile_source')


class Viewer:
    def __init__(self):
        self.frames = {}
        self.events = []

    def send_json(self, message):
        self.events.append(message)

    def send_frame(self, header, payload):
        key = header.get('name') + ('/' + header['view'] if header.get('view') else '')
        self.frames[key] = self.frames.get(key, 0) + 1


async def run_one(manager, editor, runner, path, seconds):
    doc = Document(editor, path)
    keys = {b.key for b in doc.fg.blocks if b.enabled}
    skip = sorted(k for k in keys if k.startswith(SKIP_KEYS))
    if skip:
        return 'skip', 'hardware/IO blocks: ' + ', '.join(skip)
    if doc.fg.get_error_messages():
        return 'skip', 'invalid in GRC: ' + doc.fg.get_error_messages()[0][:100]
    viewer = Viewer()
    try:
        run = await manager.start('test', runner, doc)
    except OpError as error:
        return 'fail', 'start: ' + str(error)[:300]
    run.subscribe(viewer)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and run.state == 'running':
        await asyncio.sleep(0.1)
    early_exit = run.state != 'running'
    await run.stop()
    errors = [line['t'] for line in run.console
              if any(w in line['t'] for w in ('Traceback', 'Error', 'error:', 'Exception'))]
    gui = {n for n, it in run.manifest.get('items', {}).items() if it['impl'] != 'tabs'}
    widgets = set(run.items)
    missing = sorted(n for n in gui if n not in widgets)
    plots = {n for n, it in run.manifest.get('items', {}).items()
             if it['impl'] in ('time', 'freq', 'waterfall', 'const', 'histogram', 'number', 'vector',
                               'raster', 'eye', 'combo', 'autocorr')}
    silent = sorted(n for n in plots if not any(k.split('/')[0] == n for k in viewer.frames))
    detail = 'items={} frames={}'.format(len(widgets), sum(viewer.frames.values()))
    if errors:
        tail = [l['t'] for l in list(run.console)[-12:]]
        return 'fail', detail + ' console: ' + ' | '.join(tail)[-900:]
    if missing:
        return 'fail', detail + ' no description from ' + ', '.join(missing)
    if silent and not early_exit:
        return 'warn', detail + ' no frames from ' + ', '.join(silent)
    return 'ok', detail + (' (exited early, code {})'.format(run.exit_code) if early_exit else '')


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('paths', nargs='+')
    parser.add_argument('--seconds', type=float, default=3)
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING)
    install_messenger()
    editor, runner = build_platforms()
    manager = RunManager(Settings(max_runs_per_user=100), lambda: None)
    files = []
    for path in args.paths:
        files += sorted(glob.glob(os.path.join(path, '**/*.grc'), recursive=True)) if os.path.isdir(path) else [path]
    totals = {}
    for path in files:
        try:
            status, detail = await run_one(manager, editor, runner, path, args.seconds)
        except Exception as error:
            status, detail = 'fail', 'harness: {!r}'.format(error)
        totals[status] = totals.get(status, 0) + 1
        print('{:5} {} :: {}'.format(status.upper(), os.path.relpath(path), detail), flush=True)
    print('TOTAL', totals)
    await manager.shutdown()


if __name__ == '__main__':
    asyncio.run(main())

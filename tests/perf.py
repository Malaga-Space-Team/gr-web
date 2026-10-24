# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""CPU cost of the web sinks at a high sample rate.

Builds a flow graph (fast noise -> throttle -> frequency, waterfall, time and
constellation sinks), runs it through the web runtime and reports the CPU
usage of the flow graph process with a viewer attached and without viewers,
plus a reference run where the sinks are replaced by null sinks.
"""

import asyncio
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from grcweb.config import Settings  # noqa: E402
from grcweb.platforms import build_platforms, install_messenger  # noqa: E402
from grcweb.runner import RunManager  # noqa: E402
from tests.make_flowgraphs import Builder  # noqa: E402

RATE = float(os.environ.get('PERF_RATE', 20e6))


class Viewer:
    def __init__(self):
        self.frames = 0
        self.bytes = 0

    def send_json(self, message):
        pass

    def send_frame(self, header, payload):
        self.frames += 1
        self.bytes += len(payload)


def build(platform, with_gui):
    b = Builder(platform, 'perf_{}'.format('gui' if with_gui else 'null'), 'Performance')
    b.doc.set_params('samp_rate', {'value': repr(RATE)})
    src = b.block('analog_fastnoise_source_x', 20, 100, type='complex', amp='1')
    thr = b.block('blocks_throttle2', 250, 100, type='complex', samples_per_second='samp_rate')
    b.connect(src, thr)
    if with_gui:
        sinks = [
            b.block('qtgui_freq_sink_x', 500, 20, type='complex', fftsize='4096', bw='samp_rate'),
            b.block('qtgui_waterfall_sink_x', 500, 150, type='complex', fftsize='2048', bw='samp_rate'),
            b.block('qtgui_time_sink_x', 500, 300, type='complex', size='1024', srate='samp_rate'),
            b.block('qtgui_const_sink_x', 500, 450, type='complex', size='1024'),
        ]
    else:
        sinks = [b.block('blocks_null_sink', 500, 20 + 100 * i, type='complex') for i in range(4)]
    for sink in sinks:
        b.connect(thr, sink)
    return b.doc


def cpu_seconds(pid):
    with open('/proc/{}/stat'.format(pid)) as fp:
        fields = fp.read().rsplit(')', 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')


async def measure(run, seconds):
    pid = run.proc.pid
    c0, t0 = cpu_seconds(pid), time.monotonic()
    await asyncio.sleep(seconds)
    return 100.0 * (cpu_seconds(pid) - c0) / (time.monotonic() - t0)


async def main():
    install_messenger()
    editor, runner = build_platforms()
    manager = RunManager(Settings(max_runs_per_user=10), lambda: None)
    results = {}
    for with_gui in (False, True):
        doc = build(editor, with_gui)
        doc.path = os.path.join(tempfile.mkdtemp(), 'perf.grc')
        run = await manager.start('perf', runner, doc)
        await asyncio.sleep(2)
        if with_gui:
            viewer = Viewer()
            run.subscribe(viewer)
            await asyncio.sleep(1)
            viewer.frames = viewer.bytes = 0
            results['web sinks, viewer connected'] = await measure(run, 6)
            rate = viewer.bytes * 8 / 6 / 1e6
            fps = viewer.frames / 6
            run.unsubscribe(viewer)
            await asyncio.sleep(1)
            results['web sinks, nobody watching'] = await measure(run, 6)
        else:
            results['null sinks (reference)'] = await measure(run, 6)
        await run.stop()
    print('Sample rate: {:.1f} Msps'.format(RATE / 1e6))
    for name, value in results.items():
        print('  {:32s} {:6.1f} % CPU'.format(name, value))
    print('  stream to browser: {:.2f} Mbit/s, {:.0f} frames/s'.format(rate, fps))
    await manager.shutdown()


if __name__ == '__main__':
    asyncio.run(main())

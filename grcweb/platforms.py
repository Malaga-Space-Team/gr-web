"""GNU Radio Companion platforms used by the web server.

Two independent instances of the unmodified GRC core platform are created:

* the *editor* platform is exactly what gnuradio-companion uses, so flow
  graphs are edited, validated and saved with the stock block definitions;
* the *run* platform loads the same blocks and then swaps the templates of the
  Qt GUI blocks for web ones (see :mod:`grcweb.translate`). It is only used to
  generate the Python file that is executed when a flow graph is run from the
  browser.

``Platform.block_classes`` is a class attribute in GRC, so each subclass gets
its own map to keep the two block libraries apart.
"""

import collections
import contextlib
import logging
import threading

from gnuradio import gr
from gnuradio.grc.core import Messages
from gnuradio.grc.core.platform import Platform

log = logging.getLogger(__name__)


def _platform_kwargs():
    return dict(
        version=gr.version(),
        version_parts=(gr.major_version(), gr.api_version(), gr.minor_version()),
        prefs=gr.prefs(),
    )


class EditorPlatform(Platform):
    block_classes = collections.ChainMap({}, Platform.block_classes_build_in)


class _NoDocstrings:
    """Docstring extraction is only needed for the editor library."""

    def start(self):
        pass

    def finish(self):
        pass

    def wait(self):
        pass

    def query(self, *args, **kwargs):
        pass


class RunPlatform(Platform):
    block_classes = collections.ChainMap({}, Platform.block_classes_build_in)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._docstring_extractor = _NoDocstrings()

    def build_library(self, path=None):
        super().build_library(path)
        from .translate import webify_platform
        webify_platform(self)


def build_platforms():
    editor = EditorPlatform(**_platform_kwargs())
    editor.build_library()
    runner = RunPlatform(**_platform_kwargs())
    runner.build_library()
    return editor, runner


# --------------------------------------------------------------------------
# GRC core messages (warnings, load errors, ...) are routed to whoever is
# collecting them for the current operation instead of the server's stdout.

_collector = threading.local()


def _messenger(text):
    sink = getattr(_collector, 'sink', None)
    if sink is not None:
        sink.append(text)
    else:
        text = text.strip()
        if text:
            log.debug('grc: %s', text)


def install_messenger():
    Messages.MESSENGERS_LIST[:] = [_messenger]


@contextlib.contextmanager
def collect_messages(into: list):
    previous = getattr(_collector, 'sink', None)
    _collector.sink = into
    try:
        yield into
    finally:
        _collector.sink = previous

"""Runtime imported by flow graphs generated for the browser.

``make()`` is called from the code generated for the Qt GUI blocks (see
grcweb.translate); it returns the web equivalent of each block.
"""

import json
import os

from .base import Params
from .channel import channel
from .sinks import SINKS, FallbackSink
from .widgets import WIDGETS


def make(tb, name, impl, params):
    factory = SINKS.get(impl) or WIDGETS.get(impl)
    if factory is None:
        raise ValueError('grc-web: no web implementation for {!r}'.format(impl))
    return factory(tb, name, Params(params))


_runtime_info = None


def fallback(tb, name):
    """Placeholder for a Qt block without web version: same ports, no output."""
    global _runtime_info
    if _runtime_info is None:
        path = os.environ.get('GRCWEB_RUNTIME_INFO')
        _runtime_info = json.load(open(path)) if path and os.path.exists(path) else {}
    info = _runtime_info.get(name, {})
    ch = channel()
    ch.attach(tb)
    ch.send_item(name, {'impl': 'fallback', 'label': info.get('label', name)})
    return FallbackSink(name, info)


__all__ = ['make', 'fallback', 'channel']

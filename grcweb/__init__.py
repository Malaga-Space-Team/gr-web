"""GRC Web: a browser front-end for GNU Radio Companion.

The GNU Radio Companion core (``gnuradio.grc.core``) does all the real work:
block discovery, parameter evaluation, validation, .grc I/O and code
generation. This package only provides the web interface on top of it and a
small runtime that replaces the Qt GUI blocks with web-streamed equivalents
when a flow graph is executed from the browser.

Keep this module free of heavy imports: ``grcweb.runtime`` is imported by the
generated flow graphs and must not pull in the web server.
"""

__version__ = '0.1.0'

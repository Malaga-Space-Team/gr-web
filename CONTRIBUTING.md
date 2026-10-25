# Contributing to GRC Web

Thanks for helping. Bug reports, fixes, new web versions of Qt blocks and
documentation are all welcome.

## Reporting bugs

Open an issue with:

* the GNU Radio version (`gnuradio-config-info -v`), the distribution and the browser;
* what you did, what you expected and what happened;
* the console output of the server and of the flow graph (the *Output* panel
  of the run window);
* a minimal `.grc` file that reproduces it, if you can.

Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/Malaga-Space-Team/gr-web.git
cd gr-web
./grc-web user add dev --admin
./grc-web serve -v
```

The front-end has no build step: edit the files under `grcweb/static/` and
reload the page. Restart the server after changing Python code.
`grcweb/static/vendor/` holds third-party files copied unchanged from their
packages (see the README there); do not edit them.

## Guidelines

* **Do not reimplement GRC.** Everything about blocks, parameters,
  validation, `.grc` files and code generation must go through
  `gnuradio.grc.core`. The browser only displays what the core says.
* **Keep the front-end self-contained**: plain ES modules, no frameworks,
  no CDNs, no build step. The only third-party code is xterm.js, included in
  `grcweb/static/vendor/`. GRC Web must keep working on servers without
  Internet access.
* **Never block the GNU Radio scheduler.** Web sinks look at the stream once
  per update period, and publishing a frame must never wait for the network.
* **Match the surrounding code**: naming, comment density and idioms. Python
  follows PEP 8 with lines up to about 120 characters; run
  `python -m pyflakes grcweb tests` before sending changes.
* **Add or update tests** for what you change (see below) and keep
  `README.md` in sync with user-visible behaviour.

## Adding the web version of a Qt GUI block

1. Map the block id to a runtime implementation name in `WEB_GUI` in
   `grcweb/translate.py`. Parameters and ports are taken from the original
   block YAML automatically.
2. Implement it in `grcweb/runtime/`:
   * sinks are GNU Radio blocks in `sinks.py`;
   * widgets go in `widgets.py`.

   `config()` describes the item to the browser and `on_ui()` handles events
   coming from it. Register the class in `SINKS` or `WIDGETS`.
3. Draw it in the browser: `grcweb/static/js/run/views.js` for plots (using
   `plots.js`), `controls.js` for widgets. Register it in `VIEWS` or `CONTROLS`.
4. Add the block to a flow graph in `tests/make_flowgraphs.py`, regenerate
   the flow graphs and run the tests.

## Tests

```bash
.venv/bin/python tests/make_flowgraphs.py
.venv/bin/python tests/run_examples.py tests/flowgraphs
.venv/bin/python tests/test_server.py
xvfb-run -a -s "-screen 0 1600x1000x24" .venv/bin/python tests/test_ui.py
```

`tests/test_ui.py` needs Firefox; `tests/bidi.py` is a minimal WebDriver
BiDi client, so no Selenium or Playwright is required.

## License of contributions

GRC Web is licensed under the GNU General Public License v3.0 or later. By
contributing you agree that your contribution is distributed under the same
license. New source files start with:

```
# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later
```

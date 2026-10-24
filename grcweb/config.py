# Copyright 2026 Málaga Space Team
# SPDX-License-Identifier: GPL-3.0-or-later

"""Paths and settings."""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path


def config_dir() -> Path:
    path = os.environ.get('GRCWEB_CONFIG_DIR')
    if not path:
        base = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
        path = os.path.join(base, 'grc-web')
    return Path(path)


def state_dir() -> Path:
    path = os.environ.get('GRCWEB_STATE_DIR')
    if not path:
        base = os.environ.get('XDG_STATE_HOME') or os.path.expanduser('~/.local/state')
        path = os.path.join(base, 'grc-web')
    return Path(path)


def runtime_dir() -> Path:
    """Private directory for the per-run unix sockets (short path, mode 0700)."""
    base = os.environ.get('XDG_RUNTIME_DIR')
    if base and os.path.isdir(base):
        path = Path(base) / 'grc-web'
    else:
        path = state_dir() / 'sock'
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


@dataclass
class Settings:
    host: str = '127.0.0.1'
    port: int = 8410
    certfile: str = ''
    keyfile: str = ''
    # Directories the file browser may show. Users can still run arbitrary
    # code (Python blocks), so this is a convenience, not a sandbox.
    roots: list = field(default_factory=lambda: [os.path.expanduser('~')])
    session_idle_hours: float = 12.0
    session_max_days: float = 7.0
    max_runs_per_user: int = 4

    @property
    def tls(self) -> bool:
        return bool(self.certfile and self.keyfile)

    @classmethod
    def load(cls) -> 'Settings':
        settings = cls()
        path = config_dir() / 'config.json'
        if path.exists():
            data = json.loads(path.read_text())
            for key, value in data.items():
                if hasattr(settings, key):
                    setattr(settings, key, value)
        settings.roots = [os.path.realpath(os.path.expanduser(r)) for r in settings.roots]
        return settings

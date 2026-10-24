"""Users, password hashing, login sessions and brute-force throttling.

The web UI can execute arbitrary Python on the host (Python blocks,
expressions, flow graphs), so every route except the login page requires an
authenticated session.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import time
from pathlib import Path

from .config import config_dir

_SCRYPT = dict(n=2 ** 14, r=8, p=1, dklen=32)
_MIN_PASSWORD = 8


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return 'scrypt${n}${r}${p}${salt}${digest}'.format(
        salt=_b64(salt), digest=_b64(digest), **_SCRYPT)


def check_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split('$')
        if scheme != 'scrypt':
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt),
                                n=int(n), r=int(r), p=int(p), dklen=len(expected))
        return hmac.compare_digest(expected, actual)
    except (ValueError, TypeError):
        return False


# Used to spend the same time on unknown user names as on wrong passwords.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


class UserStore:
    def __init__(self, path: Path = None):
        self.path = path or (config_dir() / 'users.json')
        self.users = {}
        self.load()

    def load(self):
        if self.path.exists():
            self.users = json.loads(self.path.read_text()).get('users', {})
        else:
            self.users = {}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix='.users-')
        with os.fdopen(fd, 'w') as fp:
            json.dump({'users': self.users}, fp, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    @staticmethod
    def validate_name(name: str):
        if not name or len(name) > 64 or not all(c.isalnum() or c in '._-' for c in name):
            raise ValueError('User names may only contain letters, digits, ".", "_" and "-"')

    @staticmethod
    def validate_password(password: str):
        if len(password) < _MIN_PASSWORD:
            raise ValueError(f'Passwords need at least {_MIN_PASSWORD} characters')

    def add(self, name: str, password: str, admin=False):
        self.validate_name(name)
        if name in self.users:
            raise ValueError(f'User {name!r} already exists')
        self.validate_password(password)
        self.users[name] = {'hash': hash_password(password), 'admin': bool(admin),
                            'created': int(time.time())}
        self.save()

    def set_password(self, name: str, password: str):
        if name not in self.users:
            raise KeyError(name)
        self.validate_password(password)
        self.users[name]['hash'] = hash_password(password)
        self.save()

    def delete(self, name: str):
        if self.users.pop(name, None) is None:
            raise KeyError(name)
        self.save()

    def verify(self, name: str, password: str) -> bool:
        user = self.users.get(name)
        ok = check_password(password, user['hash'] if user else _DUMMY_HASH)
        return bool(user) and ok

    def is_admin(self, name: str) -> bool:
        return bool(self.users.get(name, {}).get('admin'))


class Session:
    __slots__ = ('sid', 'user', 'created', 'last_seen')

    def __init__(self, user):
        self.sid = secrets.token_urlsafe(32)
        self.user = user
        self.created = self.last_seen = time.time()


class SessionStore:
    def __init__(self, idle_seconds: float, max_seconds: float):
        self.idle = idle_seconds
        self.max = max_seconds
        self._sessions = {}

    def create(self, user) -> Session:
        session = Session(user)
        self._sessions[session.sid] = session
        return session

    def get(self, sid):
        session = self._sessions.get(sid or '')
        if session is None:
            return None
        now = time.time()
        if now - session.last_seen > self.idle or now - session.created > self.max:
            del self._sessions[sid]
            return None
        session.last_seen = now
        return session

    def delete(self, sid):
        self._sessions.pop(sid or '', None)


class LoginLimiter:
    """Exponential back-off per client address and per user name."""

    FREE_ATTEMPTS = 5
    MAX_LOCK = 15 * 60

    def __init__(self):
        self._failures = {}  # key -> (count, locked_until)

    def wait_time(self, *keys) -> float:
        now = time.time()
        return max([self._failures.get(k, (0, 0))[1] - now for k in keys] + [0])

    def failed(self, *keys):
        now = time.time()
        for key in keys:
            count, _ = self._failures.get(key, (0, 0))
            count += 1
            lock = 0
            if count >= self.FREE_ATTEMPTS:
                lock = min(self.MAX_LOCK, 2 ** (count - self.FREE_ATTEMPTS) * 30)
            self._failures[key] = (count, now + lock)

    def succeeded(self, *keys):
        for key in keys:
            self._failures.pop(key, None)

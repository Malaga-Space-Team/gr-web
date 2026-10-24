"""aiohttp application: login, static files and the WebSocket API."""

import asyncio
import collections
import gzip
import json
import logging
import os
import ssl
import struct
import tempfile
from urllib.parse import urlsplit

from aiohttp import web, WSMsgType

from . import __version__
from .auth import LoginLimiter, SessionStore, UserStore
from .config import state_dir
from .document import Document, OpError
from .platforms import build_platforms, collect_messages, install_messenger
from .runner import RunManager

log = logging.getLogger(__name__)

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
COOKIE = 'grcweb_session'
PUBLIC_PATHS = {'/login', '/api/login', '/static/css/app.css', '/static/js/login.js', '/static/favicon.svg'}
MAX_ROWS_PENDING = 512
AUTOSAVE_PERIOD = 5  # seconds
CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'")


# ---------------------------------------------------------------------------
class Client:
    """One browser WebSocket. Control messages are sent in order; plot frames
    are coalesced per plot so a slow link only drops intermediate frames."""

    def __init__(self, server, ws, user):
        self.server = server
        self.ws = ws
        self.user = user
        self.runs = set()
        self._control = collections.deque()
        self._frames = collections.OrderedDict()
        self._wake = asyncio.Event()
        self._closed = False
        self._task = asyncio.ensure_future(self._sender())

    def send_json(self, message):
        if self._closed:
            return
        self._control.append(json.dumps(message, default=str))
        self._wake.set()

    def send_frame(self, header, payload):
        if self._closed:
            return
        key = (header.get('run'), header.get('name'), header.get('view'))
        pending = self._frames.get(key)
        if pending is not None and 'rows' in header and pending[0].get('cols') == header.get('cols') \
                and pending[0].get('inputs') == header.get('inputs') \
                and pending[0]['rows'] + header['rows'] <= MAX_ROWS_PENDING:
            old_header, old_payload = pending
            merged = dict(header)
            merged['rows'] = old_header['rows'] + header['rows']
            merged['scale'] = old_header.get('scale', []) + header.get('scale', [])
            self._frames[key] = (merged, old_payload + payload)
        else:
            self._frames[key] = (header, payload)
        self._wake.set()

    @staticmethod
    def pack(header, payload):
        data = json.dumps(header).encode()
        data += b' ' * (-(len(data) + 4) % 4)  # keep the payload 4-byte aligned
        return struct.pack('<I', len(data)) + data + payload

    async def _sender(self):
        try:
            while not self._closed:
                await self._wake.wait()
                self._wake.clear()
                while self._control or self._frames:
                    if self._control:
                        await self.ws.send_str(self._control.popleft())
                    else:
                        _, (header, payload) = self._frames.popitem(last=False)
                        await self.ws.send_bytes(self.pack(header, payload))
        except (ConnectionError, RuntimeError):
            pass
        except Exception:
            log.exception('sender failed')

    def close(self):
        self._closed = True
        self._wake.set()
        self._task.cancel()


class Workspace:
    """Open documents of one user, shared by all of the user's browser tabs.

    The open documents (including unsaved changes) are written to the state
    directory every few seconds, so a server restart does not lose work.
    """

    def __init__(self, user):
        self.user = user
        self.docs = collections.OrderedDict()
        self.clients = set()
        self.clipboard = None
        self.changed = False

    @property
    def autosave_path(self):
        return state_dir() / 'workspaces' / (self.user + '.json')

    def save(self):
        data = {'docs': [{'id': doc.id, 'path': doc.path, 'dirty': doc.dirty, 'data': doc.export()}
                         for doc in self.docs.values()]}
        path = self.autosave_path
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.ws-')
        with os.fdopen(fd, 'w') as fp:
            json.dump(data, fp, default=str)
        os.replace(tmp, path)
        self.changed = False

    def load(self, platform):
        try:
            data = json.loads(self.autosave_path.read_text())
        except (OSError, ValueError):
            return
        for entry in data.get('docs', []):
            try:
                doc = Document.restore(platform, entry.get('path'), entry['data'], entry.get('dirty', True))
                doc.id = entry.get('id') or doc.id  # keeps the browser's tabs and views
            except Exception:
                log.exception('cannot restore a document of %s', self.user)
                continue
            self.docs[doc.id] = doc

    def broadcast(self, message, exclude=None):
        for client in list(self.clients):
            if client is not exclude:
                client.send_json(message)


# ---------------------------------------------------------------------------
class Server:
    def __init__(self, settings):
        self.settings = settings
        self.users = UserStore()
        self.sessions = SessionStore(settings.session_idle_hours * 3600, settings.session_max_days * 86400)
        self.limiter = LoginLimiter()
        install_messenger()
        self.editor, self.run_platform = build_platforms()
        self._library_cache = None
        self.workspaces = {}
        self.runs = RunManager(settings, self._runs_changed)
        self.all_clients = set()

    # ------------------------------------------------------------- helpers
    def workspace(self, user):
        if user not in self.workspaces:
            workspace = self.workspaces[user] = Workspace(user)
            workspace.load(self.editor)
        return self.workspaces[user]

    async def autosave(self):
        while True:
            await asyncio.sleep(AUTOSAVE_PERIOD)
            self.save_workspaces()

    def save_workspaces(self):
        for workspace in self.workspaces.values():
            if workspace.changed:
                try:
                    workspace.save()
                except Exception:
                    log.exception('autosave of %s failed', workspace.user)

    def _runs_changed(self):
        message = {'ev': 'runs', 'runs': self.runs.list()}
        for client in list(self.all_clients):
            client.send_json(message)

    def library(self):
        if self._library_cache is None:
            tree = {}
            for key, cls in self.editor.blocks.items():
                category = list(cls.category or [])
                if not category:
                    continue
                node = tree
                for part in category:
                    node = node.setdefault(part, {})
                doc = (cls.documentation or {}).get('', '') or ''
                node.setdefault('', []).append({
                    'key': key, 'label': cls.label, 'doc': doc.strip()[:600],
                    'deprecated': bool(cls.flags.deprecated) if hasattr(cls.flags, 'deprecated') else False,
                })

            def convert(name, node):
                blocks = sorted(node.get('', []), key=lambda b: b['label'].lower())
                children = [convert(k, v) for k, v in sorted(node.items(), key=lambda kv: kv[0].lower()) if k]
                return {'name': name, 'blocks': blocks, 'children': children}
            data = convert('', tree)
            self._library_cache = gzip.compress(json.dumps(data).encode())
        return self._library_cache

    def check_path(self, path):
        real = os.path.realpath(os.path.expanduser(path or self.settings.roots[0]))
        for root in self.settings.roots:
            if real == root or real.startswith(root.rstrip(os.sep) + os.sep):
                return real
        raise OpError('Path outside the allowed folders')

    # --------------------------------------------------------------- HTTP
    async def index(self, request):
        return web.FileResponse(os.path.join(STATIC, 'index.html'))

    async def run_page(self, request):
        return web.FileResponse(os.path.join(STATIC, 'run.html'))

    async def login_page(self, request):
        if request.get('session'):
            raise web.HTTPFound('/')
        return web.FileResponse(os.path.join(STATIC, 'login.html'))

    async def api_login(self, request):
        try:
            data = await request.json()
            user, password = str(data.get('user', '')), str(data.get('password', ''))
        except Exception:
            raise web.HTTPBadRequest()
        peer = request.remote or '?'
        keys = ('ip:' + peer, 'user:' + user)
        wait = self.limiter.wait_time(*keys)
        if wait > 0:
            return web.json_response({'ok': False, 'error': 'Too many attempts, wait {} s'.format(int(wait) + 1)},
                                     status=429)
        ok = await asyncio.get_running_loop().run_in_executor(None, self.users.verify, user, password)
        if not ok:
            self.limiter.failed(*keys)
            log.warning('failed login for %r from %s', user, peer)
            return web.json_response({'ok': False, 'error': 'Wrong user name or password'}, status=401)
        self.limiter.succeeded(*keys)
        session = self.sessions.create(user)
        log.info('login %s from %s', user, peer)
        response = web.json_response({'ok': True})
        secure = self.settings.tls or request.headers.get('X-Forwarded-Proto') == 'https'
        response.set_cookie(COOKIE, session.sid, httponly=True, samesite='Strict', secure=secure, path='/')
        return response

    async def api_logout(self, request):
        self.sessions.delete(request.cookies.get(COOKIE))
        response = web.json_response({'ok': True})
        response.del_cookie(COOKIE, path='/')
        return response

    async def api_password(self, request):
        data = await request.json()
        user = request['session'].user
        if not self.users.verify(user, str(data.get('old', ''))):
            return web.json_response({'ok': False, 'error': 'Current password is wrong'}, status=400)
        try:
            self.users.set_password(user, str(data.get('new', '')))
        except ValueError as error:
            return web.json_response({'ok': False, 'error': str(error)}, status=400)
        return web.json_response({'ok': True})

    async def api_library(self, request):
        return web.Response(body=self.library(), content_type='application/json',
                            headers={'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache'})

    async def api_download(self, request):
        try:
            path = self.check_path(request.query.get('path', ''))
        except OpError as error:
            raise web.HTTPForbidden(text=str(error))
        if not os.path.isfile(path):
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={
            'Content-Disposition': 'attachment; filename="{}"'.format(os.path.basename(path).replace('"', ''))})

    async def api_upload(self, request):
        reader = await request.multipart()
        directory = None
        saved = []
        async for part in reader:
            if part.name == 'dir':
                directory = self.check_path(await part.text())
            elif part.name == 'file' and part.filename:
                if directory is None:
                    raise web.HTTPBadRequest(text='dir must come first')
                name = os.path.basename(part.filename)
                target = self.check_path(os.path.join(directory, name))
                size = 0
                with open(target, 'wb') as fp:
                    while True:
                        chunk = await part.read_chunk()
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > 200 * 1024 * 1024:
                            raise web.HTTPRequestEntityTooLarge(max_size=200 * 1024 * 1024, actual_size=size)
                        fp.write(chunk)
                saved.append(target)
        return web.json_response({'ok': True, 'saved': saved})

    # ---------------------------------------------------------- WebSocket
    async def websocket(self, request):
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=32 * 1024 * 1024)
        await ws.prepare(request)
        session = request['session']
        client = Client(self, ws, session.user)
        workspace = self.workspace(session.user)
        workspace.clients.add(client)
        self.all_clients.add(client)
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                if self.sessions.get(request.cookies.get(COOKIE)) is None:
                    client.send_json({'ev': 'logout'})
                    break
                try:
                    message = json.loads(msg.data)
                except ValueError:
                    continue
                await self.dispatch(client, workspace, message)
        finally:
            workspace.clients.discard(client)
            self.all_clients.discard(client)
            for run_id in list(client.runs):
                run = self.runs.runs.get(run_id)
                if run:
                    run.unsubscribe(client)
            client.close()
        return ws

    async def dispatch(self, client, workspace, message):
        req_id = message.get('id')
        op = str(message.get('op', ''))
        args = message.get('args') or {}
        handler = getattr(self, 'op_' + op.replace('.', '_'), None)
        try:
            if handler is None:
                raise OpError('Unknown operation {!r}'.format(op))
            result = handler(client, workspace, args)
            if asyncio.iscoroutine(result):
                result = await result
            reply = {'id': req_id, 'ok': True, 'result': result}
        except OpError as error:
            reply = {'id': req_id, 'ok': False, 'error': str(error)}
        except Exception as error:
            log.exception('operation %s failed', op)
            reply = {'id': req_id, 'ok': False, 'error': '{}: {}'.format(type(error).__name__, error)}
        if req_id is not None:
            client.send_json(reply)

    # ---------------------------------------------------------- operations
    def op_hello(self, client, workspace, args):
        return {
            'user': client.user, 'admin': self.users.is_admin(client.user), 'version': __version__,
            'gr_version': self.editor.config.version, 'roots': self.settings.roots,
            'docs': [doc.full_state() for doc in workspace.docs.values()],
            'runs': self.runs.list(),
        }

    def _doc(self, workspace, args):
        doc = workspace.docs.get(args.get('doc'))
        if doc is None:
            raise OpError('This flow graph is no longer open')
        return doc

    def _publish(self, workspace, doc, exclude=None):
        patch = doc.diff()
        if patch is not None:
            workspace.changed = True
            workspace.broadcast({'ev': 'doc.patch', 'patch': patch})
        text = doc.pop_messages()
        if text:
            workspace.broadcast({'ev': 'console', 'text': text, 'doc': doc.id})

    def _open_doc(self, workspace, doc):
        workspace.docs[doc.id] = doc
        workspace.changed = True
        state = doc.full_state()
        workspace.broadcast({'ev': 'doc.opened', 'state': state})
        text = doc.pop_messages()
        if text:
            workspace.broadcast({'ev': 'console', 'text': text, 'doc': doc.id})
        return state

    def op_doc_new(self, client, workspace, args):
        return self._open_doc(workspace, Document(self.editor))

    def op_doc_open(self, client, workspace, args):
        path = self.check_path(args.get('path', ''))
        for doc in workspace.docs.values():
            if doc.path == path:
                return doc.full_state()
        if not os.path.isfile(path):
            raise OpError('File not found: ' + path)
        try:
            doc = Document(self.editor, path)
        except Exception as error:
            raise OpError('Cannot open {}: {}'.format(os.path.basename(path), error))
        return self._open_doc(workspace, doc)

    def op_doc_close(self, client, workspace, args):
        doc = workspace.docs.pop(args.get('doc'), None)
        if doc is not None:
            workspace.changed = True
            workspace.broadcast({'ev': 'doc.closed', 'doc': doc.id})
        return True

    def op_doc_state(self, client, workspace, args):
        return self._doc(workspace, args).full_state()

    def op_doc_edit(self, client, workspace, args):
        """All editing operations on a document."""
        doc = self._doc(workspace, args)
        action = args.get('action')
        a = args.get('args') or {}
        result = None
        with collect_messages(doc.messages):
            if action == 'add':
                result = doc.add_block(a['key'], a.get('x', 0), a.get('y', 0), a.get('params'))
            elif action == 'move':
                doc.move(a['positions'])
            elif action == 'rotate':
                doc.rotate(a['names'], int(a.get('rotation', 90)))
            elif action == 'state':
                doc.set_state(a['names'], a['state'])
            elif action == 'delete':
                doc.delete(a.get('names', []), a.get('connections', []))
            elif action == 'connect':
                doc.connect(a['src'], a['sp'], a['dst'], a['dp'])
            elif action == 'params':
                result = doc.set_params(a['name'], a['values'])
            elif action == 'props_begin':
                result = doc.props_begin(a['name'])
            elif action == 'props_preview':
                result, _ = doc.props_preview(a['name'], a['values'])
            elif action == 'props_end':
                doc.props_end(bool(a.get('commit')))
            elif action == 'props':
                result = doc.props(a['name'])
            elif action == 'copy':
                workspace.clipboard = doc.copy(a['names'])
                result = bool(workspace.clipboard)
            elif action == 'cut':
                workspace.clipboard = doc.copy(a['names'])
                doc.delete(a['names'], [])
            elif action == 'paste':
                result = doc.paste(workspace.clipboard, a.get('x', 0), a.get('y', 0))
            elif action == 'undo':
                doc.undo()
            elif action == 'redo':
                doc.redo()
            elif action == 'type':
                doc.cycle_type(a['names'], int(a.get('direction', 1)))
            elif action == 'ports':
                doc.change_ports(a['names'], int(a.get('direction', 1)))
            else:
                raise OpError('Unknown edit {!r}'.format(action))
        self._publish(workspace, doc)
        return result

    def op_doc_save(self, client, workspace, args):
        doc = self._doc(workspace, args)
        path = args.get('path')
        if path:
            path = self.check_path(path if path.endswith('.grc') else path + '.grc')
            if os.path.exists(path) and path != doc.path and not args.get('overwrite'):
                raise OpError('exists')
        elif not doc.path:
            raise OpError('No file name')
        saved = doc.save(path)
        self._publish(workspace, doc)
        workspace.broadcast({'ev': 'console', 'text': 'Saved {}\n'.format(saved), 'doc': doc.id})
        return saved

    def op_doc_generate(self, client, workspace, args):
        doc = self._doc(workspace, args)
        try:
            path, hier = doc.generate()
        finally:
            self._publish(workspace, doc)
        workspace.broadcast({'ev': 'console', 'text': 'Generated {}\n'.format(path), 'doc': doc.id})
        if hier:
            self.reload_library()
            workspace.broadcast({'ev': 'console', 'text': 'Block library reloaded (hier block)\n'})
        code = None
        if args.get('show') and os.path.isfile(path):
            with open(path, encoding='utf-8', errors='replace') as fp:
                code = fp.read()
        return {'path': path, 'code': code}

    def reload_library(self):
        with collect_messages([]):
            self.editor, self.run_platform = build_platforms()
        self._library_cache = None
        for workspace in self.workspaces.values():
            for doc in workspace.docs.values():
                data = doc.export()
                doc.platform = self.editor
                doc.fg = self.editor.make_flow_graph()
                doc.fg.grc_file_path = doc.path
                doc._import(data)
                workspace.broadcast({'ev': 'doc.opened', 'state': doc.full_state()})
            workspace.broadcast({'ev': 'library'})

    def op_library_reload(self, client, workspace, args):
        self.reload_library()
        return True

    def op_files_list(self, client, workspace, args):
        path = self.check_path(args.get('path') or self.settings.roots[0])
        if os.path.isfile(path):
            path = os.path.dirname(path)
        show_hidden = bool(args.get('hidden'))
        entries = []
        try:
            with os.scandir(path) as it:
                for entry in it:
                    if entry.name.startswith('.') and not show_hidden:
                        continue
                    try:
                        is_dir = entry.is_dir()
                        stat = entry.stat()
                    except OSError:
                        continue
                    entries.append({'name': entry.name, 'dir': is_dir, 'size': stat.st_size,
                                    'mtime': int(stat.st_mtime)})
        except OSError as error:
            raise OpError(str(error))
        entries.sort(key=lambda e: (not e['dir'], e['name'].lower()))
        parent = os.path.dirname(path)
        try:
            self.check_path(parent)
        except OpError:
            parent = None
        return {'path': path, 'parent': parent if parent != path else None, 'entries': entries,
                'roots': self.settings.roots}

    def op_files_mkdir(self, client, workspace, args):
        path = self.check_path(os.path.join(args['path'], os.path.basename(args['name'])))
        os.makedirs(path, exist_ok=False)
        return path

    # ---------------------------------------------------------------- runs
    async def op_run_start(self, client, workspace, args):
        doc = self._doc(workspace, args)
        run = await self.runs.start(client.user, self.run_platform, doc)
        return run.info()

    def _run(self, args):
        return self.runs.get(args.get('run'))

    async def op_run_stop(self, client, workspace, args):
        run = self._run(args)
        if run.owner != client.user and not self.users.is_admin(client.user):
            raise OpError('Only {} (or an admin) can stop this flow graph'.format(run.owner))
        await run.stop()
        return True

    def op_run_list(self, client, workspace, args):
        return self.runs.list()

    def op_run_forget(self, client, workspace, args):
        self.runs.forget(args.get('run'))
        return True

    def op_run_subscribe(self, client, workspace, args):
        run = self._run(args)
        client.runs.add(run.id)
        return run.subscribe(client)

    def op_run_unsubscribe(self, client, workspace, args):
        run = self.runs.runs.get(args.get('run'))
        if run is not None:
            run.unsubscribe(client)
        client.runs.discard(args.get('run'))
        return True

    def op_run_ui(self, client, workspace, args):
        run = self._run(args)
        if not run.send_process({'t': 'ui', 'name': args.get('name'), 'event': args.get('event'),
                                 'data': args.get('data')}):
            raise OpError('The flow graph is not running')
        return True


# ---------------------------------------------------------------------------
def make_app(server):
    @web.middleware
    async def security(request, handler):
        session = server.sessions.get(request.cookies.get(COOKIE))
        request['session'] = session
        path = request.path
        if session is None and path not in PUBLIC_PATHS:
            if path.startswith('/api/') or path == '/ws':
                raise web.HTTPUnauthorized()
            raise web.HTTPFound('/login')
        if request.method not in ('GET', 'HEAD') or path == '/ws':
            origin = request.headers.get('Origin')
            if origin and urlsplit(origin).netloc != request.host:
                raise web.HTTPForbidden(text='Cross-origin request refused')
        response = await handler(request)
        if not getattr(response, 'prepared', False):
            response.headers.setdefault('Content-Security-Policy', CSP)
            response.headers.setdefault('X-Content-Type-Options', 'nosniff')
            response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
            response.headers.setdefault('Referrer-Policy', 'no-referrer')
            if path.endswith(('.js', '.css', '.html')) or path in ('/', '/run'):
                response.headers.setdefault('Cache-Control', 'no-cache')
        return response

    app = web.Application(middlewares=[security], client_max_size=256 * 1024 * 1024)
    app.router.add_get('/', server.index)
    app.router.add_get('/run', server.run_page)
    app.router.add_get('/login', server.login_page)
    app.router.add_post('/api/login', server.api_login)
    app.router.add_post('/api/logout', server.api_logout)
    app.router.add_post('/api/password', server.api_password)
    app.router.add_get('/api/library', server.api_library)
    app.router.add_get('/api/files/download', server.api_download)
    app.router.add_post('/api/files/upload', server.api_upload)
    app.router.add_get('/ws', server.websocket)
    app.router.add_static('/static/', STATIC, show_index=False, follow_symlinks=False)

    async def on_startup(app):
        app['autosave'] = asyncio.ensure_future(server.autosave())

    async def on_shutdown(app):
        app['autosave'].cancel()
        server.save_workspaces()
        for client in list(server.all_clients):
            await client.ws.close()
        await server.runs.shutdown()
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    return app


def serve(settings):
    server = Server(settings)
    if not server.users.users:
        raise SystemExit('No users configured. Create one first:\n'
                         '  grc-web user add <name> --admin')
    app = make_app(server)
    ssl_context = None
    if settings.tls:
        ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_context.load_cert_chain(settings.certfile, settings.keyfile)
    elif settings.host not in ('127.0.0.1', 'localhost', '::1'):
        log.warning('Listening on %s without TLS: passwords travel in clear text. '
                    'Use --certfile/--keyfile, a reverse proxy or an SSH tunnel.', settings.host)
    scheme = 'https' if ssl_context else 'http'
    banner = 'GRC Web {} (GNU Radio {}) on {}://{}:{}/'.format(
        __version__, server.editor.config.version, scheme, settings.host, settings.port)
    # aiohttp calls print once the socket is listening
    web.run_app(app, host=settings.host, port=settings.port, ssl_context=ssl_context,
                print=lambda _: print(banner, flush=True), access_log=None)

"""Command line: ``python -m grcweb serve`` and user management."""

import argparse
import getpass
import logging
import os
import sys

from .auth import UserStore
from .config import Settings, config_dir


def _ask_password(confirm=True):
    password = getpass.getpass('Password: ')
    if confirm and getpass.getpass('Repeat password: ') != password:
        raise SystemExit('Passwords do not match')
    return password


def cmd_serve(args):
    settings = Settings.load()
    for key in ('host', 'port', 'certfile', 'keyfile'):
        value = getattr(args, key)
        if value:
            setattr(settings, key, value)
    if args.tls and not settings.tls:
        cert, key = config_dir() / 'cert.pem', config_dir() / 'key.pem'
        if not cert.exists():
            raise SystemExit('No certificate yet. Create one with:  grc-web cert')
        settings.certfile, settings.keyfile = str(cert), str(key)
    if args.root:
        settings.roots = [os.path.realpath(os.path.expanduser(r)) for r in args.root]
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    from .server import serve
    serve(settings)


def cmd_cert(args):
    """Self-signed TLS certificate in the configuration folder."""
    import ipaddress
    import shutil
    import socket
    import subprocess
    openssl = shutil.which('openssl')
    if not openssl:
        raise SystemExit('openssl not found')
    names = args.names or [socket.gethostname()]
    alt = ['DNS:localhost', 'IP:127.0.0.1']
    for name in names:
        try:
            ipaddress.ip_address(name)
            alt.append('IP:' + name)
        except ValueError:
            alt.append('DNS:' + name)
    folder = config_dir()
    folder.mkdir(parents=True, exist_ok=True)
    cert, key = folder / 'cert.pem', folder / 'key.pem'
    subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '825',
                    '-subj', '/CN=' + names[0], '-addext', 'subjectAltName=' + ','.join(alt),
                    '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
    key.chmod(0o600)
    fingerprint = subprocess.run([openssl, 'x509', '-in', str(cert), '-noout', '-fingerprint', '-sha256'],
                                 check=True, capture_output=True, text=True).stdout.strip()
    print('Certificate for {} written to {}'.format(', '.join(alt), cert))
    print(fingerprint)
    print('Start the server with:  grc-web serve --host 0.0.0.0 --tls')


def cmd_user(args):
    store = UserStore()
    try:
        if args.action == 'list':
            for name, info in sorted(store.users.items()):
                print(name, '(admin)' if info.get('admin') else '')
        elif args.action == 'add':
            store.add(args.name, args.password or _ask_password(), admin=args.admin)
            print('User {} created in {}'.format(args.name, store.path))
        elif args.action == 'passwd':
            store.set_password(args.name, args.password or _ask_password())
            print('Password changed')
        elif args.action == 'del':
            store.delete(args.name)
            print('User {} deleted'.format(args.name))
    except (ValueError, KeyError) as error:
        raise SystemExit('Error: {}'.format(error))


def main(argv=None):
    parser = argparse.ArgumentParser(prog='grc-web', description='GNU Radio Companion in the browser')
    sub = parser.add_subparsers(dest='command', required=True)

    serve = sub.add_parser('serve', help='start the web server')
    serve.add_argument('--host', help='address to listen on (default 127.0.0.1)')
    serve.add_argument('--port', type=int, help='port (default 8410)')
    serve.add_argument('--certfile', help='TLS certificate (PEM)')
    serve.add_argument('--keyfile', help='TLS private key (PEM)')
    serve.add_argument('--tls', action='store_true', help='use the certificate made by "grc-web cert"')
    serve.add_argument('--root', action='append', help='folder shown in the file browser (repeatable)')
    serve.add_argument('-v', '--verbose', action='store_true')
    serve.set_defaults(func=cmd_serve)

    cert = sub.add_parser('cert', help='create a self-signed TLS certificate')
    cert.add_argument('names', nargs='*', help='host names or IP addresses of the server')
    cert.set_defaults(func=cmd_cert)

    user = sub.add_parser('user', help='manage users ({})'.format(config_dir() / 'users.json'))
    user.add_argument('action', choices=['list', 'add', 'passwd', 'del'])
    user.add_argument('name', nargs='?')
    user.add_argument('--admin', action='store_true', help='may stop flow graphs of other users')
    user.add_argument('--password', help=argparse.SUPPRESS)  # for scripted setups/tests
    user.set_defaults(func=cmd_user)

    args = parser.parse_args(argv)
    if args.command == 'user' and args.action != 'list' and not args.name:
        parser.error('a user name is required')
    args.func(args)


if __name__ == '__main__':
    sys.exit(main())

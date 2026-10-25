# Security

## What GRC Web protects, and what it cannot

GRC Web gives its users the full power of GNU Radio Companion: Python
blocks, Python expressions in every parameter, and the execution of flow
graphs. **Anyone with an account can run arbitrary code as the operating
system user that runs the server.** This is by design; it cannot be
sandboxed without taking away what makes GRC useful. The built-in terminal
makes it explicit: it is a shell with those rights. Turning it off
(`--no-terminal`, or `"terminal": false` in the configuration) removes the
shell, not the ability to run code through flow graphs.

The security features are therefore about keeping everybody else out:

* every page, file, API call and WebSocket requires a login;
* passwords are hashed with scrypt;
* session cookies are `HttpOnly`, `SameSite=Strict` and `Secure` over HTTPS;
* repeated failed logins are throttled per user name and per address;
* cross-origin requests and WebSockets are rejected;
* a terminal belongs to the user who opened it: nobody else, admins
  included, can see or type into it, and it ends when that user is deleted;
* the server sends CSP, `X-Frame-Options` and `nosniff` headers.

## Recommended deployment

* Give accounts only to people you would trust with a shell on the machine.
* Run the server as a dedicated, unprivileged user. Grant that user only the
  devices and folders it needs: SDR udev rules, and `--root` folders for the
  file browser.
* Keep the default `--host 127.0.0.1` and reach it through an SSH tunnel.
  If you expose it, always use HTTPS (`--tls`, your own certificate, or a
  reverse proxy) so passwords and sessions are not sent in clear text.
* Keep GNU Radio, Python and aiohttp up to date.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them
privately through GitHub: *Security* tab of the repository →
*Report a vulnerability*. Include the version, a description and the steps
to reproduce. We will acknowledge the report and coordinate a fix and its
disclosure with you.

# GRC Web

GNU Radio Companion en el navegador. Editas flowgraphs, los ejecutas y ves las
gráficas en tiempo real desde una página web, sin X11 forwarding ni escritorio
remoto. Todo el procesado se hace en el servidor; al navegador solo le llegan
los datos ya reducidos que se dibujan (espectros, trazas, filas de waterfall…).

GRC Web **no reimplementa GRC**: usa el core de GNU Radio Companion sin
modificar (`gnuradio.grc.core`). La carga de bloques (incluidos los OOT), la
evaluación de parámetros, la validación, la lectura/escritura de `.grc` y la
generación de código son las del GRC de escritorio. Un `.grc` guardado desde la
web es idéntico, byte a byte, al que guardaría GRC.

```
Navegador ── HTTPS/WebSocket ──► servidor grc-web (Python, aiohttp)
  editor SVG                       │  gnuradio.grc.core (sin modificar)
  gráficas WebGL2                  │  ├─ plataforma "editor": bloques originales
                                   │  └─ plataforma "run": bloques Qt GUI → web
                                   ▼
                         proceso del flowgraph (Python generado por GRC)
                         + grcweb.runtime (sinks y widgets web) ── socket unix ──► servidor
```

## Requisitos

* GNU Radio 3.10 con su Python (probado con 3.10.12, Python 3.14, Arch Linux).
* `aiohttp` (lo instala el lanzador en un entorno virtual que ve los paquetes del sistema).
* Un navegador moderno. Las gráficas usan WebGL2 y, si no está disponible
  (algunos escritorios remotos o máquinas virtuales), un dibujado Canvas 2D equivalente.

## Puesta en marcha

```bash
cd ~/grc-web
./grc-web user add diego --admin      # pide la contraseña (mínimo 8 caracteres)
./grc-web serve                       # http://127.0.0.1:8410
```

El primer arranque crea `.venv/` con el Python que tiene GNU Radio
(`GRCWEB_PYTHON=/ruta/python3` para elegir otro). Opciones útiles de `serve`:

| Opción | Uso |
|---|---|
| `--host 0.0.0.0` | escuchar en todas las interfaces (por defecto solo `127.0.0.1`) |
| `--port N` | puerto (8410) |
| `--tls` | HTTPS con el certificado creado por `grc-web cert` |
| `--certfile/--keyfile` | HTTPS con tu propio certificado |
| `--root DIR` | carpetas que muestra el explorador de ficheros (repetible; por defecto tu `$HOME`) |

La configuración persistente va en `~/.config/grc-web/config.json` (mismos
nombres: `host`, `port`, `certfile`, `keyfile`, `roots`, `session_idle_hours`,
`max_runs_per_user`).

### Acceso remoto

1. **Túnel SSH (recomendado, nada expuesto a la red):**
   ```bash
   ssh -L 8410:127.0.0.1:8410 usuario@servidor
   ```
   y abrir `http://localhost:8410` en tu portátil.
2. **HTTPS directo:**
   ```bash
   ./grc-web cert servidor.midominio 192.168.1.50   # certificado autofirmado
   ./grc-web serve --host 0.0.0.0 --tls
   ```
3. Detrás de un proxy inverso con TLS (nginx, Caddy): reenviar también el
   WebSocket `/ws` y la cabecera `X-Forwarded-Proto`.

Sin TLS y escuchando fuera de localhost, el servidor avisa de que las
contraseñas viajarían en claro.

### Como servicio

```bash
mkdir -p ~/.config/systemd/user && cp contrib/grc-web.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now grc-web
loginctl enable-linger $USER
```

### Módulos OOT (Soapy, gr-satellites, gr-osmosdr, propios…)

Se detectan igual que en GRC, porque es GRC quien carga los bloques: los
ficheros `.block.yml` de `<prefijo>/share/gnuradio/grc/blocks`, de
`GRC_BLOCKS_PATH` y de `[grc] local_blocks_path / global_blocks_path` en la
configuración de GNU Radio, más los hier blocks de `~/.local/state/gnuradio`.

* Instalado en el mismo prefijo que GNU Radio (paquete de la distribución,
  `cmake -DCMAKE_INSTALL_PREFIX=/usr`): aparece sin hacer nada.
* Instalado en otro prefijo (`/usr/local`, `/opt/...`): igual que con GRC,
  exporta `GRC_BLOCKS_PATH` y `PYTHONPATH` antes de arrancar el servidor (en el
  servicio systemd, con líneas `Environment=`). Los flowgraphs heredan ese entorno.
* Si instalas algo con el servidor en marcha, pulsa *Reload block library* en la
  barra (no hace falta reiniciar; los flowgraphs abiertos se recargan).

Los bloques de hardware (Soapy, UHD…) se ejecutan en el servidor, así que usan
los dispositivos conectados a esa máquina, con los permisos (udev) del usuario
que lanza `grc-web`.

## Usuarios y seguridad

```bash
./grc-web user list | add NOMBRE [--admin] | passwd NOMBRE | del NOMBRE
```

* Todo (páginas, ficheros estáticos, API y WebSocket) exige sesión; la única
  página pública es el login.
* Contraseñas con scrypt; sesiones en cookie `HttpOnly`, `SameSite=Strict` (y
  `Secure` con HTTPS), caducan tras 12 h de inactividad.
* Tras 5 intentos fallidos el login se bloquea con espera creciente (por usuario y por IP).
* Se rechazan peticiones y WebSockets de otro origen; cabeceras CSP,
  `X-Frame-Options` y `nosniff`.
* Cada usuario tiene sus documentos abiertos. Todos ven qué flowgraphs están
  en marcha; solo su dueño o un admin pueden pararlos.

Importante: igual que GRC, la herramienta ejecuta código arbitrario (bloques
Python, expresiones, flowgraphs) **con el usuario del sistema que lanza el
servidor**. Da cuentas solo a quien podría tener ya una shell en esa máquina.

## Uso

**Editor** (mismo modelo que GRC): librería de bloques con búsqueda a la
derecha, lienzo en el centro, consola y variables abajo. Doble clic abre las
propiedades, que se validan en vivo con el core (los errores salen en rojo
igual que en GRC). El bloque de Python embebido se edita con un editor de
código integrado; al aplicar, el core vuelve a extraer puertos y parámetros.
Atajos de teclado como en GRC (botón `?` de la barra para verlos todos).

Varios usuarios o pestañas del navegador comparten el estado del servidor.
Los documentos abiertos, con cambios sin guardar, se guardan cada 5 s en
`~/.local/state/grc-web/workspaces/` y se recuperan si el servidor se reinicia.

**Ejecutar** (F6): se abre una ventana flotante (o una pestaña, botón
"abrir aparte") con la interfaz del flowgraph, colocada según los *GUI hints*
y las *QT GUI Tab Widget*, como la ventana Qt. El flowgraph sigue corriendo
aunque cierres la ventana o se corte la conexión; vuelves a verlo desde el
menú de ejecuciones.

**Gráficas**: arrastrar = zoom de un recuadro, clic derecho = deshacer zoom,
rueda = zoom en X (Mayús: en Y), Mayús+arrastrar = desplazar. Cada gráfica
tiene pausa, autoescala, rejilla y captura PNG; la de frecuencia añade
max/min hold, promediado, tamaño de FFT y ventana; la de tiempo, el panel de
trigger; el waterfall, mapa de colores y rango de intensidad. Doble clic en
frecuencia/waterfall envía la frecuencia por el puerto `freq`, como Qt.

## Bloques Qt GUI soportados

Al ejecutar desde la web, los bloques Qt GUI se sustituyen por equivalentes
web con los mismos parámetros y puertos (el `.grc` no cambia):

* Sinks: Time, Frequency, Waterfall, Constellation, Histogram, Number,
  Vector, Time Raster, Eye, QT GUI Sink (combinado) y Fast Auto-Correlator.
  Incluye entradas de mensajes (PDU), triggers Free/Auto/Normal/Tag con
  retardo, visualización de tags y múltiples entradas.
* Controles: Range, Chooser, Check Box, Push Button, Entry, Label, Toggle
  Button, Toggle Switch, Msg CheckBox, Msg Push Button, Dial, Digital Number
  Control, Message Edit Box.
* Indicadores: LED, Level Gauge, Dial Gauge, Compass, Distance Radar, Az-El
  Plot, Graphic Item. Tab Widget y GUI hints para la colocación.

Los bloques que necesitan Qt y no tienen versión web (BER curve sink, Graphic
Overlay, `uhd_msg_push_button`, widgets Qt de módulos OOT) se reemplazan por
un marcador con los mismos puertos: el flowgraph funciona pero ese bloque no
muestra nada.

### Limitaciones conocidas

* Hier blocks generados como *Hier Block (QT GUI)*: su código contiene Qt y se
  ejecutan como marcador. Los hier blocks normales funcionan.
* Flowgraphs en C++: se ejecutan a través de sus plantillas Python.
* Código Qt escrito a mano dentro de bloques Python o snippets no se muestra
  (el proceso corre con `QT_QPA_PLATFORM=offscreen`, sin ventanas en el servidor).
* Salida Bokeh GUI no soportada.

## Rendimiento

Las gráficas, igual que en Qt, toman una instantánea de las últimas muestras
en cada periodo de actualización; el resto se consume sin procesar. Lo que
viaja por la red son vectores ya reducidos (como máximo 4096 puntos por
gráfica, filas de waterfall cuantizadas a 8 bits), con política "el último
frame gana" en el proceso, en el servidor y por cliente: una conexión lenta
pierde frames intermedios pero nunca frena al flowgraph.

Medido en esta máquina (`python tests/perf.py`): 20 Msps con FFT 4096,
waterfall 2048, tiempo y constelación → unos 2,8 Mbit/s hacia el navegador a
40 frames/s y ~25 % de un núcleo de CPU adicional en el proceso del flowgraph.

## Pruebas

```bash
.venv/bin/python tests/make_flowgraphs.py          # regenera tests/flowgraphs/*.grc
.venv/bin/python tests/run_examples.py tests/flowgraphs   # ejecuta cada uno con el runtime web
.venv/bin/python tests/test_server.py               # login, permisos, edición, ejecución, hier blocks
.venv/bin/python tests/perf.py                      # coste de CPU a alta tasa
```

Prueba de interfaz con Firefox real (editor, ejecución, gráficas, widgets,
bloques Python). Con `xvfb-run` hay WebGL; con `--headless` se prueba el
dibujado Canvas 2D:

```bash
xvfb-run -a -s "-screen 0 1600x1000x24" .venv/bin/python tests/test_ui.py
.venv/bin/python tests/test_ui.py --headless
```

`tests/bidi.py` es el cliente WebDriver BiDi mínimo que usan estas pruebas.

## Estructura

```
grcweb/
  platforms.py   plataformas GRC (editor y run) sobre el core sin modificar
  translate.py   bloques Qt GUI → plantillas web en la plataforma "run"
  document.py    flowgraph abierto: operaciones de edición, deshacer, diffs
  serialize.py   vistas JSON de bloques/puertos/parámetros (lógica de GRC)
  layout.py      GUI hints y pestañas → layout de la ventana de ejecución
  runner.py      generación, proceso hijo, enlace con el runtime
  server.py      aiohttp: login, ficheros, WebSocket, autoguardado
  auth.py        usuarios (scrypt), sesiones, límite de intentos
  runtime/       importado por el flowgraph generado: sinks y widgets web
  static/        frontend sin dependencias externas (editor, ventana de ejecución, WebGL)
```

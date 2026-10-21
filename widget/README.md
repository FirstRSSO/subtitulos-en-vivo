# Traductor de Audios — widget de escritorio

[![Electron](https://img.shields.io/badge/Electron-44-47848f?logo=electron&logoColor=white)](package.json)
[![Windows](https://img.shields.io/badge/Windows-loopback%20de%20audio-0078d4?logo=windows&logoColor=white)](#audio-de-un-solo-programa)
[![Kaggle](https://img.shields.io/badge/Arranque-autom%C3%A1tico%20en%20Kaggle-20beff?logo=kaggle&logoColor=white)](#arranque-automático-sin-abrir-kaggle)

Ventana flotante que traduce el audio **del sistema** o de **un programa
concreto** y lo muestra como subtítulos, por encima de cualquier aplicación
(incluso a pantalla completa).

La extensión de Chrome, en la raíz del proyecto, solo oye la pestaña activa.
Este widget oye lo que sale por los altavoces.

## Arrancar

Hace falta [Node.js](https://nodejs.org/) y el backend de transcripción
(`backend/colab_whisper_ws.ipynb` en Colab o Kaggle, con GPU).

```bash
cd widget
npm install     # solo la primera vez
npm start
```

En Windows también vale `iniciar.bat`.

1. En el notebook, ejecuta las celdas y copia la URL del túnel de Cloudflare.
2. En el widget, **⚙ Ajustes → Pegar** (añade `/transcribe` si falta).
3. Elige el idioma de destino y pulsa **Escuchar**.

Posición, tamaño, URL y ajustes se guardan en
`%APPDATA%/traductor-audios-widget/config.json`.

## La ventana

| Qué quieres | Cómo |
|---|---|
| Mover | Arrastra la zona vacía de la barra (en modo compacto, la franja superior de la barra de letras). |
| Cambiar el tamaño | Esquinas y bordes. Las esquinas llevan un ángulo claro; la inferior derecha es la más cómoda. |
| Solo la barra de letras | Botón **▬**, `Ctrl+Shift+B`, o doble clic en el texto. |
| Volver a los controles | Pasa el ratón por la barra de letras y pulsa **☰**, o otra vez `Ctrl+Shift+B` / doble clic. |
| Que los clics atraviesen el widget | Botón **◉** (modo fantasma). Pasa el ratón por la barra para recuperar los botones. |
| Ocultar por completo | `Ctrl+Shift+H` |

El modo compacto, el tamaño de la barra de letras y el de la ventana con
controles se recuerdan al cerrar.

## Controles

| Elemento | Qué hace |
|---|---|
| **Escuchar** | Inicia o detiene la captura (`Ctrl+Shift+T` desde cualquier aplicación). |
| Medidor | Nivel de audio que está entrando. |
| **Audio del sistema / Dispositivo** | Origen: mezcla de Windows, o un micro / cable virtual. |
| ⚙ | Ajustes: URL del backend, idioma, letra, opacidad, cortes de audio. |
| **log** | Registro de eventos. Se pone en rojo si hay un error nuevo. |
| ▬ | Solo subtítulos. |
| ◉ | Modo fantasma. |
| – / × | Minimizar / cerrar. |

### Atajos (funcionan aunque el widget no tenga el foco)

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+T` | Escuchar / detener |
| `Ctrl+Shift+B` | Solo subtítulos / controles |
| `Ctrl+Shift+H` | Ocultar / mostrar la ventana |

## Audio de un solo programa

Windows 10 no deja capturar el audio de un proceso aislado. El truco es un
dispositivo virtual:

1. Instala [VB-CABLE](https://vb-audio.com/Cable/) (gratuito) y reinicia.
2. *Configuración → Sistema → Sonido → Preferencias de volumen y dispositivos
   de aplicaciones*.
3. En el programa que quieres traducir, pon la **salida** en
   `CABLE Input (VB-Audio Virtual Cable)`.
4. En el widget: fuente **Dispositivo concreto** → `CABLE Output`.
5. Marca **Oír el audio por los altavoces** en los ajustes si quieres seguir
   escuchándolo mientras se traduce.

Así el widget no se come notificaciones ni música de fondo, y Whisper transcribe
más limpio que con la mezcla completa del sistema.

## Ajustes de transcripción

- **Traducir a** — idioma de los subtítulos. Se puede cambiar con la captura en
  marcha.
- **Tamaño de letra / opacidad** — solo afectan a la barra de subtítulos.
- **Fragmento mínimo / máximo** — no se corta el audio cada N segundos fijos.
  Se cierra en la primera pausa del habla dentro de esa horquilla, para no
  partir palabras.
- **Umbral de silencio** — por debajo de ese nivel no hay voz. Súbelo si se
  envían ruidos de fondo; bájalo si se pierden diálogos suaves.
- **Backend** — URL `/transcribe` del túnel. **Pegar** toma lo del portapapeles
  y completa la ruta. Cuando Cloudflare cambia de dominio, copia el enlace
  nuevo y pulsa ahí, sin reiniciar la captura.

## Backend

El notebook es `backend/colab_whisper_ws.ipynb` (el código está en
`backend/whisper_ws/`). GPU recomendada: **T4 o mejor**. En Kaggle, la Tesla P100 funciona
pero en `int8` (no admite `float16`).

Al pulsar **Escuchar** el widget abre un WebSocket (`wss://…/ws`) y manda cada
fragmento por esa conexión. Si el túnel no soporta WS, cae a HTTP `/transcribe`
y reintenta el WebSocket solo.

El estado enseña el transporte y la latencia: `Escuchando (ws · 800 ms)` o
`Escuchando (http)`.

Si la GPU se atrasara, el backend tira los fragmentos viejos y el widget avisa
`Backend saturado`, para que el subtítulo siga en vivo y no acumule retraso.

## Arranque automático (sin abrir Kaggle)

Configurado esto, al pulsar **Escuchar** el widget comprueba si el backend
responde; si no, lanza el notebook en Kaggle por API, espera a que publique su
URL en un gist y conecta solo. Tarda 1-3 min la primera vez de cada sesión.
Al cerrar el widget manda `POST /shutdown` y el notebook termina; si se queda
sin clientes 10 minutos, se apaga él solo. Todo gratis: Kaggle (30 h de GPU a
la semana) y GitHub (un gist y un token).

Se configura una vez, en **⚙ Ajustes → Arranque automático del backend**:

1. **Gist.** En [gist.github.com](https://gist.github.com) crea un gist
   *secreto* con un archivo `whisper_ws.json` y contenido `{}`. Copia su URL
   (`https://gist.github.com/usuario/1234abcd…`) en el campo *Gist*.
2. **Token de GitHub** para que el notebook pueda escribir en ese gist:
   GitHub → *Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate*. Permiso *Account permissions → Gists:
   Read and write*, nada más. Pégalo en *Token de GitHub*.
3. **Dataset de caché** en Kaggle (opcional pero recomendado, ver el README
   principal): sin él cada arranque tarda 5-6 min en vez de 1-2.
4. **Token de Kaggle:** [kaggle.com/settings/api](https://www.kaggle.com/settings/api)
   → *Generate New Token*. Pégalo en *Token de Kaggle* y escribe tu usuario
   en *Usuario de Kaggle*. *Nombre del notebook* es el slug del notebook de
   Kaggle que se lanzará (se crea si no existe); por defecto el de
   `backend/kernel-metadata.json`.
5. Pulsa **Escuchar**. El widget sube el notebook del repo a Kaggle con una
   celda inicial que lleva el token de GitHub y el id del gist como variables
   de entorno (los *Secrets* de Kaggle no se adjuntan a las versiones lanzadas
   por API), lo ejecuta y espera a que publique su URL.

Si ejecutas el notebook a mano en Kaggle, en vez de esa celda puedes usar
*Add-ons → Secrets* con `GITHUB_TOKEN` y `GIST_ID`; el código acepta ambas vías.

Los tokens se guardan en `config.json` de tu usuario de Windows y, el de
GitHub, también dentro de las versiones del notebook en Kaggle (que es
privado). Si uno se filtra, revócalo en la misma página donde lo creaste; el de
GitHub solo puede tocar gists.

El mismo lanzamiento se puede hacer desde la terminal, con el CLI oficial:

```bash
kaggle kernels push -p backend          # lanza; la URL aparece en el gist
kaggle kernels status usuario/whisper-ws-cache2
```

Si el arranque falla, el botón **log** dice en qué paso: `Fallo al lanzar el
notebook` (token o usuario mal, o el dataset no existe en tu cuenta), `No se
pudo leer el gist` (URL del gist mal) o `Tiempo de arranque agotado` (abre el
notebook en kaggle.com y mira su log; suele ser cuota de GPU agotada o Secrets
sin adjuntar).

## Si algo falla: botón **log**

Un texto grande que diga «Error 500» en los subtítulos **no es** un fallo HTTP:
Whisper a veces inventa frases. Si lo que falla es el traductor de Google, el
subtítulo sale en el idioma original y el registro dice `Traducción falló; se
usa el original` con el motivo (por ejemplo `gtx: HTTP 429`). El registro
distingue las dos cosas.

El botón **log** se pone rojo con errores nuevos. Cada línea lleva origen:

| Origen | Qué es |
|---|---|
| **servidor** | El notebook contestó. HTTP 500 o `WS error` traen el detalle de Whisper/CUDA. |
| **túnel** | Cloudflare por el notebook: 502, 504, 530… Kernel dormido o túnel caducado. |
| **red** | No hubo respuesta. Sin internet, DNS, o WS cerrado sucio (código 1006). |
| **widget** | Fallo local: captura, URL mal pegada, MediaRecorder. |

Al arrancar y al pulsar Escuchar se llama a `GET /health`. Si eso ya falla, el
problema es de conexión o del notebook, no de un fragmento.

**Copiar** manda el registro al portapapeles. **Archivo** abre `widget.log` en
la misma carpeta que `config.json`.

## Archivos

```
main.js              ventana, loopback, atajos, config, redimensionado, API de Kaggle
preload.js           puente entre la interfaz y el proceso principal
iniciar.bat          arranque en Windows
renderer/index.html  interfaz
renderer/styles.css  estilos
renderer/renderer.js captura, envío al backend, arranque automático, subtítulos, registro
```

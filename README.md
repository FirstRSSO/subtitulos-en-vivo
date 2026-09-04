# Traductor de Audios

Subtítulos en vivo del audio que estás oyendo, traducidos. Un mismo backend
(Whisper en Colab o Kaggle) alimenta dos clientes:

| Cliente | Qué oye | Dónde se ve |
|---|---|---|
| **Extensión de Chrome** (esta carpeta) | La pestaña activa | Encima de la página |
| **Widget de escritorio** ([`widget/`](widget/README.md)) | Todo el sistema, o un programa concreto | Ventana flotante siempre visible |

## Backend (obligatorio)

Notebook: [`backend/colab_whisper_ws.ipynb`](backend/colab_whisper_ws.ipynb)
(el `.py` tiene las mismas celdas).

1. Ábrelo en **Google Colab** o **Kaggle**, con GPU.
2. Ejecuta las celdas en orden (dependencias → modelo y servidor → túnel).
3. Copia la URL `https://….trycloudflare.com` que imprime el túnel.
4. Pégala en la extensión o en el widget. Si no lleva `/transcribe`, se añade sola.

GPU ideal: **T4 o mejor**. En Kaggle, la Tesla P100 vale, pero el modelo carga
en `int8` porque esa GPU no hace `float16` eficiente.

El servidor ofrece `POST /transcribe` (HTTP, extensión y respaldo) y
`GET /ws` (WebSocket, widget). `GET /health` confirma que el notebook sigue
vivo.

## Extensión de Chrome

En `chrome://extensions` activa *Modo desarrollador* → *Cargar descomprimida*
y apunta a **esta carpeta** (no a `widget/`).

El icono abre un popup:

| Campo | Para qué |
|---|---|
| **Backend de transcripción** | URL de `/transcribe` |
| **Pegar** | Toma la URL del portapapeles; completa `/transcribe` si falta |
| **Traducir a** | Idioma de destino |
| **Iniciar / Detener** | Captura de la pestaña activa |

URL e idioma se guardan en `chrome.storage.local` y se leen en cada envío: si
el túnel cambia de dominio, pegas la URL nueva y listo, sin recargar.

El manifest solo permite `localhost:8000` y `*.trycloudflare.com`. Si usas
otro host (ngrok, un dominio propio), la extensión pide permiso al guardar.

```
manifest.json    permisos y punto de entrada
config.js        valores por defecto y chrome.storage
popup.html/js    configuración y botón de inicio
background.js    orquesta captura, offscreen y subtítulos
offscreen.js     graba fragmentos y los manda al backend
content.js       caja de subtítulos en la página
```

## Widget de escritorio

Captura el audio de Windows (o de un programa vía VB-CABLE), se queda encima
de los juegos y se puede dejar en una barra de letras mínima. Guía completa:
[widget/README.md](widget/README.md).

```bash
cd widget
npm install     # solo la primera vez
npm start
```

# Traductor de Audios

Subtítulos en vivo del audio que estás oyendo, traducidos. Un mismo backend
(Whisper en Colab o Kaggle) alimenta dos clientes:

| Cliente | Qué oye | Dónde se ve |
|---|---|---|
| **Extensión de Chrome** (esta carpeta) | La pestaña activa | Encima de la página |
| **Widget de escritorio** ([`widget/`](widget/README.md)) | Todo el sistema, o un programa concreto | Ventana flotante siempre visible |

## Backend (obligatorio)

Notebook: [`backend/colab_whisper_ws.ipynb`](backend/colab_whisper_ws.ipynb).
El código del servidor vive en el paquete [`backend/whisper_ws/`](backend/whisper_ws/);
el notebook solo lo clona y lo llama.

1. Ábrelo en **Google Colab** o **Kaggle**, con GPU.
2. Ejecuta las celdas en orden (código y dependencias → modelo y servidor → túnel).
3. Copia la URL `https://….trycloudflare.com` que imprime el túnel.
4. Pégala en la extensión o en el widget. Si no lleva `/transcribe`, se añade sola.

GPU ideal: **T4 o mejor**. En Kaggle, la Tesla P100 vale, pero el modelo carga
en `int8` porque esa GPU no hace `float16` eficiente.

### Arranque rápido en Kaggle (opcional)

Sin más, cada sesión descarga las dependencias y el modelo (~1,6 GB): unos
3-6 minutos. Con una caché en un Kaggle Dataset se queda en menos de un minuto.
Se genera una vez desde tu PC:

```bash
pip install huggingface_hub kaggle
python backend/build_cache.py --kaggle-user TU_USUARIO   # ./whisper_ws_cache (~1,8 GB)
kaggle datasets create -p whisper_ws_cache --dir-mode zip
```

(O súbela desde la web: Datasets → New Dataset.) En el notebook, *Add Input* →
*Datasets* → `whisper-ws-cache`. La celda 1 la detecta sola en `/kaggle/input`.
En Colab vale la misma carpeta en Drive (`MyDrive/whisper_ws_cache`), montando
Drive antes; ahí conviene generarla con `--cuda-libs`, porque Colab suele traer
un cuDNN que CTranslate2 no acepta. Si Kaggle cambia de versión de Python,
regenera la caché con `--python X.Y`.

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

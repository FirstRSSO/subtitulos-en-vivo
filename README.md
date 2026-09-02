# Traductor de Audios

Dos formas de usar el mismo backend de transcripción:

- **Extensión de Chrome** (raíz del proyecto): subtítulos sobre la propia página,
  captura el audio de la pestaña activa.
- **Widget de escritorio** (`widget/`): captura el audio de todo el sistema o de
  un programa concreto, en una ventana flotante siempre visible.
  Ver [widget/README.md](widget/README.md).

## Extensión de Chrome

Cargar en `chrome://extensions` → *Modo desarrollador* → *Cargar descomprimida*
apuntando a la raíz del proyecto.

Al pulsar el icono se abre un popup con:

| Campo | Para qué |
|---|---|
| **Backend de transcripción** | URL del endpoint `/transcribe` |
| **Pegar** | Toma la URL del portapapeles; si le falta `/transcribe`, se añade sola |
| **Traducir a** | Idioma de destino |
| **Iniciar / Detener traducción** | Arranca o para la captura de la pestaña activa |

La URL y el idioma se guardan en `chrome.storage.local` y se leen en **cada
envío**: cuando el túnel de Cloudflare cambia de dominio basta con pegar la
nueva URL en el popup, sin reiniciar la captura ni tocar ningún archivo.

El manifest sólo declara permiso para `localhost:8000` y `*.trycloudflare.com`.
Si pegas la URL de otro servicio (ngrok, un dominio propio), la extensión pide
permiso para ese dominio en el momento de guardar.

### Archivos

```
manifest.json    permisos y punto de entrada
config.js        valores por defecto y acceso a chrome.storage (compartido)
popup.html/js    interfaz de configuración y botón de inicio
background.js    service worker: orquesta captura, offscreen y subtítulos
offscreen.js     graba fragmentos de audio y los envía al backend
content.js       dibuja la caja de subtítulos en la página
```

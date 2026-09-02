# Traductor de Audios — widget de escritorio

Versión de escritorio del proyecto. A diferencia de la extensión de Chrome
(que sólo oye pestañas del navegador), este widget captura **el audio de todo
el sistema** o el de **un dispositivo concreto**, y muestra la traducción en
una ventana flotante que se mantiene por encima de cualquier programa.

## Arrancar

```bash
cd widget
npm install     # sólo la primera vez
npm start
```

## Controles

| Elemento | Qué hace |
|---|---|
| **Escuchar** | Inicia o detiene la captura (`Ctrl+Shift+T` desde cualquier aplicación) |
| **Audio del sistema / Dispositivo** | Origen del audio |
| ⚙ | Panel de ajustes |
| ◉ | Modo fantasma: los clics atraviesan el widget (pasa el ratón por la barra para recuperarlo) |
| `Ctrl+Shift+H` | Ocultar / mostrar el widget |

La ventana se arrastra por la zona vacía de la barra y se redimensiona por los
bordes. Posición, tamaño y ajustes se guardan en `%APPDATA%/traductor-audios-widget/config.json`.

## Traducir un programa concreto

Windows sólo permite capturar el audio de un proceso aislado a partir de la
build 20348 (Windows 11). En Windows 10 se consigue el mismo resultado
enrutando esa aplicación a un dispositivo virtual:

1. Instala [VB-CABLE](https://vb-audio.com/Cable/) (gratuito) y reinicia.
2. Abre *Configuración › Sistema › Sonido › **Preferencias de volumen y
   dispositivos de aplicaciones***.
3. Busca el programa que quieres traducir y cambia su **Salida** a
   `CABLE Input (VB-Audio Virtual Cable)`.
4. En el widget: fuente **Dispositivo concreto** → `CABLE Output (VB-Audio Virtual Cable)`.
5. Marca **Oír el audio por los altavoces** en los ajustes si quieres seguir
   escuchando ese programa mientras se traduce.

Ventaja añadida: el widget recibe únicamente ese audio, sin notificaciones ni
música de fondo, así que la transcripción sale bastante más limpia que con la
mezcla completa del sistema.

## Ajustes de la transcripción

- **Fragmento mínimo / máximo**: el audio no se corta cada N segundos fijos —
  se cierra en la primera pausa del habla dentro de esa horquilla, para no
  partir palabras por la mitad.
- **Umbral de silencio**: nivel por debajo del cual se considera que no hay
  voz. Los fragmentos completamente mudos no se envían al backend. Súbelo si
  se disparan envíos con ruido de fondo; bájalo si se pierden diálogos suaves.
- **Backend**: la misma URL `/transcribe` que usa la extensión. El botón
  **Pegar** toma la URL del portapapeles y le añade `/transcribe` si le falta,
  así que cuando el túnel de Cloudflare cambia de dominio basta con copiar el
  enlace nuevo y pulsar ahí.

## Cómo habla con el backend

El backend recomendado es `backend/colab_whisper_ws.ipynb` (o el `.py` con
las mismas celdas), pensado para este widget:

1. Al pulsar **Escuchar** el widget deriva `wss://<dominio>/ws` de la URL
   guardada y abre **un WebSocket** que dura toda la sesión. Manda
   `{"type":"config","target_lang":"es"}` y luego cada fragmento (webm/opus)
   como mensaje binario. El backend responde en orden con
   `{"type":"result","text","translation","total_ms",...}`.
   El estado muestra `Escuchando (ws · N ms)` con la latencia de cada fragmento.
2. Si el WebSocket no está disponible (backend antiguo, túnel caído), cada
   fragmento se envía por HTTP a `/transcribe` con `file` y `target_lang` en
   `multipart/form-data`, como antes. El estado muestra `Escuchando (http)` y
   el widget sigue intentando reabrir el WebSocket con espera creciente.
3. Cambiar el idioma o la URL con la captura en marcha se aplica al momento,
   sin parar de escuchar.

Ventajas del WebSocket frente a HTTP por fragmento: sin handshake TCP+TLS por
el túnel en cada envío, la subida del fragmento siguiente se solapa con la
transcripción del actual, el backend fija el idioma detectado tras dos
fragmentos seguros (deja de detectarlo y ya no "cambia" de idioma en frases
cortas) y usa el texto anterior como contexto para nombres y puntuación.
Si la GPU se retrasa, el backend descarta los fragmentos más antiguos y avisa
con `Backend saturado` para que el subtítulo siga en vivo.

## Estructura

```
main.js              proceso principal: ventana, loopback de audio, atajos, config
preload.js           puente seguro entre el renderer y el proceso principal
renderer/index.html  interfaz del widget
renderer/styles.css  estilos
renderer/renderer.js captura, detección de pausas, envío al backend y subtítulos
```

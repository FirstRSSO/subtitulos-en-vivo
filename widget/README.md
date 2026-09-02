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
  enlace nuevo y pulsar ahí. El widget envía `file` (webm/opus) y `target_lang`
  en un `multipart/form-data`, y espera
  `{ success, segments: [{ text, translations }] }`.

## Estructura

```
main.js              proceso principal: ventana, loopback de audio, atajos, config
preload.js           puente seguro entre el renderer y el proceso principal
renderer/index.html  interfaz del widget
renderer/styles.css  estilos
renderer/renderer.js captura, detección de pausas, envío al backend y subtítulos
```

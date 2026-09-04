const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  leerConfig: () => ipcRenderer.invoke('config:leer'),
  guardarConfig: (parcial) => ipcRenderer.invoke('config:guardar', parcial),
  setClickThrough: (activo, persistir) => ipcRenderer.invoke('ventana:clickThrough', activo, persistir),
  leerPortapapeles: () => ipcRenderer.invoke('portapapeles:leer'),
  escribirPortapapeles: (texto) => ipcRenderer.invoke('portapapeles:escribir', texto),
  setAlto: (alto, persistir = false) => ipcRenderer.invoke('ventana:alto', alto, persistir),
  setMinimos: (compacto) => ipcRenderer.invoke('ventana:minimos', compacto),
  iniciarResize: (edge) => ipcRenderer.send('ventana:resize-inicio', edge),
  finResize: () => ipcRenderer.send('ventana:resize-fin'),
  minimizar: () => ipcRenderer.send('ventana:minimizar'),
  cerrar: () => ipcRenderer.send('ventana:cerrar'),
  appendLog: (linea) => ipcRenderer.invoke('log:append', linea),
  rutaLog: () => ipcRenderer.invoke('log:ruta'),
  vaciarLog: () => ipcRenderer.invoke('log:vaciar'),
  abrirLog: () => ipcRenderer.invoke('log:abrir'),
  onAtajo: (callback) => ipcRenderer.on('atajo', (_evento, nombre) => callback(nombre))
});

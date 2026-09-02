const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  leerConfig: () => ipcRenderer.invoke('config:leer'),
  guardarConfig: (parcial) => ipcRenderer.invoke('config:guardar', parcial),
  setClickThrough: (activo, persistir) => ipcRenderer.invoke('ventana:clickThrough', activo, persistir),
  leerPortapapeles: () => ipcRenderer.invoke('portapapeles:leer'),
  setAlto: (alto) => ipcRenderer.invoke('ventana:alto', alto),
  minimizar: () => ipcRenderer.send('ventana:minimizar'),
  cerrar: () => ipcRenderer.send('ventana:cerrar'),
  onAtajo: (callback) => ipcRenderer.on('atajo', (_evento, nombre) => callback(nombre))
});

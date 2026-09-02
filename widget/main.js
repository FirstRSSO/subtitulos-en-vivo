const {
  app, BrowserWindow, session, desktopCapturer,
  ipcMain, screen, globalShortcut, shell, clipboard
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULTS = {
  apiUrl: 'https://trainers-refers-animation-simplified.trycloudflare.com/transcribe',
  targetLang: 'en',
  fuente: 'loopback',        // 'loopback' = audio del sistema | 'device' = dispositivo concreto
  deviceId: '',
  monitorizar: false,        // devolver el audio a los altavoces (solo modo dispositivo)
  minChunkMs: 3000,          // no cortar antes de esto
  maxChunkMs: 9000,          // cortar sí o sí al llegar aquí
  silencioMs: 450,           // silencio sostenido que dispara el corte
  umbralSilencio: 0.012,     // RMS por debajo del cual se considera silencio
  fontSize: 24,
  opacidad: 0.85,
  clickThrough: false,
  bounds: null
};

let win = null;
let config = { ...DEFAULTS };
let ajustandoPanel = false;

const rutaConfig = () => path.join(app.getPath('userData'), 'config.json');

function cargarConfig() {
  try {
    const guardada = JSON.parse(fs.readFileSync(rutaConfig(), 'utf8'));
    config = { ...DEFAULTS, ...guardada };
  } catch {
    config = { ...DEFAULTS };   // primera ejecución o fichero corrupto
  }
  return config;
}

function guardarConfig(parcial) {
  config = { ...config, ...parcial };
  try {
    fs.writeFileSync(rutaConfig(), JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    console.error('[widget] no se pudo guardar la configuración:', error.message);
  }
  return config;
}

function posicionInicial() {
  const { workArea } = screen.getPrimaryDisplay();
  const ancho = Math.min(920, workArea.width - 80);
  const alto = 210;
  return {
    width: ancho,
    height: alto,
    x: workArea.x + Math.round((workArea.width - ancho) / 2),
    y: workArea.y + workArea.height - alto - 60
  };
}

function crearVentana() {
  const bounds = config.bounds ?? posicionInicial();

  win = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 140,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: false,
    title: 'Traductor de Audios',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 'screen-saver' es el nivel que mantiene la ventana por encima incluso de
  // aplicaciones a pantalla completa, que es justo el caso de uso del widget.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const recordarBounds = () => {
    // El crecimiento temporal por el panel de ajustes no debe quedar guardado
    // como tamaño preferido del widget.
    if (ajustandoPanel) return;
    if (win && !win.isDestroyed()) guardarConfig({ bounds: win.getBounds() });
  };
  win.on('moved', recordarBounds);
  win.on('resized', recordarBounds);

  // Los enlaces externos (guía de VB-CABLE) van al navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function configurarCaptura() {
  const ses = session.defaultSession;

  // Esto es lo que sustituye a chrome.tabCapture: `audio: 'loopback'` entrega
  // la mezcla de salida del sistema completo, sin diálogo de selección.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const fuentes = await desktopCapturer.getSources({ types: ['screen'] });
      if (!fuentes.length) return callback({});
      callback({ video: fuentes[0], audio: 'loopback' });
    } catch (error) {
      console.error('[widget] error obteniendo la fuente de pantalla:', error);
      callback({});
    }
  }, { useSystemPicker: false });

  // Sin esto, enumerateDevices() no devuelve las etiquetas de los dispositivos
  // y el desplegable saldría con nombres vacíos.
  ses.setPermissionRequestHandler((webContents, permiso, callback) => {
    callback(permiso === 'media' || permiso === 'audioCapture');
  });
  ses.setPermissionCheckHandler((webContents, permiso) => {
    return permiso === 'media' || permiso === 'audioCapture';
  });
}

function registrarAtajos() {
  const atajos = {
    'CommandOrControl+Shift+T': () => win?.webContents.send('atajo', 'toggle'),
    'CommandOrControl+Shift+H': () => {
      if (!win) return;
      win.isVisible() ? win.hide() : win.show();
    }
  };

  for (const [combinacion, accion] of Object.entries(atajos)) {
    if (!globalShortcut.register(combinacion, accion)) {
      console.warn(`[widget] atajo ocupado por otra aplicación: ${combinacion}`);
    }
  }
}

app.whenReady().then(() => {
  cargarConfig();
  configurarCaptura();
  crearVentana();
  registrarAtajos();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

ipcMain.handle('config:leer', () => config);
ipcMain.handle('config:guardar', (_evento, parcial) => guardarConfig(parcial));

ipcMain.handle('ventana:clickThrough', (_evento, activo, persistir = true) => {
  if (!win) return false;
  // `forward: true` deja que la ventana siga recibiendo el movimiento del ratón,
  // así el renderer puede desactivar el modo al pasar por encima de la barra.
  // Ese vaivén es constante, por eso solo se guarda cuando lo pide el usuario.
  win.setIgnoreMouseEvents(Boolean(activo), { forward: true });
  if (persistir) guardarConfig({ clickThrough: Boolean(activo) });
  return Boolean(activo);
});

// El preload se ejecuta en sandbox y no puede importar `clipboard`, así que
// la lectura se hace aquí y viaja por IPC.
ipcMain.handle('portapapeles:leer', () => clipboard.readText());

// El panel de ajustes no cabe en la altura normal del widget: al abrirlo la
// ventana crece hacia arriba y al cerrarlo recupera su tamaño.
ipcMain.handle('ventana:alto', (_evento, alto) => {
  if (!win || win.isDestroyed()) return;

  const actual = win.getBounds();
  const { workArea } = screen.getDisplayMatching(actual);
  const nuevoAlto = Math.round(Math.min(alto, workArea.height - 40));
  // Mantener el borde inferior fijo hace que el panel se despliegue hacia
  // arriba, sin que el widget se salga por debajo de la pantalla.
  const inferior = actual.y + actual.height;
  const y = Math.max(workArea.y, Math.min(inferior - nuevoAlto, workArea.y + workArea.height - nuevoAlto));

  ajustandoPanel = true;
  win.setBounds({ x: actual.x, y, width: actual.width, height: nuevoAlto });
  ajustandoPanel = false;
});

ipcMain.on('ventana:minimizar', () => win?.minimize());
ipcMain.on('ventana:cerrar', () => app.quit());

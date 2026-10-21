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
  compacto: false,           // solo la barra de subtítulos
  altoOpciones: 210,         // altura al volver a mostrar controles
  altoCompacto: 0,           // altura de la barra de letras si el usuario la estiró
  bounds: null,
  // Arranque automático del backend en Kaggle (ver README, "Arranque automático").
  gistUrl: '',               // https://gist.github.com/usuario/id — el notebook publica ahí su URL
  kaggleToken: '',           // KGAT_… de kaggle.com/settings/api
  githubToken: '',           // fine-grained con permiso Gists: read and write (lo usa el notebook)
  kaggleUser: '',            // usuario de Kaggle (dueño del notebook y del dataset)
  kaggleKernel: 'whisper-ws-cache2', // slug del notebook (id de kernel-metadata.json)
  apagarAlCerrar: true       // POST /shutdown al cerrar el widget para no gastar GPU
};

// El notebook y su metadata se leen del repo en cada lanzamiento: así el widget
// siempre ejecuta la última versión sin tener que actualizarse.
const REPO_RAW = 'https://raw.githubusercontent.com/FirstRSSO/subtitulos-en-vivo/main/backend';
const KAGGLE_API = 'https://api.kaggle.com/v1/kernels.KernelsApiService';

const MIN_COMPLETO = { width: 420, height: 140 };
const MIN_COMPACTO = { width: 240, height: 52 };

let win = null;
let config = { ...DEFAULTS };
let ajustandoPanel = false;
let resizeEstado = null;
let resizeTimer = null;

const rutaConfig = () => path.join(app.getPath('userData'), 'config.json');
const rutaLog = () => path.join(app.getPath('userData'), 'widget.log');
const LOG_MAX_BYTES = 1_500_000;

function appendLog(linea) {
  const archivo = rutaLog();
  try {
    if (fs.existsSync(archivo) && fs.statSync(archivo).size > LOG_MAX_BYTES) {
      const cola = fs.readFileSync(archivo, 'utf8').slice(-Math.floor(LOG_MAX_BYTES / 2));
      fs.writeFileSync(archivo, cola, 'utf8');
    }
    fs.appendFileSync(archivo, `${linea}\n`, 'utf8');
  } catch (error) {
    console.error('[widget] no se pudo escribir el log:', error.message);
  }
}

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

function aplicarMinimos(compacto) {
  if (!win || win.isDestroyed()) return;
  const m = compacto ? MIN_COMPACTO : MIN_COMPLETO;
  win.setMinimumSize(m.width, m.height);
}

function crearVentana() {
  const bounds = config.bounds ?? posicionInicial();
  const min = config.compacto ? MIN_COMPACTO : MIN_COMPLETO;

  win = new BrowserWindow({
    ...bounds,
    minWidth: min.width,
    minHeight: min.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
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
    if (ajustandoPanel || resizeEstado) return;
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const extra = config.compacto
      ? { altoCompacto: bounds.height }
      : { altoOpciones: bounds.height };
    guardarConfig({ bounds, ...extra });
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
    },
    'CommandOrControl+Shift+B': () => win?.webContents.send('atajo', 'compacto')
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

// Al cerrar, avisar al backend para que termine el notebook y no consuma cuota.
// before-quit es síncrono: se cancela la salida, se manda el POST (con tope de
// 3 s) y se vuelve a salir con la bandera puesta.
let apagadoPedido = false;
app.on('before-quit', (evento) => {
  if (apagadoPedido || !config.apagarAlCerrar || !config.kaggleToken) return;
  apagadoPedido = true;
  const url = urlShutdown(config.apiUrl);
  if (!url) return;
  evento.preventDefault();
  const fin = () => app.quit();
  fetch(url, { method: 'POST', signal: AbortSignal.timeout(3000) })
    .then(() => appendLog(`${new Date().toISOString()} info widget POST /shutdown enviado`))
    .catch((e) => appendLog(`${new Date().toISOString()} error widget POST /shutdown: ${e.message}`))
    .finally(fin);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (resizeTimer) clearInterval(resizeTimer);
});

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
ipcMain.handle('portapapeles:escribir', (_evento, texto) => {
  clipboard.writeText(String(texto ?? ''));
});

ipcMain.handle('log:append', (_evento, linea) => { appendLog(String(linea ?? '')); });
ipcMain.handle('log:ruta', () => rutaLog());
ipcMain.handle('log:vaciar', () => {
  try { fs.writeFileSync(rutaLog(), '', 'utf8'); } catch { /* disco lleno o sin permiso */ }
});
ipcMain.handle('log:abrir', () => {
  const archivo = rutaLog();
  if (!fs.existsSync(archivo)) fs.writeFileSync(archivo, '', 'utf8');
  shell.showItemInFolder(archivo);
});

// El panel de ajustes no cabe en la altura normal del widget: al abrirlo la
// ventana crece hacia arriba y al cerrarlo recupera su tamaño.
ipcMain.handle('ventana:alto', (_evento, alto, persistir = false) => {
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
  if (persistir) {
    const bounds = win.getBounds();
    const extra = config.compacto
      ? { altoCompacto: bounds.height }
      : { altoOpciones: bounds.height };
    guardarConfig({ bounds, ...extra });
  }
});

ipcMain.handle('ventana:minimos', (_evento, compacto) => {
  aplicarMinimos(Boolean(compacto));
});

// La ventana es transparente y sin marco: Windows no entrega asas nativas.
// El renderer manda el borde (n/s/e/w/ne/…) y aquí seguimos el cursor.
ipcMain.on('ventana:resize-inicio', (_evento, edge) => {
  if (!win || win.isDestroyed()) return;
  const [minW, minH] = win.getMinimumSize();
  resizeEstado = {
    edge: String(edge || ''),
    cursor: screen.getCursorScreenPoint(),
    bounds: win.getBounds(),
    minW,
    minH
  };
  if (resizeTimer) clearInterval(resizeTimer);
  resizeTimer = setInterval(() => {
    if (!resizeEstado || !win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - resizeEstado.cursor.x;
    const dy = cursor.y - resizeEstado.cursor.y;
    const { edge, bounds, minW, minH } = resizeEstado;
    let { x, y, width, height } = bounds;
    if (edge.includes('e')) width = Math.max(minW, bounds.width + dx);
    if (edge.includes('s')) height = Math.max(minH, bounds.height + dy);
    if (edge.includes('w')) {
      width = Math.max(minW, bounds.width - dx);
      x = bounds.x + bounds.width - width;
    }
    if (edge.includes('n')) {
      height = Math.max(minH, bounds.height - dy);
      y = bounds.y + bounds.height - height;
    }
    win.setBounds({ x, y, width, height }, false);
  }, 16);
});

ipcMain.on('ventana:resize-fin', () => {
  if (resizeTimer) {
    clearInterval(resizeTimer);
    resizeTimer = null;
  }
  resizeEstado = null;
  if (win && !win.isDestroyed()) {
    const bounds = win.getBounds();
    const extra = config.compacto
      ? { altoCompacto: bounds.height }
      : { altoOpciones: bounds.height };
    guardarConfig({ bounds, ...extra });
  }
});

ipcMain.on('ventana:minimizar', () => win?.minimize());
ipcMain.on('ventana:cerrar', () => app.quit());

/* ------------------------- arranque automático en Kaggle ------------------------- */

function gistId(texto) {
  const m = String(texto || '').trim().match(/([0-9a-f]{20,})\/?$/i);
  return m ? m[1] : '';
}

function urlShutdown(apiUrl) {
  try {
    const url = new URL(apiUrl);
    url.pathname = `${url.pathname.replace(/\/transcribe\/?$/, '').replace(/\/+$/, '')}/shutdown`;
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

// Misma llamada RPC que hace el CLI oficial (`kaggle kernels push` / `status`):
// POST JSON a api.kaggle.com con el token de kaggle.com/settings/api como Bearer.
async function kaggleRpc(metodo, cuerpo) {
  const r = await fetch(`${KAGGLE_API}/${metodo}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.kaggleToken}`
    },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(30000)
  });
  const texto = await r.text();
  let json = {};
  try { json = JSON.parse(texto); } catch { /* no JSON */ }
  if (!r.ok) {
    const msg = json?.error?.message || json?.message || texto.slice(0, 200);
    const err = new Error(`Kaggle ${metodo} → ${r.status}: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

// Estado de la última ejecución: QUEUED | RUNNING | COMPLETE | ERROR | … | null (nunca ejecutado)
ipcMain.handle('kaggle:estado', async () => {
  if (!config.kaggleToken || !config.kaggleUser) throw new Error('Falta el token o el usuario de Kaggle');
  try {
    const r = await kaggleRpc('GetKernelSessionStatus', {
      userName: config.kaggleUser,
      kernelSlug: config.kaggleKernel
    });
    const estado = typeof r.status === 'string' ? r.status : String(r.status ?? '');
    return { estado, fallo: r.failureMessage || '' };
  } catch (e) {
    if (e.status === 404) return { estado: null, fallo: '' };
    throw e;
  }
});

// Equivale a `kaggle kernels push -p backend`: sube el notebook del repo y lo
// ejecuta con GPU, internet y el dataset de caché que indica kernel-metadata.json.
ipcMain.handle('kaggle:lanzar', async () => {
  if (!config.kaggleToken || !config.kaggleUser) throw new Error('Falta el token o el usuario de Kaggle');
  const [meta, nb] = await Promise.all([
    fetch(`${REPO_RAW}/kernel-metadata.json`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
    fetch(`${REPO_RAW}/colab_whisper_ws.ipynb`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json())
  ]);
  // El servidor espera el código de cada celda como una sola cadena y sin salidas.
  for (const celda of nb.cells ?? []) {
    if (Array.isArray(celda.source)) celda.source = celda.source.join('');
    if (celda.cell_type === 'code') { celda.outputs = []; celda.execution_count = null; }
  }
  // Los Secrets de Kaggle no se adjuntan a las versiones lanzadas por API, así
  // que el token del gist viaja como variables de entorno en una celda inicial.
  // Solo va en la copia que se sube (el notebook es privado); el repo queda limpio.
  const gist = gistId(config.gistUrl);
  if (config.githubToken && gist) {
    nb.cells.unshift({
      cell_type: 'code',
      metadata: {},
      outputs: [],
      execution_count: null,
      source: `import os\nos.environ["GITHUB_TOKEN"] = ${JSON.stringify(config.githubToken)}\nos.environ["GIST_ID"] = ${JSON.stringify(gist)}\n`
    });
  }
  const slug = `${config.kaggleUser}/${config.kaggleKernel}`;
  const datasets = (meta.dataset_sources ?? []).map((d) => d.replace(/^[^/]+\//, `${config.kaggleUser}/`));
  const r = await kaggleRpc('SaveKernel', {
    slug,
    newTitle: config.kaggleKernel,
    text: JSON.stringify(nb),
    language: 'python',
    kernelType: 'notebook',
    isPrivate: true,
    enableGpu: meta.enable_gpu !== false,
    enableInternet: true,
    machineShape: meta.machine_shape || 'NvidiaTeslaT4',
    datasetDataSources: datasets
  });
  if (r.error) throw new Error(`Kaggle: ${r.error}`);
  if (r.invalidDatasetSources?.length) throw new Error(`Dataset no encontrado: ${r.invalidDatasetSources.join(', ')}`);
  appendLog(`${new Date().toISOString()} info widget Notebook lanzado en Kaggle ${r.url || slug} v${r.versionNumber ?? '?'}`);
  return { url: r.url || `https://www.kaggle.com/code/${slug}`, version: r.versionNumber ?? null };
});

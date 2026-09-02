const $ = (id) => document.getElementById(id);

const ui = {
  btnEscuchar: $('btnEscuchar'), txtEscuchar: $('txtEscuchar'),
  selFuente: $('selFuente'), selDispositivo: $('selDispositivo'),
  estado: $('estado'), subtitulo: $('subtitulo'),
  medidor: $('medidorRelleno'), barra: $('barra'),
  ajustes: $('ajustes'), btnAjustes: $('btnAjustes'), btnFantasma: $('btnFantasma'),
  btnMin: $('btnMin'), btnCerrar: $('btnCerrar'),
  inpApi: $('inpApi'), btnPegar: $('btnPegar'), selIdioma: $('selIdioma'),
  inpFuente: $('inpFuente'), inpOpacidad: $('inpOpacidad'),
  inpMin: $('inpMin'), inpMax: $('inpMax'), inpUmbral: $('inpUmbral'),
  chkMonitor: $('chkMonitor'),
  valFuente: $('valFuente'), valOpacidad: $('valOpacidad'),
  valMin: $('valMin'), valMax: $('valMax'), valUmbral: $('valUmbral')
};

let cfg = {};
let fantasma = false;
let sobreLaBarra = true;

const captura = {
  activa: false,
  stream: null,
  audioCtx: null,
  analyser: null,
  buffer: null,
  recorder: null,
  vigilante: null,
  ocultarTimer: null
};

let cola = Promise.resolve();
let fallosSeguidos = 0;

/* ------------------------- estado e interfaz ------------------------- */

function setEstado(texto, tipo = '') {
  ui.estado.textContent = texto;
  ui.estado.className = `estado ${tipo}`;
}

function mostrarSubtitulo(texto) {
  ui.subtitulo.textContent = texto;
  ui.subtitulo.classList.remove('oculto');
  clearTimeout(captura.ocultarTimer);
  captura.ocultarTimer = setTimeout(() => {
    ui.subtitulo.classList.add('oculto');
    ui.subtitulo.textContent = 'Sin audio reciente';
  }, 8000);
}

function aplicarEstilos() {
  ui.subtitulo.style.fontSize = `${cfg.fontSize}px`;
  ui.subtitulo.style.background = `rgba(0, 0, 0, ${cfg.opacidad})`;
}

/* ------------------------- dispositivos ------------------------- */

async function enumerarDispositivos() {
  try {
    // Sin un getUserMedia previo, enumerateDevices() devuelve etiquetas vacías.
    const permiso = await navigator.mediaDevices.getUserMedia({ audio: true });
    permiso.getTracks().forEach((t) => t.stop());
  } catch {
    // El usuario puede haberlo denegado: seguimos, aunque sin nombres legibles.
  }

  const dispositivos = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput');

  ui.selDispositivo.innerHTML = '';
  if (!dispositivos.length) {
    ui.selDispositivo.append(new Option('No hay entradas de audio', ''));
    return;
  }

  for (const d of dispositivos) {
    const etiqueta = d.label || `Entrada ${d.deviceId.slice(0, 6)}`;
    ui.selDispositivo.append(new Option(etiqueta, d.deviceId));
  }

  const guardado = dispositivos.some((d) => d.deviceId === cfg.deviceId);
  ui.selDispositivo.value = guardado ? cfg.deviceId : dispositivos[0].deviceId;
  cfg.deviceId = ui.selDispositivo.value;
}

/* ------------------------- captura de audio ------------------------- */

async function obtenerStream() {
  if (cfg.fuente === 'loopback') {
    // El handler de main.js responde con audio: 'loopback' (mezcla del sistema).
    // Chromium exige pedir vídeo aunque solo queramos el audio.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    if (!stream.getAudioTracks().length) {
      throw new Error('Windows no entrego audio del sistema para esta captura');
    }
    return stream;
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: cfg.deviceId ? { exact: cfg.deviceId } : undefined,
      // Los tres filtros estan pensados para voz por microfono; sobre una
      // pista de audio ya mezclada solo degradan la transcripcion.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });
}

function nivelActual() {
  captura.analyser.getFloatTimeDomainData(captura.buffer);
  let suma = 0;
  for (const v of captura.buffer) suma += v * v;
  return Math.sqrt(suma / captura.buffer.length);
}

function tipoSoportado() {
  const candidatos = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidatos.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

async function iniciar() {
  try {
    setEstado('Conectando...');
    captura.stream = await obtenerStream();

    captura.audioCtx = new AudioContext();
    const origen = captura.audioCtx.createMediaStreamSource(captura.stream);
    captura.analyser = captura.audioCtx.createAnalyser();
    captura.analyser.fftSize = 2048;
    captura.buffer = new Float32Array(captura.analyser.fftSize);
    origen.connect(captura.analyser);

    // Nunca en modo loopback: reproducir lo capturado realimentaria la propia
    // captura del sistema y crearia un bucle de audio.
    if (cfg.monitorizar && cfg.fuente === 'device') {
      origen.connect(captura.audioCtx.destination);
    }

    // Si el usuario detiene la captura desde el panel de Windows.
    captura.stream.getAudioTracks()[0].addEventListener('ended', () => detener());

    captura.activa = true;
    ui.btnEscuchar.classList.add('activo');
    ui.txtEscuchar.textContent = 'Detener';
    ui.btnEscuchar.querySelector('.icono').innerHTML = '&#9632;';
    setEstado('Escuchando', 'ok');
    fallosSeguidos = 0;

    conectarWs();
    grabarFragmento();
  } catch (error) {
    console.error('[widget]', error);
    setEstado(`No se pudo iniciar: ${error.message}`, 'error');
    await detener();
  }
}

function grabarFragmento() {
  if (!captura.activa || !captura.stream?.active) return;

  const recorder = new MediaRecorder(captura.stream, { mimeType: tipoSoportado() });
  const trozos = [];
  let huboVoz = false;
  let silencioDesde = null;
  const inicio = performance.now();

  captura.recorder = recorder;
  recorder.ondataavailable = (e) => { if (e.data.size > 0) trozos.push(e.data); };

  recorder.onstop = () => {
    if (huboVoz && trozos.length) {
      enviarFragmento(new Blob(trozos, { type: recorder.mimeType }));
    }
    grabarFragmento();   // encadena el siguiente fragmento sin huecos
  };

  recorder.start();

  // En lugar de cortar cada N segundos exactos (lo que parte las palabras a la
  // mitad), cerramos el fragmento en la primera pausa real del habla.
  captura.vigilante = setInterval(() => {
    if (recorder.state !== 'recording') return;

    const nivel = nivelActual();
    ui.medidor.style.width = `${Math.min(100, nivel * 600)}%`;

    const ahora = performance.now();
    const transcurrido = ahora - inicio;

    if (nivel >= cfg.umbralSilencio) {
      huboVoz = true;
      silencioDesde = null;
    } else if (silencioDesde === null) {
      silencioDesde = ahora;
    }

    const enPausa = silencioDesde !== null && ahora - silencioDesde >= cfg.silencioMs;
    const cortarPorPausa = transcurrido >= cfg.minChunkMs && enPausa && huboVoz;
    const cortarPorLimite = transcurrido >= cfg.maxChunkMs;
    // Un fragmento mudo se recicla enseguida: no hay nada que transcribir.
    const soloSilencio = !huboVoz && transcurrido >= cfg.minChunkMs;

    if (cortarPorPausa || cortarPorLimite || soloSilencio) {
      clearInterval(captura.vigilante);
      captura.vigilante = null;
      recorder.stop();
    }
  }, 50);
}

async function detener() {
  captura.activa = false;
  cerrarWs();

  clearInterval(captura.vigilante);
  captura.vigilante = null;

  if (captura.recorder?.state === 'recording') {
    captura.recorder.onstop = null;   // evita que se reencadene otro fragmento
    captura.recorder.stop();
  }
  captura.recorder = null;

  captura.stream?.getTracks().forEach((t) => t.stop());
  captura.stream = null;

  if (captura.audioCtx && captura.audioCtx.state !== 'closed') {
    await captura.audioCtx.close();
  }
  captura.audioCtx = null;

  ui.btnEscuchar.classList.remove('activo');
  ui.txtEscuchar.textContent = 'Escuchar';
  ui.btnEscuchar.querySelector('.icono').innerHTML = '&#9654;';
  ui.medidor.style.width = '0%';
  setEstado('Listo');
}

/* ------------------------- backend ------------------------- */

// Transporte principal: WebSocket persistente (/ws). Evita el handshake por el
// túnel en cada fragmento, permite que la subida del siguiente fragmento se
// solape con la transcripción del actual y deja que el backend fije el idioma
// y mantenga contexto entre fragmentos. Si no está disponible (backend
// antiguo, túnel sin WS), cada fragmento cae a HTTP /transcribe.
const ws = { socket: null, listo: false, intentos: 0, timer: null };
const WS_REINTENTO_MAX_MS = 10000;

function urlWebSocket(apiUrl) {
  try {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/transcribe\/?$/, '').replace(/\/+$/, '')}/ws`;
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function enviarConfigWs() {
  if (!ws.listo) return;
  ws.socket.send(JSON.stringify({ type: 'config', target_lang: cfg.targetLang }));
}

function conectarWs() {
  clearTimeout(ws.timer);
  if (!captura.activa || ws.socket) return;
  const url = urlWebSocket(cfg.apiUrl);
  if (!url) return;

  const socket = new WebSocket(url);
  ws.socket = socket;

  socket.onopen = () => {
    ws.listo = true;
    ws.intentos = 0;
    enviarConfigWs();
    if (captura.activa) setEstado('Escuchando (ws)', 'ok');
  };

  socket.onmessage = (evento) => {
    let mensaje;
    try { mensaje = JSON.parse(evento.data); } catch { return; }
    manejarMensajeWs(mensaje);
  };

  socket.onerror = () => { /* onclose llega justo después */ };

  socket.onclose = () => {
    ws.listo = false;
    ws.socket = null;
    if (!captura.activa) return;
    // Mientras se reconecta, los fragmentos van por HTTP: no se pierde nada.
    const espera = Math.min(WS_REINTENTO_MAX_MS, 1000 * 2 ** ws.intentos);
    ws.intentos += 1;
    ws.timer = setTimeout(conectarWs, espera);
  };
}

function cerrarWs() {
  clearTimeout(ws.timer);
  ws.timer = null;
  ws.listo = false;
  ws.intentos = 0;
  if (ws.socket) {
    const socket = ws.socket;
    ws.socket = null;
    socket.onclose = null;
    try { socket.close(); } catch { /* ya cerrado */ }
  }
}

function manejarMensajeWs(mensaje) {
  switch (mensaje.type) {
    case 'result': {
      fallosSeguidos = 0;
      const texto = (mensaje.translation || mensaje.text || '').trim();
      if (texto) mostrarSubtitulo(texto);
      if (captura.activa) {
        setEstado(`Escuchando (ws · ${mensaje.total_ms} ms)`, 'ok');
      }
      break;
    }
    case 'dropped':
      setEstado(`Backend saturado: ${mensaje.seqs.length} fragmento(s) descartado(s)`, 'error');
      break;
    case 'error':
      console.error('[widget] backend:', mensaje.detail);
      break;
    default:
      break;   // ready, config_ok, empty, pong
  }
}

// Los envíos HTTP se encadenan en una sola promesa: con fetch en paralelo los
// fragmentos pueden resolverse fuera de orden y los subtítulos se desordenan.
// Por WebSocket el orden lo garantiza la propia conexión.
async function enviarFragmento(blob) {
  if (ws.listo) {
    try {
      ws.socket.send(await blob.arrayBuffer());
      return;
    } catch (error) {
      console.warn('[widget] fallo enviando por ws, se usa HTTP:', error);
    }
  }
  encolarEnvio(blob);
}

function encolarEnvio(blob) {
  cola = cola.then(() => enviar(blob)).catch((error) => {
    console.error('[widget] envio fallido:', error);
  });
}

async function enviar(blob) {
  const formData = new FormData();
  formData.append('file', blob, 'chunk.webm');
  formData.append('target_lang', cfg.targetLang);

  try {
    const respuesta = await fetch(cfg.apiUrl, { method: 'POST', body: formData });
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

    const datos = await respuesta.json();
    fallosSeguidos = 0;
    if (captura.activa && !ws.listo) setEstado('Escuchando (http)', 'ok');

    if (!datos.success || !datos.segments?.length) return;

    const texto = datos.segments
      .map((s) => s.translations?.[cfg.targetLang] ?? s.text)
      .join(' ')
      .trim();

    if (texto) mostrarSubtitulo(texto);
  } catch (error) {
    fallosSeguidos += 1;
    setEstado(`Backend sin respuesta (${fallosSeguidos})`, 'error');
    throw error;
  }
}

/* ------------------------- eventos de interfaz ------------------------- */

function guardar(parcial) {
  Object.assign(cfg, parcial);
  window.widget.guardarConfig(parcial);
}

ui.btnEscuchar.addEventListener('click', () => (captura.activa ? detener() : iniciar()));

ui.selFuente.addEventListener('change', async () => {
  guardar({ fuente: ui.selFuente.value });
  ui.selDispositivo.hidden = cfg.fuente !== 'device';
  if (cfg.fuente === 'device') await enumerarDispositivos();
  if (captura.activa) { await detener(); await iniciar(); }
});

ui.selDispositivo.addEventListener('change', async () => {
  guardar({ deviceId: ui.selDispositivo.value });
  if (captura.activa) { await detener(); await iniciar(); }
});

const ALTO_CON_AJUSTES = 520;
let altoPlegado = null;

ui.btnAjustes.addEventListener('click', () => {
  const abriendo = ui.ajustes.hidden;
  ui.ajustes.hidden = !abriendo;
  ui.btnAjustes.classList.toggle('encendido', abriendo);

  if (abriendo) {
    altoPlegado = window.outerHeight;
    window.widget.setAlto(Math.max(ALTO_CON_AJUSTES, altoPlegado));
  } else if (altoPlegado) {
    window.widget.setAlto(altoPlegado);
  }
});

ui.btnFantasma.addEventListener('click', () => {
  fantasma = !fantasma;
  ui.btnFantasma.classList.toggle('encendido', fantasma);
  window.widget.setClickThrough(fantasma, true);
  setEstado(fantasma ? 'Modo fantasma activo' : 'Listo');
});

// Con click-through activo la ventana ignora el raton, asi que no habria forma
// de volver a pulsar los botones: al pasar el cursor por la barra lo levantamos.
document.addEventListener('mousemove', (e) => {
  if (!fantasma) return;
  const dentro = e.clientY <= ui.barra.getBoundingClientRect().bottom;
  if (dentro !== sobreLaBarra) {
    sobreLaBarra = dentro;
    window.widget.setClickThrough(!dentro, false);
  }
});

ui.btnMin.addEventListener('click', () => window.widget.minimizar());
ui.btnCerrar.addEventListener('click', () => window.widget.cerrar());

function normalizarUrl(texto) {
  const limpio = texto.trim();
  if (!limpio) return '';
  // El tunel se copia normalmente sin la ruta final: la anadimos nosotros.
  return /\/transcribe\/?$/.test(limpio)
    ? limpio
    : `${limpio.replace(/\/+$/, '')}/transcribe`;
}

function urlValida(texto) {
  try {
    const url = new URL(texto);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function guardarUrl(texto) {
  if (!urlValida(texto)) {
    setEstado('URL no valida: debe empezar por http:// o https://', 'error');
    return false;
  }
  ui.inpApi.value = texto;
  guardar({ apiUrl: texto });
  setEstado('Backend guardado', 'ok');
  // Con la captura en marcha, el ws se reabre contra la URL nueva.
  if (captura.activa) { cerrarWs(); conectarWs(); }
  return true;
}

ui.btnPegar.addEventListener('click', async () => {
  const texto = normalizarUrl(await window.widget.leerPortapapeles());
  if (!texto) return setEstado('El portapapeles esta vacio', 'error');
  guardarUrl(texto);
});

ui.inpApi.addEventListener('change', () => guardarUrl(normalizarUrl(ui.inpApi.value)));
ui.selIdioma.addEventListener('change', () => {
  guardar({ targetLang: ui.selIdioma.value });
  enviarConfigWs();
});
ui.chkMonitor.addEventListener('change', () => guardar({ monitorizar: ui.chkMonitor.checked }));

const deslizadores = [
  [ui.inpFuente, 'fontSize', ui.valFuente, (v) => `${v} px`],
  [ui.inpOpacidad, 'opacidad', ui.valOpacidad, (v) => `${Math.round(v * 100)} %`],
  [ui.inpMin, 'minChunkMs', ui.valMin, (v) => `${(v / 1000).toFixed(2)} s`],
  [ui.inpMax, 'maxChunkMs', ui.valMax, (v) => `${(v / 1000).toFixed(1)} s`],
  [ui.inpUmbral, 'umbralSilencio', ui.valUmbral, (v) => v.toFixed(3)]
];

for (const [input, clave, salida, formato] of deslizadores) {
  input.addEventListener('input', () => {
    const valor = clave === 'opacidad' ? input.valueAsNumber / 100
                : clave === 'umbralSilencio' ? input.valueAsNumber / 1000
                : input.valueAsNumber;
    cfg[clave] = valor;
    salida.textContent = formato(valor);
    aplicarEstilos();
  });
  input.addEventListener('change', () => guardar({ [clave]: cfg[clave] }));
}

window.widget.onAtajo((nombre) => {
  if (nombre === 'toggle') captura.activa ? detener() : iniciar();
});

/* ------------------------- arranque ------------------------- */

(async function arrancar() {
  cfg = await window.widget.leerConfig();

  ui.inpApi.value = cfg.apiUrl;
  ui.selIdioma.value = cfg.targetLang;
  ui.selFuente.value = cfg.fuente;
  ui.chkMonitor.checked = cfg.monitorizar;
  ui.selDispositivo.hidden = cfg.fuente !== 'device';

  ui.inpFuente.value = cfg.fontSize;
  ui.inpOpacidad.value = Math.round(cfg.opacidad * 100);
  ui.inpMin.value = cfg.minChunkMs;
  ui.inpMax.value = cfg.maxChunkMs;
  ui.inpUmbral.value = Math.round(cfg.umbralSilencio * 1000);

  ui.valFuente.textContent = `${cfg.fontSize} px`;
  ui.valOpacidad.textContent = `${Math.round(cfg.opacidad * 100)} %`;
  ui.valMin.textContent = `${(cfg.minChunkMs / 1000).toFixed(2)} s`;
  ui.valMax.textContent = `${(cfg.maxChunkMs / 1000).toFixed(1)} s`;
  ui.valUmbral.textContent = cfg.umbralSilencio.toFixed(3);

  aplicarEstilos();
  ui.subtitulo.textContent = 'Pulsa Escuchar para empezar';

  if (cfg.fuente === 'device') await enumerarDispositivos();
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (cfg.fuente === 'device') enumerarDispositivos();
  });
})();

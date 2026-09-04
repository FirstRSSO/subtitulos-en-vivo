const $ = (id) => document.getElementById(id);

const ui = {
  app: $('app'),
  btnEscuchar: $('btnEscuchar'), txtEscuchar: $('txtEscuchar'),
  selFuente: $('selFuente'), selDispositivo: $('selDispositivo'),
  estado: $('estado'), subtitulo: $('subtitulo'),
  medidor: $('medidorRelleno'), barra: $('barra'),
  ajustes: $('ajustes'), btnAjustes: $('btnAjustes'), btnFantasma: $('btnFantasma'),
  btnCompacto: $('btnCompacto'), btnMin: $('btnMin'), btnCerrar: $('btnCerrar'),
  cinta: $('cinta'), cintaEstado: $('cintaEstado'),
  btnCintaEscuchar: $('btnCintaEscuchar'), btnCintaOpciones: $('btnCintaOpciones'),
  btnCintaCerrar: $('btnCintaCerrar'),
  inpApi: $('inpApi'), btnPegar: $('btnPegar'), selIdioma: $('selIdioma'),
  inpFuente: $('inpFuente'), inpOpacidad: $('inpOpacidad'),
  inpMin: $('inpMin'), inpMax: $('inpMax'), inpUmbral: $('inpUmbral'),
  chkMonitor: $('chkMonitor'),
  valFuente: $('valFuente'), valOpacidad: $('valOpacidad'),
  valMin: $('valMin'), valMax: $('valMax'), valUmbral: $('valUmbral'),
  logs: $('logs'), logLista: $('logLista'), btnLogs: $('btnLogs'),
  logRuta: $('logRuta'), btnLogCopiar: $('btnLogCopiar'),
  btnLogAbrir: $('btnLogAbrir'), btnLogVaciar: $('btnLogVaciar')
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
let seqLocal = 0;
let altoPlegado = null;
let erroresSinVer = 0;

/* ------------------------- estado e interfaz ------------------------- */

function setEstado(texto, tipo = '') {
  ui.estado.textContent = texto;
  ui.estado.title = texto;
  ui.estado.className = `estado ${tipo}`;
  ui.cintaEstado.textContent = texto;
  ui.cintaEstado.title = texto;
  ui.cintaEstado.className = `estado ${tipo}`;
}

function pintarCaptura() {
  const activo = captura.activa;
  ui.btnEscuchar.classList.toggle('activo', activo);
  ui.txtEscuchar.textContent = activo ? 'Detener' : 'Escuchar';
  ui.btnEscuchar.querySelector('.icono').innerHTML = activo ? '&#9632;' : '&#9654;';
  ui.btnCintaEscuchar.classList.toggle('activo', activo);
  ui.btnCintaEscuchar.querySelector('.icono').innerHTML = activo ? '&#9632;' : '&#9654;';
  ui.app.classList.toggle('escuchando', activo);
}

function altoCompacto() {
  return Math.round(Math.max(56, (cfg.fontSize || 24) * 1.45 + 36));
}

async function setCompacto(activo, { animar = true } = {}) {
  const ir = Boolean(activo);
  const ya = ui.app.classList.contains('compacto');
  if (ir) {
    ui.ajustes.hidden = true;
    ui.logs.hidden = true;
    ui.btnAjustes.classList.remove('encendido');
    ui.btnLogs.classList.remove('encendido');
    altoPlegado = null;
    if (animar && !ya) await guardar({ compacto: true, altoOpciones: window.outerHeight });
    else await guardar({ compacto: true });
    ui.app.classList.add('compacto');
    ui.btnCompacto.classList.add('encendido');
    await window.widget.setMinimos(true);
    if (animar && !ya) {
      const alto = cfg.altoCompacto > 0 ? cfg.altoCompacto : altoCompacto();
      await window.widget.setAlto(alto, true);
    }
  } else {
    if (animar && ya) await guardar({ compacto: false, altoCompacto: window.outerHeight });
    else await guardar({ compacto: false });
    ui.app.classList.remove('compacto');
    ui.btnCompacto.classList.remove('encendido');
    await window.widget.setMinimos(false);
    if (animar && ya) await window.widget.setAlto(Math.max(140, cfg.altoOpciones || 210), true);
  }
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

// Subtítulos que no son habla: alucinaciones de Whisper o errores de HTTP/traducción.
const BASURA_SUB = new RegExp(
  '^[\\s\\W\\d]*(' +
    'error\\s*[45]\\d{2}|' +
    'internal server error|' +
    'that[\'’]?s an error|' +
    'that is an error|' +
    'eso es un error|' +
    '\\[error[^\\]]*\\]|' +
    'thanks? (you )?for watching|' +
    'thank you\\.?' +
  ')[\\s\\W\\d]*$',
  'i'
);

function recortar(texto, n = 140) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function pareceBasura(texto) {
  const t = String(texto || '').trim();
  return !t || BASURA_SUB.test(t);
}

function elegirSubtitulo(original, traduccion) {
  const orig = String(original || '').trim();
  let trad = String(traduccion || '').trim();
  if (/^\[error/i.test(trad)) {
    registrar('warn', 'servidor', 'Traducción falló; se usa el original', recortar(trad));
    trad = orig;
  }
  if (pareceBasura(trad) && !pareceBasura(orig)) return orig;
  if (pareceBasura(trad) || pareceBasura(orig)) return '';
  return trad || orig;
}

function aplicarEstilos() {
  ui.subtitulo.style.fontSize = `${cfg.fontSize}px`;
  ui.subtitulo.style.background = `rgba(0, 0, 0, ${cfg.opacidad})`;
}

/* ------------------------- registro ------------------------- */
// Cada línea lleva origen para saber si un "Error 500" es el notebook
// (servidor), Cloudflare (túnel), un corte de red, o un fallo local.

const MAX_LOGS = 300;
const CODIGOS_TUNEL = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const logsMem = [];

function horaLocal(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function etiquetaOrigen(origen) {
  return origen === 'tunel' ? 'túnel' : origen;
}

function origenHttp(status) {
  return CODIGOS_TUNEL.has(status) ? 'tunel' : 'servidor';
}

function formatearLinea(e) {
  const extra = e.extra ? ` — ${e.extra}` : '';
  return `${e.iso}  ${e.nivel.toUpperCase().padEnd(5)}  ${etiquetaOrigen(e.origen).padEnd(8)}  ${e.mensaje}${extra}`;
}

function registrar(nivel, origen, mensaje, extra = '') {
  const ahora = new Date();
  const entrada = {
    iso: ahora.toISOString(),
    hora: horaLocal(ahora),
    nivel,
    origen,
    mensaje: String(mensaje || ''),
    extra: extra ? String(extra) : ''
  };
  logsMem.push(entrada);
  if (logsMem.length > MAX_LOGS) logsMem.shift();
  pintarEntrada(entrada);
  while (ui.logLista.children.length > MAX_LOGS) ui.logLista.firstChild.remove();
  window.widget.appendLog(formatearLinea(entrada)).catch(() => {});
  if (nivel === 'error' && ui.logs.hidden) {
    erroresSinVer += 1;
    ui.btnLogs.classList.add('alerta');
    ui.btnLogs.title = `Registro (${erroresSinVer} error(es) nuevo(s))`;
  }
}

function pintarEntrada(e) {
  const lista = ui.logLista;
  const alFondo = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 48;
  const li = document.createElement('li');
  li.className = `log-${e.nivel}`;
  const time = document.createElement('time');
  time.textContent = e.hora;
  const origen = document.createElement('span');
  origen.className = `log-origen ${e.origen}`;
  origen.textContent = etiquetaOrigen(e.origen);
  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = e.extra ? `${e.mensaje} — ${e.extra}` : e.mensaje;
  li.append(time, origen, msg);
  lista.append(li);
  if (alFondo) lista.scrollTop = lista.scrollHeight;
}

async function cuerpoError(respuesta) {
  let raw = '';
  try { raw = await respuesta.text(); } catch { return ''; }
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    if (typeof json.detail === 'string') return json.detail;
    if (json.detail) return JSON.stringify(json.detail);
    if (typeof json.message === 'string') return json.message;
    return JSON.stringify(json).slice(0, 400);
  } catch {
    const title = raw.match(/<title>([^<]+)<\/title>/i);
    const h1 = raw.match(/<h1>([^<]+)<\/h1>/i);
    const plano = (title?.[1] || h1?.[1] || raw.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    return plano.slice(0, 400);
  }
}

function urlHealth(apiUrl) {
  try {
    const url = new URL(apiUrl);
    url.pathname = `${url.pathname.replace(/\/transcribe\/?$/, '').replace(/\/+$/, '')}/health`;
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

async function comprobarSalud() {
  const url = urlHealth(cfg.apiUrl);
  if (!url) {
    registrar('error', 'widget', 'URL del backend no válida', cfg.apiUrl);
    return;
  }
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: 'GET' });
    const ms = Math.round(performance.now() - t0);
    const raw = await r.text();
    if (!r.ok) {
      let detalle = raw.slice(0, 300);
      try {
        const j = JSON.parse(raw);
        detalle = typeof j.detail === 'string' ? j.detail : raw.slice(0, 300);
      } catch {
        detalle = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      }
      registrar('error', origenHttp(r.status), `GET /health → ${r.status} (${ms} ms)`, detalle);
      return;
    }
    let extra = raw.slice(0, 200);
    try {
      const j = JSON.parse(raw);
      extra = `device=${j.device ?? '?'} model=${j.model ?? '?'} ws=${j.ws ?? '?'}`;
    } catch { /* texto plano */ }
    registrar('info', 'servidor', `GET /health → ${r.status} (${ms} ms)`, extra);
  } catch (error) {
    registrar(
      'error',
      'red',
      `GET /health no responde (${Math.round(performance.now() - t0)} ms)`,
      error.message
    );
  }
}

function sincronizarAlto() {
  if (cfg.compacto) return;
  const ajustes = !ui.ajustes.hidden;
  const logs = !ui.logs.hidden;
  if (!ajustes && !logs) {
    if (altoPlegado !== null) window.widget.setAlto(altoPlegado);
    altoPlegado = null;
    return;
  }
  if (altoPlegado === null) altoPlegado = window.outerHeight;
  const alto = ajustes && logs ? 700 : ajustes ? 520 : 440;
  window.widget.setAlto(Math.max(alto, altoPlegado));
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
    seqLocal = 0;
    registrar('info', 'widget', 'Iniciando captura', `fuente=${cfg.fuente} lang=${cfg.targetLang}`);
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
    pintarCaptura();
    setEstado('Escuchando', 'ok');
    fallosSeguidos = 0;
    registrar('info', 'widget', 'Captura activa', cfg.fuente === 'device' ? `dispositivo=${cfg.deviceId}` : 'loopback');

    conectarWs();
    comprobarSalud();
    grabarFragmento();
  } catch (error) {
    console.error('[widget]', error);
    registrar('error', 'widget', 'No se pudo iniciar la captura', error.message);
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
  recorder.onerror = (e) => {
    registrar('error', 'widget', 'MediaRecorder falló', e.error?.message || 'error desconocido');
  };

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
  const estabaActiva = captura.activa;
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

  pintarCaptura();
  ui.medidor.style.width = '0%';
  setEstado('Listo');
  if (estabaActiva) registrar('info', 'widget', 'Captura detenida');
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
  if (!url) {
    registrar('error', 'widget', 'No se pudo derivar la URL del WebSocket', cfg.apiUrl);
    return;
  }

  registrar('info', 'widget', `Conectando WS (intento ${ws.intentos + 1})`, url);
  const socket = new WebSocket(url);
  ws.socket = socket;

  socket.onopen = () => {
    ws.listo = true;
    ws.intentos = 0;
    registrar('info', 'servidor', 'WS abierto');
    enviarConfigWs();
    if (captura.activa) setEstado('Escuchando (ws)', 'ok');
  };

  socket.onmessage = (evento) => {
    let mensaje;
    try { mensaje = JSON.parse(evento.data); } catch {
      registrar('warn', 'servidor', 'WS recibió un mensaje no JSON');
      return;
    }
    manejarMensajeWs(mensaje);
  };

  socket.onerror = () => {
    registrar('warn', 'red', 'WS error de transporte (el cierre llega a continuación)');
  };

  socket.onclose = (evento) => {
    ws.listo = false;
    ws.socket = null;
    const cierre = explicarCierreWs(evento.code, evento.reason);
    registrar(evento.code === 1000 ? 'info' : 'warn', cierre.origen, cierre.texto);
    if (!captura.activa) return;
    // Mientras se reconecta, los fragmentos van por HTTP: no se pierde nada.
    const espera = Math.min(WS_REINTENTO_MAX_MS, 1000 * 2 ** ws.intentos);
    ws.intentos += 1;
    registrar('info', 'widget', `Reintento WS en ${Math.round(espera / 1000)} s; fragmentos por HTTP`);
    ws.timer = setTimeout(conectarWs, espera);
  };
}

function explicarCierreWs(code, reason) {
  const mapa = {
    1000: 'cierre normal',
    1001: 'el servidor se fue',
    1006: 'corte de red o el túnel cayó (sin cierre limpio)',
    1011: 'error interno del servidor',
    1012: 'el servidor se reinició',
    1013: 'servidor saturado'
  };
  const origen = code === 1011 ? 'servidor' : (code === 1000 ? 'servidor' : 'red');
  const por = mapa[code] || 'código desconocido';
  return {
    origen,
    texto: `WS cerrado (${code}: ${por})${reason ? ` · ${reason}` : ''}`
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
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(); } catch { /* ya cerrado */ }
  }
}

function manejarMensajeWs(mensaje) {
  switch (mensaje.type) {
    case 'ready':
      registrar('info', 'servidor', `WS listo · ${mensaje.device ?? '?'} · ${mensaje.model ?? '?'}`);
      break;
    case 'config_ok':
      registrar('info', 'servidor', `Config OK lang=${mensaje.language ?? 'auto'} → ${mensaje.target_lang ?? '?'}`);
      break;
    case 'result': {
      fallosSeguidos = 0;
      const original = (mensaje.text || '').trim();
      const traduccion = (mensaje.translation || '').trim();
      const texto = elegirSubtitulo(original, traduccion);
      registrar(
        'info',
        'servidor',
        `WS result #${mensaje.seq ?? '?'} ${mensaje.total_ms} ms`,
        `${mensaje.language ?? '?'} ${mensaje.audio_s ?? '?'}s «${recortar(original)}» → «${recortar(traduccion || original)}»`
      );
      if (!texto) {
        registrar('warn', 'widget', 'Subtítulo descartado (parece error o alucinación)', recortar(traduccion || original));
        break;
      }
      mostrarSubtitulo(texto);
      if (captura.activa) {
        setEstado(`Escuchando (ws · ${mensaje.total_ms} ms)`, 'ok');
      }
      break;
    }
    case 'empty':
      registrar('info', 'servidor', `WS empty #${mensaje.seq ?? '?'}`);
      break;
    case 'dropped':
      registrar('warn', 'servidor', `GPU saturada, descartados: ${(mensaje.seqs || []).join(',')}`);
      setEstado(`Backend saturado: ${mensaje.seqs.length} fragmento(s) descartado(s)`, 'error');
      break;
    case 'error':
      registrar('error', 'servidor', `WS error #${mensaje.seq ?? '-'}`, mensaje.detail || 'sin detalle');
      setEstado(`Error del servidor: ${String(mensaje.detail || 'sin detalle').slice(0, 80)}`, 'error');
      break;
    default:
      break;   // pong
  }
}

// Los envíos HTTP se encadenan en una sola promesa: con fetch en paralelo los
// fragmentos pueden resolverse fuera de orden y los subtítulos se desordenan.
// Por WebSocket el orden lo garantiza la propia conexión.
async function enviarFragmento(blob) {
  seqLocal += 1;
  const seq = seqLocal;
  const kb = Math.max(1, Math.round(blob.size / 1024));
  if (ws.listo) {
    try {
      ws.socket.send(await blob.arrayBuffer());
      registrar('info', 'widget', `frag #${seq} ${kb} kB por WS`);
      return;
    } catch (error) {
      registrar('warn', 'widget', `frag #${seq} WS falló, se usa HTTP`, error.message);
    }
  } else {
    registrar('info', 'widget', `frag #${seq} ${kb} kB por HTTP (WS no listo)`);
  }
  encolarEnvio(blob, seq);
}

function encolarEnvio(blob, seq) {
  cola = cola.then(() => enviar(blob, seq)).catch((error) => {
    console.error('[widget] envio fallido:', error);
  });
}

async function enviar(blob, seq) {
  const formData = new FormData();
  formData.append('file', blob, 'chunk.webm');
  formData.append('target_lang', cfg.targetLang);
  const t0 = performance.now();
  const kb = Math.max(1, Math.round(blob.size / 1024));

  try {
    const respuesta = await fetch(cfg.apiUrl, { method: 'POST', body: formData });
    const ms = Math.round(performance.now() - t0);
    if (!respuesta.ok) {
      const detalle = await cuerpoError(respuesta);
      const origen = origenHttp(respuesta.status);
      const quien = origen === 'tunel' ? 'túnel Cloudflare' : 'servidor';
      registrar(
        'error',
        origen,
        `HTTP ${respuesta.status} frag #${seq} ${kb} kB (${ms} ms) · ${quien}`,
        detalle || 'sin cuerpo'
      );
      fallosSeguidos += 1;
      const corto = (detalle || quien).slice(0, 70);
      setEstado(`Error ${respuesta.status} (${quien}): ${corto}`, 'error');
      const err = new Error(`HTTP ${respuesta.status}: ${detalle}`);
      err.yaRegistrado = true;
      throw err;
    }

    const datos = await respuesta.json();
    fallosSeguidos = 0;
    if (captura.activa && !ws.listo) setEstado('Escuchando (http)', 'ok');
    registrar('info', 'servidor', `HTTP 200 frag #${seq} (${ms} ms)`, `${datos.segments?.length ?? 0} segmento(s)`);

    if (!datos.success || !datos.segments?.length) return;

    const original = datos.segments.map((s) => s.text).join(' ').trim();
    const traduccion = datos.segments
      .map((s) => s.translations?.[cfg.targetLang] ?? s.text)
      .join(' ')
      .trim();
    registrar('info', 'servidor', `HTTP texto frag #${seq}`, `«${recortar(original)}» → «${recortar(traduccion)}»`);
    const texto = elegirSubtitulo(original, traduccion);
    if (!texto) {
      registrar('warn', 'widget', 'Subtítulo descartado (parece error o alucinación)', recortar(traduccion || original));
      return;
    }
    mostrarSubtitulo(texto);
  } catch (error) {
    if (!error.yaRegistrado) {
      fallosSeguidos += 1;
      const ms = Math.round(performance.now() - t0);
      registrar('error', 'red', `Sin respuesta frag #${seq} (${ms} ms, fallo ${fallosSeguidos})`, error.message);
      setEstado(`Sin red (${fallosSeguidos}): ${error.message}`, 'error');
    }
    throw error;
  }
}

/* ------------------------- eventos de interfaz ------------------------- */

function guardar(parcial) {
  Object.assign(cfg, parcial);
  return window.widget.guardarConfig(parcial);
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

ui.btnAjustes.addEventListener('click', () => {
  const abriendo = ui.ajustes.hidden;
  ui.ajustes.hidden = !abriendo;
  ui.btnAjustes.classList.toggle('encendido', abriendo);
  sincronizarAlto();
});

ui.btnLogs.addEventListener('click', () => {
  const abriendo = ui.logs.hidden;
  ui.logs.hidden = !abriendo;
  ui.btnLogs.classList.toggle('encendido', abriendo);
  if (abriendo) {
    erroresSinVer = 0;
    ui.btnLogs.classList.remove('alerta');
    ui.btnLogs.title = 'Registro de eventos';
    ui.logLista.scrollTop = ui.logLista.scrollHeight;
  }
  sincronizarAlto();
});

ui.btnLogCopiar.addEventListener('click', async () => {
  const texto = logsMem.map(formatearLinea).join('\n');
  await window.widget.escribirPortapapeles(texto || '(vacío)');
  setEstado('Registro copiado', 'ok');
});

ui.btnLogAbrir.addEventListener('click', () => window.widget.abrirLog());

ui.btnLogVaciar.addEventListener('click', async () => {
  logsMem.length = 0;
  ui.logLista.innerHTML = '';
  await window.widget.vaciarLog();
  registrar('info', 'widget', 'Registro vaciado');
});

ui.btnFantasma.addEventListener('click', () => {
  fantasma = !fantasma;
  ui.btnFantasma.classList.toggle('encendido', fantasma);
  window.widget.setClickThrough(fantasma, true);
  setEstado(fantasma ? 'Modo fantasma activo' : 'Listo');
});

ui.btnCompacto.addEventListener('click', () => setCompacto(!cfg.compacto));
ui.btnCintaOpciones.addEventListener('click', () => setCompacto(false));
ui.btnCintaEscuchar.addEventListener('click', () => (captura.activa ? detener() : iniciar()));
ui.btnCintaCerrar.addEventListener('click', () => window.widget.cerrar());
ui.subtitulo.addEventListener('dblclick', () => setCompacto(!cfg.compacto));

// Con click-through activo la ventana ignora el raton, asi que no habria forma
// de volver a pulsar los botones: al pasar el cursor por la barra lo levantamos.
document.addEventListener('mousemove', (e) => {
  if (!fantasma) return;
  let dentro;
  if (cfg.compacto) {
    const r = ui.app.getBoundingClientRect();
    dentro = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  } else {
    dentro = e.clientY <= ui.barra.getBoundingClientRect().bottom;
  }
  if (dentro !== sobreLaBarra) {
    sobreLaBarra = dentro;
    window.widget.setClickThrough(!dentro, false);
  }
});

ui.btnMin.addEventListener('click', () => window.widget.minimizar());
ui.btnCerrar.addEventListener('click', () => window.widget.cerrar());

let redimensionando = false;
for (const asa of document.querySelectorAll('#resizers [data-edge]')) {
  asa.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    redimensionando = true;
    asa.setPointerCapture(e.pointerId);
    window.widget.iniciarResize(asa.dataset.edge);
  });
  const soltar = (e) => {
    try { asa.releasePointerCapture(e.pointerId); } catch { /* ya suelta */ }
    if (!redimensionando) return;
    redimensionando = false;
    window.widget.finResize();
  };
  asa.addEventListener('pointerup', soltar);
  asa.addEventListener('pointercancel', soltar);
}
window.addEventListener('blur', () => {
  if (!redimensionando) return;
  redimensionando = false;
  window.widget.finResize();
});

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
    registrar('error', 'widget', 'URL no válida', texto);
    return false;
  }
  ui.inpApi.value = texto;
  guardar({ apiUrl: texto });
  setEstado('Backend guardado', 'ok');
  registrar('info', 'widget', 'Backend actualizado', texto);
  // Con la captura en marcha, el ws se reabre contra la URL nueva.
  if (captura.activa) { cerrarWs(); conectarWs(); comprobarSalud(); }
  else comprobarSalud();
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
  if (nombre === 'compacto') setCompacto(!cfg.compacto);
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
  await setCompacto(Boolean(cfg.compacto), { animar: false });

  try {
    const ruta = await window.widget.rutaLog();
    ui.logRuta.textContent = ruta;
    ui.logRuta.title = ruta;
  } catch { /* el archivo se crea al primer evento */ }

  registrar('info', 'widget', 'Widget iniciado', `backend=${cfg.apiUrl}`);
  comprobarSalud();

  if (cfg.fuente === 'device') await enumerarDispositivos();
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (cfg.fuente === 'device') enumerarDispositivos();
  });
})();

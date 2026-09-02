const inpApi = document.getElementById('inpApi');
const selIdioma = document.getElementById('selIdioma');
const btnPegar = document.getElementById('btnPegar');
const btnEscuchar = document.getElementById('btnEscuchar');
const estado = document.getElementById('estado');

let grabando = false;

function setEstado(texto, tipo = '') {
  estado.textContent = texto;
  estado.className = tipo;
}

function pintarBoton() {
  btnEscuchar.textContent = grabando ? 'Detener traducción' : 'Iniciar traducción';
  btnEscuchar.classList.toggle('activo', grabando);
}

function urlValida(texto) {
  try {
    const url = new URL(texto);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// El manifest sólo declara localhost y trycloudflare. Si el usuario pega la URL
// de otro túnel (ngrok, etc.) hay que pedir el permiso de host en el momento,
// aprovechando que estamos dentro de un gesto del usuario.
async function asegurarPermiso(texto) {
  const origen = `${new URL(texto).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origen] })) return true;
  return chrome.permissions.request({ origins: [origen] });
}

async function guardarUrl() {
  const texto = inpApi.value.trim();
  if (!texto) return false;

  if (!urlValida(texto)) {
    setEstado('Esa URL no es válida. Debe empezar por http:// o https://', 'error');
    return false;
  }

  if (!(await asegurarPermiso(texto))) {
    setEstado('Sin permiso para ese dominio, la extensión no podrá conectarse', 'error');
    return false;
  }

  await guardarConfig({ apiUrl: texto });
  return true;
}

btnPegar.addEventListener('click', async () => {
  try {
    const texto = (await navigator.clipboard.readText()).trim();
    if (!texto) return setEstado('El portapapeles está vacío', 'error');

    // El túnel se copia normalmente sin la ruta final: la añadimos nosotros.
    inpApi.value = /\/transcribe\/?$/.test(texto)
      ? texto
      : `${texto.replace(/\/+$/, '')}/transcribe`;

    if (await guardarUrl()) setEstado('URL pegada y guardada', 'ok');
  } catch {
    setEstado('No se pudo leer el portapapeles', 'error');
  }
});

inpApi.addEventListener('change', async () => {
  if (await guardarUrl()) setEstado('URL guardada', 'ok');
});

selIdioma.addEventListener('change', async () => {
  await guardarConfig({ targetLang: selIdioma.value });
  setEstado('Idioma guardado', 'ok');
});

btnEscuchar.addEventListener('click', async () => {
  if (!grabando && !(await guardarUrl())) return;

  setEstado(grabando ? 'Deteniendo…' : 'Iniciando…');
  const respuesta = await chrome.runtime.sendMessage({
    target: 'background',
    action: grabando ? 'detener' : 'iniciar'
  });

  if (respuesta?.ok) {
    grabando = respuesta.grabando;
    pintarBoton();
    setEstado(grabando ? 'Escuchando esta pestaña' : 'Detenido', grabando ? 'ok' : '');
  } else {
    setEstado(respuesta?.error ?? 'Error desconocido', 'error');
  }
});

(async function arrancar() {
  const cfg = await leerConfig();
  inpApi.value = cfg.apiUrl;
  selIdioma.value = cfg.targetLang;

  const respuesta = await chrome.runtime.sendMessage({ target: 'background', action: 'estado' });
  grabando = Boolean(respuesta?.grabando);
  pintarBoton();
  if (grabando) setEstado('Escuchando', 'ok');
})();

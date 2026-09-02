// Valores por defecto compartidos por el popup, el background y el offscreen.
// La URL real vive en chrome.storage.local porque el túnel de Cloudflare
// cambia de dominio cada vez que se reinicia.
const CONFIG_DEFECTO = {
  apiUrl: 'http://localhost:8000/transcribe',
  targetLang: 'en'
};

async function leerConfig() {
  return chrome.storage.local.get(CONFIG_DEFECTO);
}

async function guardarConfig(parcial) {
  await chrome.storage.local.set(parcial);
}

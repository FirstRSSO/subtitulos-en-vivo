const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

// El service worker de MV3 se apaga tras ~30 s de inactividad, así que una
// variable suelta (`let recording = false`) se pierde entre un clic y el
// siguiente. La fuente de verdad real es si el documento offscreen existe.
async function estaGrabando() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL]
  });
  return contexts.length > 0;
}

// Páginas donde Chrome no permite capturar audio
function esCapturable(url) {
  if (!url) return false;
  return !/^(chrome|edge|about|chrome-extension|devtools|view-source):/.test(url) &&
         !url.startsWith('https://chromewebstore.google.com');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'background') return;

  // Reenvía al content.js de la pestaña el subtítulo que llega desde
  // offscreen.js (offscreen no tiene acceso a chrome.tabs).
  if (message.action === 'mostrar_subtitulo') {
    chrome.tabs.sendMessage(message.tabId, {
      action: 'mostrar_subtitulo',
      texto: message.texto
    }).catch(() => {
      // La pestaña se cerró o navegó a otra página: no es un error fatal.
    });
    return;
  }

  // Órdenes del popup. El listener no puede ser async, así que se responde
  // desde una promesa y se devuelve `true` para mantener abierto el canal.
  if (['iniciar', 'detener', 'estado'].includes(message.action)) {
    atender(message.action).then(sendResponse);
    return true;
  }
});

async function atender(accion) {
  try {
    if (accion === 'estado') {
      return { ok: true, grabando: await estaGrabando() };
    }

    if (accion === 'detener') {
      await detener();
      return { ok: true, grabando: false };
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await iniciar(tab);
    return { ok: true, grabando: true };
  } catch (error) {
    console.error('[TraductorAudios]', error);
    await detener().catch(() => {});   // no dejar el offscreen a medio montar
    return { ok: false, error: error.message };
  }
}

async function iniciar(tab) {
  // chrome.tabCapture falta en algunos forks de Chromium (Avast Secure
  // Browser, entre otros) aunque acepten el permiso en el manifest.
  if (!chrome.tabCapture) {
    console.warn(
      '[TraductorAudios] Diagnóstico:',
      '\n  navegador:      ', navigator.userAgent,
      '\n  APIs de captura:', Object.keys(chrome).filter(k => /capture|media|desktop/i.test(k)),
      '\n  permisos:       ', (await chrome.permissions.getAll()).permissions
    );
    throw new Error(
      'Este navegador no expone chrome.tabCapture. La extensión necesita ' +
      'Google Chrome o Edge; los forks de Chromium suelen retirar esta API.'
    );
  }

  if (!tab) throw new Error('No hay ninguna pestaña activa');

  if (!esCapturable(tab.url)) {
    throw new Error('No se puede capturar audio en esta página de Chrome');
  }

  if (await estaGrabando()) await detener();

  // 1. Obtener el stream de audio de la pestaña actual
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  // 2. Crear el documento offscreen
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Captura y fragmentación de audio para traducción'
  });

  // 3. Inyectar el script de subtítulos en la pestaña
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  });

  // 4. Enviar la orden de inicio al offscreen
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'start',
    streamId: streamId,
    tabId: tab.id
  });

  chrome.action.setBadgeText({ text: 'ON' });
  chrome.action.setBadgeBackgroundColor({ color: '#00a344' });
}

async function detener() {
  // Cerrar el documento offscreen detiene los tracks y apaga el indicador
  // de grabación de Chrome.
  if (await estaGrabando()) await chrome.offscreen.closeDocument();
  chrome.action.setBadgeText({ text: '' });
}

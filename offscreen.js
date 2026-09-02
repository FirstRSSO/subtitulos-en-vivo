let mediaRecorder;
let timerInterval;
let currentStream = null;
let audioContext = null;

// La URL del backend y el idioma se leen de chrome.storage en cada envío
// (ver config.js): así un cambio desde el popup se aplica sin reiniciar
// la captura, que es justo lo que hace falta cuando el túnel cambia de dominio.
const CHUNK_DURATION = 6000; // 6 segundos

// No marcar el listener como `async`: devolver una promesa aquí hace que
// Chrome interprete mal el valor de retorno del canal de mensajes.
chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return;

  if (message.action === 'start') {
    startCapture(message.streamId, message.tabId);
  } else if (message.action === 'stop') {
    stopCapture();
  }
});

async function startCapture(streamId, tabId) {
  try {
    // CORREGIDO: Se eliminó "media," que causaba el fallo
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    currentStream = stream;

    // Para seguir escuchando el audio en tus audífonos mientras se graba
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);

    // Iniciar ciclo de grabación por fragmentos
    grabarFragmento(stream, tabId);
    timerInterval = setInterval(() => grabarFragmento(stream, tabId), CHUNK_DURATION);
  } catch (error) {
    console.error("Error al capturar el audio de la pestaña:", error);
  }
}

function grabarFragmento(stream, tabId) {
  if (!stream.active) return;

  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    enviarAlBackend(blob, tabId);
  };

  recorder.start();
  
  // Detener y disparar el evento onstop después de unos segundos
  setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, CHUNK_DURATION);
}

async function enviarAlBackend(audioBlob, tabId) {
  const { apiUrl, targetLang } = await leerConfig();

  const formData = new FormData();
  formData.append("file", audioBlob, "chunk.webm");
  formData.append("target_lang", targetLang);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      body: formData
    });
    const data = await response.json();

    if (data.success && data.segments.length > 0) {
      // Unir el texto traducido de los segmentos
      let textoTraducido = data.segments
        .map(s => s.translations ? s.translations[targetLang] : s.text)
        .join(" ");

      // Los documentos offscreen no tienen acceso a chrome.tabs,
      // así que se reenvía al background para que él se lo pase al content.js
      if (textoTraducido.trim() !== "") {
        chrome.runtime.sendMessage({
          target: "background",
          action: "mostrar_subtitulo",
          texto: textoTraducido,
          tabId: tabId
        });
      }
    }
  } catch (error) {
    console.error("Error conectando con el servidor:", error);
  }
}

function stopCapture() {
  clearInterval(timerInterval);
  
  // Liberar los canales de audio para que se apague el ícono de grabación en Chrome
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}
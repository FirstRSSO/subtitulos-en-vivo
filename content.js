// Crear el contenedor de subtítulos si no existe
let subBox = document.getElementById("whisper-subtitle-box");
if (!subBox) {
  subBox = document.createElement("div");
  subBox.id = "whisper-subtitle-box";
  Object.assign(subBox.style, {
    position: "fixed",
    bottom: "10%",
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    color: "#00FF66",
    padding: "12px 24px",
    fontSize: "22px",
    fontFamily: "Arial, sans-serif",
    borderRadius: "8px",
    zIndex: "999999",
    textAlign: "center",
    maxWidth: "80%",
    boxShadow: "0 4px 10px rgba(0,0,0,0.5)",
    transition: "opacity 0.3s ease",
    display: "none"
  });
  document.body.appendChild(subBox);
}

let ocultarTimer;

// executeScript vuelve a ejecutar este archivo en cada arranque; sin esta
// guarda se acumularía un listener nuevo por cada clic.
if (!window.__whisperSubsListener) {
  window.__whisperSubsListener = true;
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "mostrar_subtitulo") {
      subBox.innerText = message.texto;
      subBox.style.display = "block";
      subBox.style.opacity = "1";

      // Ocultar el subtítulo si no llega nada nuevo en 5 segundos
      clearTimeout(ocultarTimer);
      ocultarTimer = setTimeout(() => {
        subBox.style.opacity = "0";
        setTimeout(() => subBox.style.display = "none", 300);
      }, 5000);
    }
  });
}
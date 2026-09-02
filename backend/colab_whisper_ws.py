# Backend de transcripción para el widget de escritorio (Windows).
# Pegar cada bloque "CELDA" en una celda de Google Colab (GPU T4 o mejor).
#
# Qué cambia respecto a la versión anterior, y por qué:
#   - /ws (WebSocket): una sola conexión por sesión de escucha. Se ahorra el
#     handshake TCP+TLS por el túnel en cada fragmento (100-300 ms) y la subida
#     del fragmento N+1 se solapa con la transcripción del N.
#   - Idioma fijado por sesión: tras 2 fragmentos con detección segura se deja
#     de detectar (ahorra una pasada del encoder y evita que un fragmento corto
#     "cambie" de idioma y la traducción se salte).
#   - Contexto entre fragmentos: el texto anterior se pasa como initial_prompt
#     para que nombres, mayúsculas y puntuación sean coherentes.
#   - Decodificación en memoria (PyAV), sin archivo temporal ni ffmpeg externo.
#   - Traducción por el endpoint JSON de Google (gtx) con conexión keep-alive y
#     caché: 100-200 ms en lugar de 400-800 ms de deep-translator (que queda
#     como respaldo).
#   - Filtro de alucinaciones típicas de Whisper en fragmentos con música/ruido.
#   - Si la GPU se queda atrás, se descartan los fragmentos más viejos para que
#     el subtítulo siga "en vivo" en lugar de acumular retraso.
#   - /transcribe (HTTP) se mantiene: el widget cae a él si el WebSocket falla.

# ==========================================
# CELDA 1: Instalación de dependencias
# ==========================================
!pip install -q faster-whisper fastapi "uvicorn[standard]" python-multipart deep-translator requests
# CTranslate2 (motor de faster-whisper) necesita cuDNN 9 + cuBLAS 12. Si Colab trae otra
# versión, el kernel muere sin traceback en la primera inferencia. Se instalan vía pip.
!pip install -q "nvidia-cudnn-cu12>=9" "nvidia-cublas-cu12"
# No hace falta apt ffmpeg: faster-whisper decodifica con PyAV (trae sus propias libs).
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
!dpkg -i cloudflared-linux-amd64.deb > /dev/null
!cloudflared --version

# ==========================================
# CELDA 2: Carga de Modelo y Servidor
# ==========================================
import asyncio
import io
import json
import os
import re
import subprocess
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

# Cargar las librerías cuDNN/cuBLAS instaladas por pip ANTES de importar torch/ctranslate2.
try:
    import nvidia.cudnn, nvidia.cublas
    # Son namespace packages (sin __init__.py): __file__ es None, se usa __path__.
    _libs = [os.path.join(list(m.__path__)[0], "lib") for m in (nvidia.cudnn, nvidia.cublas)]
    _libs = [d for d in _libs if os.path.isdir(d)]
    os.environ["LD_LIBRARY_PATH"] = ":".join(_libs + [os.environ.get("LD_LIBRARY_PATH", "")])
    import ctypes
    for d in _libs:
        for f in sorted(os.listdir(d)):
            if f.endswith(".so") or ".so." in f:
                try:
                    ctypes.CDLL(os.path.join(d, f), mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
except ImportError:
    pass

import numpy as np
import requests
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from deep_translator import GoogleTranslator

# ---------- Hardware ----------
device = "cuda" if torch.cuda.is_available() else "cpu"
compute_type = "float16" if device == "cuda" else "int8"
model_size = "turbo"

print(f"¿Usando GPU?: {'SÍ' if device == 'cuda' else 'NO (Usando CPU)'}")
if device == "cuda":
    print(f"GPU detectada: {torch.cuda.get_device_name(0)}")

print(f"Cargando modelo: {model_size}...")
model = WhisperModel(model_size, device=device, compute_type=compute_type)
print(f"Modelo {model_size} cargado.")

# Warm-up: la primera inferencia es lenta (carga de kernels CUDA).
# Si el kernel muere aquí, el problema es cuDNN/CUDA, no el servidor.
WARMUP = True
if WARMUP:
    print("Precalentando (si el kernel se reinicia aquí, pon WARMUP = False y revisa cuDNN)...")
    _ = list(model.transcribe(np.zeros(16000, dtype=np.float32), beam_size=1)[0])
    print("Modelo precalentado.")

# ---------- Ajustes ----------
SAMPLE_RATE = 16000
MIN_AUDIO_S = 0.4          # fragmentos más cortos no se transcriben
LANG_LOCK_PROB = 0.85      # confianza mínima de la detección para contar
LANG_LOCK_HITS = 2         # fragmentos seguidos con el mismo idioma para fijarlo
CONTEXT_PROMPT = True      # pasar el texto anterior como initial_prompt
MAX_PROMPT_CHARS = 200
QUEUE_MAX = 4              # fragmentos en espera por sesión antes de descartar los viejos
TRANSLATE_CACHE = 512

# Frases que Whisper inventa en silencio, música o aplausos.
HALLUCINATIONS = re.compile(
    r"^(\W*)("
    r"subt[ií]tulos? (realizados?|por|hechos?) .*amara\.org|"
    r"gracias por (ver|mirar)( el v[ií]deo)?|"
    r"thanks? (you )?for watching|"
    r"suscr[ií]bete.*|subscribe.*|"
    r"¡?m[uú]sica!?|\[m[uú]sica\]|\[music\]|\(music\)|"
    r"you|bye|thank you\.?"
    r")(\W*)$",
    re.IGNORECASE,
)

# ---------- Concurrencia ----------
# Un solo hilo para la GPU: dos transcripciones a la vez se pelean por la VRAM
# y tardan más que en serie.
gpu_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")
# Decodificar audio y traducir son CPU/red: pueden ir en paralelo.
cpu_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="cpu")
mt_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="mt")

# ---------- Traducción ----------
GTX_URL = "https://translate.googleapis.com/translate_a/single"
GTX_LANG = {"zh": "zh-CN"}  # códigos que Google escribe distinto
_http = requests.Session()
_http.headers["User-Agent"] = "Mozilla/5.0"
_mt_cache: "OrderedDict[tuple[str, str], str]" = OrderedDict()
_mt_cache_lock = threading.Lock()


@lru_cache(maxsize=32)
def get_translator(lang: str) -> GoogleTranslator:
    return GoogleTranslator(source="auto", target=GTX_LANG.get(lang, lang))


def _translate_gtx(text: str, lang: str) -> str:
    r = _http.get(
        GTX_URL,
        params={"client": "gtx", "sl": "auto", "tl": GTX_LANG.get(lang, lang), "dt": "t", "q": text},
        timeout=6,
    )
    r.raise_for_status()
    data = r.json()
    return "".join(p[0] for p in data[0] if p and p[0]).strip()


def translate_text(text: str, lang: str) -> str:
    """Traduce un texto. Endpoint JSON de Google con keep-alive; deep-translator de respaldo."""
    text = text.strip()
    if not text:
        return ""
    key = (text, lang)
    with _mt_cache_lock:
        if key in _mt_cache:
            _mt_cache.move_to_end(key)
            return _mt_cache[key]
    try:
        out = _translate_gtx(text, lang)
    except Exception:
        try:
            out = get_translator(lang).translate(text) or ""
        except Exception as e:
            return f"[Error de traducción: {e}]"
    with _mt_cache_lock:
        _mt_cache[key] = out
        if len(_mt_cache) > TRANSLATE_CACHE:
            _mt_cache.popitem(last=False)
    return out


def parse_langs(target_lang: str | None) -> list[str]:
    if not target_lang:
        return []
    langs = [l.strip().lower() for l in target_lang.split(",") if l.strip()]
    for l in langs:
        if not re.fullmatch(r"[a-z]{2,3}(-[a-z]{2,4})?", l):
            raise HTTPException(status_code=400, detail=f"Código de idioma inválido: {l!r}")
    return langs


# ---------- Audio ----------
def decode_chunk(data: bytes) -> np.ndarray | None:
    """webm/opus (u otro contenedor) -> float32 mono 16 kHz, en memoria."""
    try:
        audio = decode_audio(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
    except Exception:
        return None
    if audio is None or len(audio) < MIN_AUDIO_S * SAMPLE_RATE:
        return None
    return audio


# ---------- Transcripción ----------
def transcribe_audio(audio: np.ndarray, language: str | None, initial_prompt: str | None):
    segments_gen, info = model.transcribe(
        audio,
        language=language,                 # si ya se conoce, evita la detección
        initial_prompt=initial_prompt or None,
        beam_size=1,                       # greedy: ~2x más rápido, calidad casi igual en turbo
        vad_filter=True,                   # salta silencios → menos audio que procesar
        vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 200},
        condition_on_previous_text=False,  # evita bucles de repetición
    )
    segments = []
    for s in segments_gen:
        text = s.text.strip()
        if not text:
            continue
        # Alucinación típica: mucha probabilidad de "no hay voz" y poca confianza.
        if s.no_speech_prob > 0.6 and s.avg_logprob < -1.0:
            continue
        if HALLUCINATIONS.match(text):
            continue
        segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
    return segments, info


# ---------- API ----------
app = FastAPI(title="Whisper Turbo API con Traducción")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "device": device, "model": model_size, "ws": "/ws"}


# ----- HTTP (respaldo y compatibilidad con la extensión) -----
@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    target_lang: str | None = Form(None, description="Idioma(s) destino: 'es', 'en,fr'"),
    language: str | None = Form(None, description="Idioma del audio si se conoce (ej: 'en')"),
):
    t0 = time.perf_counter()
    target_languages = parse_langs(target_lang)
    data = await file.read()
    loop = asyncio.get_running_loop()

    try:
        audio = await loop.run_in_executor(cpu_pool, decode_chunk, data)
        if audio is None:
            return {"success": True, "detected_language": language, "language_probability": 0,
                    "audio_duration": 0, "transcription_time": 0,
                    "processing_time": round(time.perf_counter() - t0, 2), "segments": []}

        segments, info = await loop.run_in_executor(gpu_pool, transcribe_audio, audio, language, None)
        t_asr = round(time.perf_counter() - t0, 2)

        if target_languages and segments:
            texts = [s["text"] for s in segments]
            langs_to_fetch = [l for l in target_languages if l != info.language]
            futures = {
                l: asyncio.gather(*(loop.run_in_executor(mt_pool, translate_text, t, l) for t in texts))
                for l in langs_to_fetch
            }
            results = dict(zip(futures.keys(), await asyncio.gather(*futures.values())))
            for i, seg in enumerate(segments):
                seg["translations"] = {
                    l: (seg["text"] if l == info.language else results[l][i])
                    for l in target_languages
                }

        return {
            "success": True,
            "detected_language": info.language,
            "language_probability": round(info.language_probability, 2),
            "audio_duration": round(info.duration, 2),
            "transcription_time": t_asr,
            "processing_time": round(time.perf_counter() - t0, 2),
            "segments": segments,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ----- WebSocket (widget de escritorio) -----
# Protocolo:
#   cliente -> servidor  texto JSON  {"type":"config","target_lang":"es","language":null,"reset":false}
#   cliente -> servidor  binario     un fragmento de audio completo (webm/opus) por mensaje
#   servidor -> cliente  {"type":"ready"|"result"|"empty"|"dropped"|"error", "seq": n, ...}
class Session:
    def __init__(self):
        self.target_lang: str | None = "en"
        self.forced_language: str | None = None   # lo que manda el cliente
        self.locked_language: str | None = None   # lo que fijamos por detección
        self.candidate: str | None = None
        self.hits = 0
        self.prev_text = ""
        self.seq = 0

    @property
    def language(self) -> str | None:
        return self.forced_language or self.locked_language

    def observe(self, info):
        if self.forced_language or self.locked_language:
            return
        if info.language_probability < LANG_LOCK_PROB:
            return
        if info.language == self.candidate:
            self.hits += 1
        else:
            self.candidate, self.hits = info.language, 1
        if self.hits >= LANG_LOCK_HITS:
            self.locked_language = self.candidate

    def apply_config(self, msg: dict):
        if "target_lang" in msg:
            langs = parse_langs(msg.get("target_lang"))
            self.target_lang = langs[0] if langs else None
        if "language" in msg:
            lang = msg.get("language")
            self.forced_language = lang.strip().lower() if lang else None
        if msg.get("reset"):
            self.locked_language = self.candidate = None
            self.hits = 0
            self.prev_text = ""


async def process_loop(ws: WebSocket, s: Session, queue: asyncio.Queue):
    loop = asyncio.get_running_loop()
    while True:
        seq, data = await queue.get()
        t0 = time.perf_counter()
        try:
            audio = await loop.run_in_executor(cpu_pool, decode_chunk, data)
            if audio is None:
                await ws.send_json({"type": "empty", "seq": seq})
                continue

            prompt = s.prev_text if CONTEXT_PROMPT else None
            segments, info = await loop.run_in_executor(
                gpu_pool, transcribe_audio, audio, s.language, prompt
            )
            t_asr = time.perf_counter()
            s.observe(info)

            text = " ".join(seg["text"] for seg in segments).strip()
            if not text:
                await ws.send_json({"type": "empty", "seq": seq})
                continue
            s.prev_text = text[-MAX_PROMPT_CHARS:]

            translation = text
            if s.target_lang and s.target_lang != info.language:
                translation = await loop.run_in_executor(mt_pool, translate_text, text, s.target_lang)
            t_end = time.perf_counter()

            await ws.send_json({
                "type": "result",
                "seq": seq,
                "text": text,
                "translation": translation,
                "language": info.language,
                "language_probability": round(info.language_probability, 2),
                "locked": s.language is not None,
                "audio_s": round(len(audio) / SAMPLE_RATE, 2),
                "asr_ms": int((t_asr - t0) * 1000),
                "mt_ms": int((t_end - t_asr) * 1000),
                "total_ms": int((t_end - t0) * 1000),
                "segments": segments,
            })
        except (WebSocketDisconnect, RuntimeError):
            return
        except Exception as e:
            try:
                await ws.send_json({"type": "error", "seq": seq, "detail": str(e)})
            except Exception:
                return


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    s = Session()
    queue: asyncio.Queue = asyncio.Queue()
    worker = asyncio.create_task(process_loop(ws, s, queue))
    await ws.send_json({"type": "ready", "device": device, "model": model_size})
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes"):
                s.seq += 1
                # Si la GPU va por detrás, descartar lo viejo mantiene el subtítulo en vivo.
                dropped = []
                while queue.qsize() >= QUEUE_MAX:
                    dropped.append(queue.get_nowait()[0])
                if dropped:
                    await ws.send_json({"type": "dropped", "seqs": dropped})
                queue.put_nowait((s.seq, msg["bytes"]))
            elif msg.get("text"):
                try:
                    cfg = json.loads(msg["text"])
                    if cfg.get("type") == "config":
                        s.apply_config(cfg)
                        await ws.send_json({"type": "config_ok", "target_lang": s.target_lang,
                                            "language": s.language})
                    elif cfg.get("type") == "ping":
                        await ws.send_json({"type": "pong"})
                except HTTPException as e:
                    await ws.send_json({"type": "error", "detail": e.detail})
                except Exception as e:
                    await ws.send_json({"type": "error", "detail": str(e)})
    except WebSocketDisconnect:
        pass
    finally:
        worker.cancel()


# ---------- Servidor ----------
os.system("fuser -k 8000/tcp > /dev/null 2>&1")


def run():
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning", ws_ping_interval=20, ws_ping_timeout=20)


threading.Thread(target=run, daemon=True).start()
print("Servidor FastAPI iniciado en el puerto 8000 (HTTP /transcribe + WebSocket /ws).")

# ==========================================
# CELDA 3: Exposición mediante Cloudflare
# ==========================================
# Se lanza como subproceso para capturar la URL pública y mostrarla limpia,
# en lugar de buscarla entre los logs. Los túneles rápidos soportan WebSocket.
proc = subprocess.Popen(
    ["cloudflared", "tunnel", "--url", "http://localhost:8000", "--no-autoupdate"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)
public_url = None
for line in proc.stdout:
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if m:
        public_url = m.group(0)
        break
print(f"\n✅ URL pública: {public_url}")
print(f"   Pegar en el widget: {public_url}/transcribe")
print(f"   WebSocket (lo deriva el widget solo): {public_url.replace('https://', 'wss://')}/ws\n")

"""Modelo Whisper + API FastAPI (HTTP /transcribe y WebSocket /ws).

Qué hace y por qué:
  - /ws (WebSocket): una sola conexión por sesión de escucha. Se ahorra el
    handshake TCP+TLS por el túnel en cada fragmento (100-300 ms) y la subida
    del fragmento N+1 se solapa con la transcripción del N.
  - Idioma fijado por sesión: tras 2 fragmentos con detección segura se deja
    de detectar (ahorra una pasada del encoder y evita que un fragmento corto
    "cambie" de idioma y la traducción se salte).
  - Contexto entre fragmentos: el texto anterior se pasa como initial_prompt
    para que nombres, mayúsculas y puntuación sean coherentes.
  - Decodificación en memoria (PyAV), sin archivo temporal ni ffmpeg externo.
  - Filtro de alucinaciones típicas de Whisper en fragmentos con música/ruido.
  - Si la GPU se queda atrás, se descartan los fragmentos más viejos para que
    el subtítulo siga "en vivo" en lugar de acumular retraso.
  - /transcribe (HTTP) se mantiene: el widget cae a él si el WebSocket falla.
"""
import asyncio
import io
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import cuda_libs

cuda_libs.preload()  # antes de importar torch/ctranslate2

import numpy as np  # noqa: E402
import torch  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import (  # noqa: E402
    FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
from faster_whisper.audio import decode_audio  # noqa: E402

from .cache import find_model  # noqa: E402
from .translate import translate_or_original  # noqa: E402

# ---------- Ajustes ----------
SAMPLE_RATE = 16000
MIN_AUDIO_S = 0.4          # fragmentos más cortos no se transcriben
LANG_LOCK_PROB = 0.85      # confianza mínima de la detección para contar
LANG_LOCK_HITS = 2         # fragmentos seguidos con el mismo idioma para fijarlo
CONTEXT_PROMPT = True      # pasar el texto anterior como initial_prompt
MAX_PROMPT_CHARS = 200
QUEUE_MAX = 4              # fragmentos en espera por sesión antes de descartar los viejos

# Frases que Whisper inventa en silencio/música. Los "Error 500" ya no pueden
# venir de la traducción (ver translate._validar), pero se dejan por si el modelo los inventa.
HALLUCINATIONS = re.compile(
    r"^[\W\d]*("
    r"subt[ií]tulos? (realizados?|por|hechos?) .*amara\.org|"
    r"gracias por (ver|mirar)( el v[ií]deo)?|"
    r"thanks? (you )?for watching|"
    r"suscr[ií]bete.*|subscribe.*|"
    r"¡?m[uú]sica!?|\[m[uú]sica\]|\[music\]|\(music\)|"
    r"you|bye|thank you\.?|"
    r"error\s*[45]\d{2}|"
    r"internal server error|"
    r"that['’]?s an error|"
    r"that is an error|"
    r"eso es un error|"
    r"\[error[^\]]*\]"
    r")[\W\d]*$",
    re.IGNORECASE,
)

# ---------- Estado del modelo (lo rellena start()) ----------
model: WhisperModel | None = None
model_size = "turbo"
device = "cpu"
compute_type = "int8"

# ---------- Concurrencia ----------
# Un solo hilo para la GPU: dos transcripciones a la vez se pelean por la VRAM
# y tardan más que en serie.
gpu_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")
# Decodificar audio y traducir son CPU/red: pueden ir en paralelo.
cpu_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="cpu")
mt_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="mt")


# ---------- Hardware ----------
def _load_whisper(name_or_path: str):
    """Elige device/compute_type según la GPU y reintenta si CTranslate2 los rechaza.

    CTranslate2 solo hace float16 eficiente en Volta+ (sm_70: T4, V100, A100…).
    La Tesla P100 de Kaggle es Pascal (sm_60): float16 lanza ValueError. Usar int8 / float32.
    """
    candidates = []
    if torch.cuda.is_available():
        name = torch.cuda.get_device_name(0)
        major, minor = torch.cuda.get_device_capability(0)
        print(f"GPU detectada: {name} (sm_{major}{minor})")
        if major >= 7:
            candidates.append(("cuda", "float16"))
        else:
            print(
                f"Esta GPU (compute {major}.{minor}) no soporta float16 eficiente. "
                "En Kaggle, si puedes, cambia el acelerador a GPU T4."
            )
        # int8_float16 también exige sm_70+; en P100 hay que usar int8/float32.
        candidates.extend([("cuda", "int8"), ("cuda", "int8_float32"), ("cuda", "float32")])
    candidates.append(("cpu", "int8"))

    last_err = None
    seen = set()
    for dev, ctype in candidates:
        if (dev, ctype) in seen:
            continue
        seen.add((dev, ctype))
        try:
            print(f"Cargando modelo: {name_or_path} en {dev} ({ctype})...")
            loaded = WhisperModel(name_or_path, device=dev, compute_type=ctype)
            print(f"Modelo cargado en {dev} ({ctype}).")
            return loaded, dev, ctype
        except (ValueError, RuntimeError) as err:
            print(f"  No usable {dev}/{ctype}: {err}")
            last_err = err
    raise last_err


def load_model(size: str = "turbo", warmup: bool = True):
    """Carga el modelo (desde la caché local si existe) y precalienta CUDA."""
    global model, model_size, device, compute_type
    model_size = size
    local = find_model(size)
    if local:
        print(f"Modelo {size} en caché local: {local}")
    model, device, compute_type = _load_whisper(local or size)
    print(f"¿Usando GPU?: {'SÍ' if device == 'cuda' else 'NO (Usando CPU)'}")
    if warmup:
        # La primera inferencia es lenta (carga de kernels CUDA).
        # Si el kernel muere aquí, el problema es cuDNN/CUDA, no el servidor.
        print("Precalentando (si el kernel se reinicia aquí, usa start(warmup=False) y revisa cuDNN)...")
        _ = list(model.transcribe(np.zeros(16000, dtype=np.float32), beam_size=1)[0])
        print("Modelo precalentado.")
    return model


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
        if s.compression_ratio > 2.4:
            continue
        if HALLUCINATIONS.match(text):
            continue
        segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
    return segments, info


def parse_langs(target_lang: str | None) -> list[str]:
    if not target_lang:
        return []
    langs = [l.strip().lower() for l in target_lang.split(",") if l.strip()]
    for l in langs:
        if not re.fullmatch(r"[a-z]{2,3}(-[a-z]{2,4})?", l):
            raise HTTPException(status_code=400, detail=f"Código de idioma inválido: {l!r}")
    return langs


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

        mt_error = None
        if target_languages and segments:
            texts = [s["text"] for s in segments]
            langs_to_fetch = [l for l in target_languages if l != info.language]
            futures = {
                l: asyncio.gather(*(loop.run_in_executor(mt_pool, translate_or_original, t, l) for t in texts))
                for l in langs_to_fetch
            }
            results = dict(zip(futures.keys(), await asyncio.gather(*futures.values())))
            for i, seg in enumerate(segments):
                seg["translations"] = {
                    l: (seg["text"] if l == info.language else results[l][i][0])
                    for l in target_languages
                }
            mt_error = next((err for pairs in results.values() for _, err in pairs if err), None)

        resp = {
            "success": True,
            "detected_language": info.language,
            "language_probability": round(info.language_probability, 2),
            "audio_duration": round(info.duration, 2),
            "transcription_time": t_asr,
            "processing_time": round(time.perf_counter() - t0, 2),
            "segments": segments,
        }
        if mt_error:
            resp["mt_error"] = mt_error  # el cliente muestra el original y avisa en su log
        return resp
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ----- WebSocket (widget de escritorio) -----
# Protocolo:
#   cliente -> servidor  texto JSON  {"type":"config","target_lang":"es","language":null,"reset":false}
#   cliente -> servidor  binario     un fragmento de audio completo (webm/opus) por mensaje
#   servidor -> cliente  {"type":"ready"|"result"|"empty"|"dropped"|"error", "seq": n, ...}
#   En "result", si la traducción falló, "translation" es el original y "mt_error" el motivo.
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

            translation, mt_error = text, None
            if s.target_lang and s.target_lang != info.language:
                translation, mt_error = await loop.run_in_executor(
                    mt_pool, translate_or_original, text, s.target_lang
                )
            if HALLUCINATIONS.match(translation):
                await ws.send_json({"type": "empty", "seq": seq, "reason": "filtered"})
                continue
            t_end = time.perf_counter()

            await ws.send_json({
                "type": "result",
                "seq": seq,
                "text": text,
                "translation": translation,
                **({"mt_error": mt_error} if mt_error else {}),
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
def serve(port: int = 8000):
    """Arranca uvicorn en un hilo daemon (deja libre la celda del notebook)."""
    os.system(f"fuser -k {port}/tcp > /dev/null 2>&1")

    def run():
        uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning",
                    ws_ping_interval=20, ws_ping_timeout=20)

    threading.Thread(target=run, daemon=True).start()
    print(f"Servidor FastAPI iniciado en el puerto {port} (HTTP /transcribe + WebSocket /ws).")


def start(size: str = "turbo", warmup: bool = True, port: int = 8000):
    """Todo en uno para el notebook: modelo + warm-up + servidor."""
    load_model(size, warmup=warmup)
    serve(port)

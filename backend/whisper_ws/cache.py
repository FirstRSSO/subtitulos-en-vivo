"""Localiza la caché de arranque rápido (modelo, wheels, cloudflared).

Estructura que genera build_cache.py y se sube como Kaggle Dataset (o se deja
en Google Drive para Colab):

    <cache>/
      model/<nombre>/      pesos CTranslate2 del modelo (p. ej. model/turbo/)
      wheels/*.whl         dependencias de Python
      cloudflared          binario linux-amd64

Se busca, por orden: la variable WHISPER_WS_CACHE, cualquier dataset de Kaggle
montado en /kaggle/input/* que tenga la carpeta "model" o "wheels", y
/content/drive/MyDrive/whisper_ws_cache (Colab con Drive montado).
"""
import glob
import os

CANDIDATES = [
    "/content/drive/MyDrive/whisper_ws_cache",
]


def find_cache() -> str | None:
    env = os.environ.get("WHISPER_WS_CACHE")
    if env:
        return env if os.path.isdir(env) else None
    for d in sorted(glob.glob("/kaggle/input/*")) + CANDIDATES:
        if os.path.isdir(os.path.join(d, "model")) or os.path.isdir(os.path.join(d, "wheels")):
            return d
    return None


def find_model(size: str) -> str | None:
    """Ruta local del modelo si está en la caché (debe contener model.bin)."""
    cache = find_cache()
    if not cache:
        return None
    path = os.path.join(cache, "model", size)
    return path if os.path.isfile(os.path.join(path, "model.bin")) else None

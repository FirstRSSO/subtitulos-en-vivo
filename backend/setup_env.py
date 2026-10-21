"""Celda 1 del notebook: deja el entorno listo en Colab/Kaggle.

    %run subtitulos-en-vivo/backend/setup_env.py

Si hay una caché de arranque rápido (Kaggle Dataset generado con build_cache.py,
o la misma carpeta en Google Drive), instala las dependencias desde sus wheels
y copia cloudflared de ahí: segundos en vez de minutos. Si no, lo descarga todo
de internet como siempre. Solo usa la biblioteca estándar: se ejecuta antes de
instalar nada.
"""
import importlib.metadata
import os
import shutil
import subprocess
import sys
import time
import urllib.request

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from whisper_ws.cache import find_cache  # noqa: E402  (solo stdlib)

PACKAGES = ["faster-whisper", "fastapi", "uvicorn[standard]", "python-multipart", "requests"]
# CTranslate2 necesita cuDNN 9 + cuBLAS 12. Colab a veces trae otra versión y el
# kernel muere sin traceback en la primera inferencia. Kaggle suele traer la buena.
CUDA_PACKAGES = ["nvidia-cudnn-cu12>=9", "nvidia-cublas-cu12"]
CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
CLOUDFLARED_BIN = "/usr/local/bin/cloudflared"


def _pip(*args) -> bool:
    cmd = [sys.executable, "-m", "pip", "install", "-q", *args]
    return subprocess.run(cmd).returncode == 0


def _needs_cuda_libs() -> bool:
    try:
        major = int(importlib.metadata.version("nvidia-cudnn-cu12").split(".")[0])
    except (importlib.metadata.PackageNotFoundError, ValueError):
        return True
    if major >= 9:
        print(f"cuDNN {major}.x ya instalado.")
        return False
    return True


def install_python(cache: str | None):
    pkgs = PACKAGES + (CUDA_PACKAGES if _needs_cuda_libs() else [])
    wheels = os.path.join(cache, "wheels") if cache else None
    if wheels and os.path.isdir(wheels):
        print(f"Instalando desde wheels locales: {wheels}")
        if _pip("--no-index", "--find-links", wheels, *pkgs):
            return
        print("Faltan wheels en la caché (¿otra versión de Python?); se instala de internet.")
    print("Instalando dependencias de internet...")
    if not _pip(*pkgs):
        raise SystemExit("pip install falló")


def install_cloudflared(cache: str | None):
    if shutil.which("cloudflared"):
        return
    local = os.path.join(cache, "cloudflared") if cache else None
    if local and os.path.isfile(local):
        print(f"Copiando cloudflared desde {local}")
        shutil.copyfile(local, CLOUDFLARED_BIN)
    else:
        print("Descargando cloudflared...")
        urllib.request.urlretrieve(CLOUDFLARED_URL, CLOUDFLARED_BIN)
    os.chmod(CLOUDFLARED_BIN, 0o755)


def main():
    t0 = time.perf_counter()
    cache = find_cache()
    print(f"Caché de arranque rápido: {cache or 'no encontrada (se descargará todo)'}")
    install_python(cache)
    install_cloudflared(cache)
    subprocess.run(["cloudflared", "--version"])
    print(f"Entorno listo en {time.perf_counter() - t0:.0f} s. "
          f"Python {sys.version_info.major}.{sys.version_info.minor}")


main()

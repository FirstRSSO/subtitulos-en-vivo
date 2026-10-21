"""Genera la caché de arranque rápido para subirla como Kaggle Dataset.

    python build_cache.py                       # ./whisper_ws_cache, modelo turbo, Python 3.13
    python build_cache.py --cuda-libs           # añade cuDNN/cuBLAS (~1 GB) para Colab
    python build_cache.py --python 3.12         # si Kaggle cambia de versión (ver !python -V; hoy 3.13)
    python build_cache.py --kaggle-user USUARIO # rellena dataset-metadata.json

Requiere: pip y el paquete huggingface_hub (pip install huggingface_hub).

Resultado:
    whisper_ws_cache/
      model/turbo/         pesos CTranslate2 (~1,6 GB)
      wheels/*.whl         faster-whisper, fastapi, uvicorn… para linux x86_64
      cloudflared          binario
      dataset-metadata.json

Subida (una sola vez; luego solo se actualiza si cambia algo):
    pip install kaggle   # y el token en ~/.kaggle/kaggle.json
    kaggle datasets create -p whisper_ws_cache --dir-mode zip
    # actualizaciones: kaggle datasets version -p whisper_ws_cache -m "..." --dir-mode zip
O desde la web: kaggle.com → Datasets → New Dataset → arrastrar la carpeta.
Después, en el notebook: Add Input → Datasets → whisper-ws-cache.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request

# Mismo mapa que faster_whisper.utils._MODELS (solo los tamaños que interesan).
MODELS = {
    "turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
    "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v2": "Systran/faster-whisper-large-v2",
    "medium": "Systran/faster-whisper-medium",
    "small": "Systran/faster-whisper-small",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
}
MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]
PACKAGES = ["faster-whisper", "av<19", "fastapi", "uvicorn[standard]", "python-multipart", "requests"]
CUDA_PACKAGES = ["nvidia-cudnn-cu12>=9", "nvidia-cublas-cu12"]
PLATFORMS = [
    "manylinux2014_x86_64", "manylinux_2_17_x86_64", "manylinux_2_24_x86_64",
    "manylinux_2_28_x86_64", "manylinux_2_31_x86_64", "manylinux_2_34_x86_64",
    "manylinux_2_35_x86_64", "linux_x86_64",
]
CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"


def download_model(name: str, out: str):
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        raise SystemExit("Falta huggingface_hub: pip install huggingface_hub")
    repo = MODELS.get(name)
    if not repo:
        raise SystemExit(f"Modelo desconocido {name!r}; opciones: {', '.join(MODELS)}")
    dest = os.path.join(out, "model", name)
    print(f"Modelo {name} ({repo}) -> {dest}")
    snapshot_download(repo, local_dir=dest, allow_patterns=MODEL_FILES)
    # huggingface_hub deja una carpeta .cache con locks y metadatos; no hace falta subirla.
    shutil.rmtree(os.path.join(dest, ".cache"), ignore_errors=True)


def download_wheels(python: str, cuda_libs: bool, out: str):
    dest = os.path.join(out, "wheels")
    abi = "cp" + python.replace(".", "")
    cmd = [sys.executable, "-m", "pip", "download", "-d", dest,
           "--python-version", python, "--implementation", "cp", "--abi", abi, "--abi", "abi3",
           "--abi", "none", "--only-binary=:all:"]
    for p in PLATFORMS:
        cmd += ["--platform", p]
    cmd += PACKAGES + (CUDA_PACKAGES if cuda_libs else [])
    print(f"Wheels para Python {python} -> {dest}")
    subprocess.run(cmd, check=True)


def download_cloudflared(out: str):
    dest = os.path.join(out, "cloudflared")
    print(f"cloudflared -> {dest}")
    urllib.request.urlretrieve(CLOUDFLARED_URL, dest)
    os.chmod(dest, 0o755)


def write_metadata(out: str, user: str | None):
    meta = {
        "title": "whisper-ws-cache",
        "id": f"{user or '<usuario-kaggle>'}/whisper-ws-cache",
        "licenses": [{"name": "CC0-1.0"}],
    }
    with open(os.path.join(out, "dataset-metadata.json"), "w") as f:
        json.dump(meta, f, indent=2)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="whisper_ws_cache")
    ap.add_argument("--model", default="turbo")
    ap.add_argument("--python", default="3.13", help="versión de Python del notebook (Kaggle: !python -V)")
    ap.add_argument("--cuda-libs", action="store_true", help="incluir cuDNN/cuBLAS (~1 GB, hace falta en Colab)")
    ap.add_argument("--kaggle-user", default=None)
    ap.add_argument("--skip-model", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    if not args.skip_model:
        download_model(args.model, args.out)
    download_wheels(args.python, args.cuda_libs, args.out)
    download_cloudflared(args.out)
    write_metadata(args.out, args.kaggle_user)
    total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(args.out) for f in fs)
    print(f"\nListo: {args.out} ({total / 1e9:.2f} GB). Súbelo como Dataset de Kaggle "
          f"(ver la cabecera de este script) y añádelo al notebook con 'Add Input'.")


if __name__ == "__main__":
    main()

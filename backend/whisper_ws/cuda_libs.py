"""Carga cuDNN/cuBLAS instaladas por pip antes de importar torch/ctranslate2.

CTranslate2 (motor de faster-whisper) necesita cuDNN 9 + cuBLAS 12. Si el entorno
trae otra versión, el kernel muere sin traceback en la primera inferencia.
"""
import ctypes
import os


def preload() -> list[str]:
    """Añade las libs de los paquetes nvidia.* al proceso. Devuelve los directorios usados."""
    try:
        import nvidia.cudnn, nvidia.cublas  # noqa: E401
    except ImportError:
        return []
    # Son namespace packages (sin __init__.py): __file__ es None, se usa __path__.
    libs = [os.path.join(list(m.__path__)[0], "lib") for m in (nvidia.cudnn, nvidia.cublas)]
    libs = [d for d in libs if os.path.isdir(d)]
    os.environ["LD_LIBRARY_PATH"] = ":".join(libs + [os.environ.get("LD_LIBRARY_PATH", "")])
    for d in libs:
        for f in sorted(os.listdir(d)):
            if f.endswith(".so") or ".so." in f:
                try:
                    ctypes.CDLL(os.path.join(d, f), mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
    return libs

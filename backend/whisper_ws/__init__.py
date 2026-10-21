"""Backend de subtítulos en vivo: Whisper (faster-whisper) + traducción + API.

Uso en Colab/Kaggle (ver colab_whisper_ws.ipynb):

    from whisper_ws import start, open_tunnel
    start()          # carga el modelo (local si hay caché), precalienta y arranca el servidor
    open_tunnel()    # imprime la URL https://….trycloudflare.com

Los submódulos se importan al usarlos: setup_env.py importa whisper_ws.cache
antes de que existan torch o faster-whisper.
"""
__all__ = ["start", "open_tunnel"]


def __getattr__(name):
    if name == "start":
        from .server import start
        return start
    if name == "open_tunnel":
        from .tunnel import open_tunnel
        return open_tunnel
    raise AttributeError(name)

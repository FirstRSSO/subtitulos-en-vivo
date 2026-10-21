"""Backend de subtítulos en vivo: Whisper (faster-whisper) + traducción + API.

Uso en Colab/Kaggle (ver colab_whisper_ws.ipynb):

    from whisper_ws import start, open_tunnel, publish, wait_until_idle
    start()                     # modelo (local si hay caché), warm-up, servidor en :8000
    url = open_tunnel()         # https://….trycloudflare.com
    publish(url)                # la escribe en el gist (si hay GITHUB_TOKEN/GIST_ID)
    wait_until_idle()           # mantiene vivo el notebook hasta que nadie lo use

Los submódulos se importan al usarlos: setup_env.py importa whisper_ws.cache
antes de que existan torch o faster-whisper.
"""
__all__ = ["start", "open_tunnel", "publish", "wait_until_idle", "run"]


def run(size: str = "turbo", idle_min: float = 10, **kw):
    """Todo en una celda: start + open_tunnel + publish + wait_until_idle."""
    from .server import start, wait_until_idle, device, model_size  # noqa: F401
    from . import server
    from .tunnel import open_tunnel
    from .publish import publish
    start(size, **kw)
    url = open_tunnel()
    publish(url, device=server.device, model=server.model_size)
    wait_until_idle(idle_min, on_exit=lambda: publish(None))


def __getattr__(name):
    if name in ("start", "wait_until_idle"):
        from . import server
        return getattr(server, name)
    if name == "open_tunnel":
        from .tunnel import open_tunnel
        return open_tunnel
    if name == "publish":
        from .publish import publish
        return publish
    raise AttributeError(name)

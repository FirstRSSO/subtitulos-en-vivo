"""Publica la URL del túnel en un Gist de GitHub para que el widget la encuentre solo.

Los túneles rápidos de Cloudflare cambian de dominio en cada sesión. En vez de
copiar la URL a mano, el notebook la escribe en un gist (archivo whisper_ws.json)
y el widget la lee de ahí. Hace falta:

  GITHUB_TOKEN  token "fine-grained" con permiso Gists: read and write
  GIST_ID       id del gist (la parte final de https://gist.github.com/usuario/<id>)

En Kaggle se guardan como Secrets (Add-ons → Secrets) y se adjuntan al
notebook; en Colab/local valen como variables de entorno. Sin ellos no se
publica nada y se sigue como antes (URL impresa en la celda).
"""
import json
import os
import time

import requests

GIST_FILE = "whisper_ws.json"


def _secret(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    try:
        from kaggle_secrets import UserSecretsClient  # solo existe en Kaggle
        return UserSecretsClient().get_secret(name)
    except Exception:
        return None


def publish(url: str | None, **extra) -> bool:
    """Escribe {"url": ..., "status": "up"|"down", ...} en el gist. Devuelve si se publicó."""
    token, gist_id = _secret("GITHUB_TOKEN"), _secret("GIST_ID")
    if not token or not gist_id:
        print("[gist] sin GITHUB_TOKEN/GIST_ID: no se publica la URL (pégala a mano en el widget).")
        return False
    payload = {
        "url": url,
        "status": "up" if url else "down",
        "updated": int(time.time()),
        **extra,
    }
    try:
        r = requests.patch(
            f"https://api.github.com/gists/{gist_id}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
            json={"files": {GIST_FILE: {"content": json.dumps(payload, indent=2)}}},
            timeout=15,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"[gist] no se pudo publicar: {e}")
        return False
    print(f"[gist] publicado status={payload['status']} url={url}")
    return True

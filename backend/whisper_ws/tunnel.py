"""Túnel público con cloudflared (los túneles rápidos soportan WebSocket)."""
import re
import subprocess

_proc = None


def open_tunnel(port: int = 8000) -> str:
    """Lanza cloudflared como subproceso y devuelve la URL pública (también la imprime)."""
    global _proc
    if _proc and _proc.poll() is None:
        _proc.terminate()
    _proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://localhost:{port}", "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    public_url = None
    for line in _proc.stdout:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m:
            public_url = m.group(0)
            break
    if not public_url:
        raise RuntimeError("cloudflared terminó sin dar una URL pública")
    print(f"\n✅ URL pública: {public_url}")
    print(f"   Pegar en el widget: {public_url}/transcribe")
    print(f"   WebSocket (lo deriva el widget solo): {public_url.replace('https://', 'wss://')}/ws\n")
    return public_url

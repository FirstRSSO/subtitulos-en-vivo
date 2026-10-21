"""Traducción por las puertas no oficiales de Google Translate, con caché y cuarentena.

Google Translate no tiene API gratuita oficial; se usan tres puertas, en orden.
La que falla queda en cuarentena MT_COOLDOWN_S segundos para no pagar su
latencia en cada fragmento:
  gtx       translate.googleapis.com  JSON, la más rápida. Contesta 429 "Sorry"
            cuando la IP pasa el límite (las de Colab/Kaggle son compartidas).
  clients5  clients5.google.com       JSON, con un límite independiente.
  m         translate.google.com/m    HTML. Con User-Agent de python contesta
            HTTP 200 con una página "Error 500" DENTRO del div de resultado;
            deep-translator la devolvía tal cual como traducción. Con User-Agent
            de navegador funciona.
Toda respuesta pasa por _validar(): una página de error de Google nunca
llega al subtítulo.
"""
import html
import re
import threading
import time
from collections import OrderedDict

import requests

GTX_LANG = {"zh": "zh-CN"}  # códigos que Google escribe distinto
MT_TIMEOUT = 6
MT_COOLDOWN_S = 60          # segundos sin volver a probar una puerta que falló
TRANSLATE_CACHE = 512

_http = requests.Session()
_http.headers["User-Agent"] = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
_mt_cache: "OrderedDict[tuple[str, str], str]" = OrderedDict()
_mt_cache_lock = threading.Lock()
_mt_down: dict[str, float] = {}  # puerta -> instante (monotonic) hasta el que se omite
_M_RESULT = re.compile(r'class="result-container">(.*?)</div>', re.S)
_HTML_TAG = re.compile(r"<[^>]+>")
# Firmas de la página de error de Google (título "Error 500 (Server Error)!!1",
# "That's all we know.", id del div). Deliberadamente estrechas: "that's an error"
# a secas puede ser una frase real.
_GOOGLE_ERROR_PAGE = re.compile(r"af-error-page|\berror \d{3} \(|that['’]s all we know", re.I)


class TranslationError(Exception):
    pass


def _get(url: str, params: dict) -> requests.Response:
    try:
        r = _http.get(url, params=params, timeout=MT_TIMEOUT)
    except requests.RequestException as e:
        raise TranslationError(type(e).__name__) from e
    if r.status_code != 200:
        raise TranslationError(f"HTTP {r.status_code}")
    return r


def _mt_gtx(text: str, lang: str) -> str:
    r = _get("https://translate.googleapis.com/translate_a/single",
             {"client": "gtx", "sl": "auto", "tl": lang, "dt": "t", "q": text})
    return "".join(p[0] for p in r.json()[0] if p and p[0])


def _mt_clients5(text: str, lang: str) -> str:
    r = _get("https://clients5.google.com/translate_a/t",
             {"client": "dict-chrome-ex", "sl": "auto", "tl": lang, "q": text})
    first = r.json()[0]  # [["traducción", "idioma detectado"]]; ["traducción"] si sl es fijo
    return first[0] if isinstance(first, list) else first


def _mt_mobile(text: str, lang: str) -> str:
    r = _get("https://translate.google.com/m", {"sl": "auto", "tl": lang, "q": text})
    m = _M_RESULT.search(r.text)
    if not m:
        raise TranslationError("sin div de resultado")
    return html.unescape(_HTML_TAG.sub("", m.group(1)))


MT_BACKENDS = (("gtx", _mt_gtx), ("clients5", _mt_clients5), ("m", _mt_mobile))


def _validar(out: str) -> str:
    out = out.strip()
    if not out:
        raise TranslationError("respuesta vacía")
    if _GOOGLE_ERROR_PAGE.search(out):
        raise TranslationError("página de error de Google como traducción")
    return out


def translate_text(text: str, lang: str) -> str:
    """Traduce probando las puertas en orden. Lanza TranslationError si ninguna sirve."""
    text = text.strip()
    if not text:
        return ""
    lang = GTX_LANG.get(lang, lang)
    key = (text, lang)
    with _mt_cache_lock:
        if key in _mt_cache:
            _mt_cache.move_to_end(key)
            return _mt_cache[key]
    now = time.monotonic()
    backends = [b for b in MT_BACKENDS if _mt_down.get(b[0], 0) <= now]
    if not backends:
        # Todas en cuarentena (p. ej. un corte de red): se reintenta solo la que
        # falló hace más tiempo, para recuperar pronto sin pagar tres timeouts.
        backends = [min(MT_BACKENDS, key=lambda b: _mt_down.get(b[0], 0))]
    errors = []
    for name, fn in backends:
        was_down = _mt_down.get(name, 0) > now
        try:
            out = _validar(fn(text, lang))
        except Exception as e:
            _mt_down[name] = time.monotonic() + MT_COOLDOWN_S
            errors.append(f"{name}: {e}")
            if not was_down:
                print(f"[traducción] {name} falló ({e}); en cuarentena {MT_COOLDOWN_S} s")
            continue
        if was_down:
            _mt_down.pop(name, None)
            print(f"[traducción] {name} vuelve a funcionar")
        with _mt_cache_lock:
            _mt_cache[key] = out
            if len(_mt_cache) > TRANSLATE_CACHE:
                _mt_cache.popitem(last=False)
        return out
    raise TranslationError("; ".join(errors))


def translate_or_original(text: str, lang: str) -> tuple[str, str | None]:
    """Lo que ven los clientes: nunca un error como subtítulo, sino (original, motivo)."""
    try:
        return translate_text(text, lang), None
    except TranslationError as e:
        return text, str(e)

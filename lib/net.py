"""Работа с внешними API на urllib: без requests и прочих пакетов.

Здесь же общая очередь к CoinGecko: у публичного API лимит порядка 5-15
запросов в минуту, поэтому все обращения идут по одному с паузой и повтором
на 429. Ни один источник не должен ронять сервер, поэтому наружу отдаются
исключения, а вызывающий код решает, что показать вместо данных.
"""

from __future__ import annotations

import gzip
import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

USER_AGENT = "crypto-agent/1.0 (python)"

# У части хостов на старых системах цепочка сертификатов не проверяется —
# создаём контекст один раз и не отключаем проверку.
_ssl_context = ssl.create_default_context()


class HttpError(Exception):
    def __init__(self, status: int, url: str, body: str = ""):
        super().__init__("HTTP %s: %s" % (status, url.split("?")[0]))
        self.status = status
        self.url = url
        self.body = body


def fetch_text(url: str, timeout: float = 20.0, headers: Optional[Dict[str, str]] = None,
               method: str = "GET", data: Optional[bytes] = None) -> str:
    req = urllib.request.Request(url, method=method, data=data)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept-Encoding", "gzip")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return raw.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            raw = e.read()
            if e.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            body = raw.decode("utf-8", errors="replace")[:400]
        except Exception:
            pass
        raise HttpError(e.code, url, body)
    except Exception as e:
        raise HttpError(0, url, str(e))


def fetch_json(url: str, timeout: float = 20.0, headers: Optional[Dict[str, str]] = None,
               method: str = "GET", payload: Optional[Any] = None) -> Any:
    data = None
    hdrs = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    hdrs.setdefault("Accept", "application/json")
    return json.loads(fetch_text(url, timeout=timeout, headers=hdrs, method=method, data=data))


# ————— CoinGecko: одна очередь на весь процесс —————

CG_BASE = os.environ.get("COINGECKO_API_URL", "https://api.coingecko.com/api/v3")
_cg_lock = threading.Lock()
_cg_last = [0.0]
RETRY_DELAYS = (5.0, 12.0)


def _cg_key() -> str:
    return os.environ.get("COINGECKO_API_KEY", "")


def cg_gap() -> float:
    return 0.12 if _cg_key() else 0.45


def cg_get(path: str, params: Optional[Dict[str, str]] = None, timeout: float = 20.0) -> Any:
    """Запрос к CoinGecko: очередь, пауза между вызовами и повтор на 429."""
    qs = dict(params or {})
    key = _cg_key()
    if key:
        qs["x_cg_demo_api_key"] = key
    url = CG_BASE + path
    if qs:
        url += "?" + urllib.parse.urlencode(qs)

    last_error: Optional[Exception] = None
    for attempt in range(len(RETRY_DELAYS) + 1):
        with _cg_lock:
            wait = cg_gap() - (time.time() - _cg_last[0])
            if wait > 0:
                time.sleep(wait)
            try:
                result = fetch_json(url, timeout=timeout)
                _cg_last[0] = time.time()
                return result
            except HttpError as e:
                _cg_last[0] = time.time()
                last_error = e
                if e.status != 429 or attempt == len(RETRY_DELAYS):
                    raise
        time.sleep(RETRY_DELAYS[attempt])
    raise last_error if last_error else HttpError(0, url)


def run_parallel(tasks: Dict[str, Any], timeout: float = 60.0) -> Dict[str, Any]:
    """Выполняет словарь «имя -> функция» в потоках. Упавшие возвращают None."""
    results: Dict[str, Any] = {}
    errors: Dict[str, str] = {}

    def worker(name: str, fn) -> None:
        try:
            results[name] = fn()
        except Exception as e:  # источник упал — не роняем остальные
            results[name] = None
            errors[name] = str(e)

    threads = [threading.Thread(target=worker, args=(n, f), daemon=True) for n, f in tasks.items()]
    for t in threads:
        t.start()
    deadline = time.time() + timeout
    for t in threads:
        t.join(max(0.1, deadline - time.time()))
    results["_errors"] = errors
    return results

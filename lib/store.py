"""Хранилище на файлах: портфель, настройки, история и кэши источников.

База данных не нужна — это личная установка. Запись идёт через временный файл
с уникальным именем и переименование, а блокировка по имени файла не даёт
двум потокам затереть работу друг друга.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Callable, Dict, Optional, TypeVar

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# На хостинге постоянный диск монтируется в стороннюю папку, а файлы проекта
# при пересборке затираются — поэтому каталог данных можно задать переменной.
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(ROOT, "data")
CACHE_DIR = os.path.join(DATA_DIR, "cache")

T = TypeVar("T")

_locks: Dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_seq = 0


def ensure_dirs() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)


def _lock_for(name: str) -> threading.Lock:
    with _locks_guard:
        if name not in _locks:
            _locks[name] = threading.Lock()
        return _locks[name]


def _path(name: str, cache: bool = False) -> str:
    return os.path.join(CACHE_DIR if cache else DATA_DIR, name)


def read_json(name: str, fallback: T, cache: bool = False) -> T:
    try:
        with open(_path(name, cache), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def write_json(name: str, value: Any, cache: bool = False) -> None:
    global _seq
    ensure_dirs()
    with _lock_for(name):
        _seq += 1
        target = _path(name, cache)
        tmp = "%s.%d.%d.tmp" % (target, os.getpid(), _seq)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
        os.replace(tmp, target)


def update_json(name: str, fallback: T, mutate: Callable[[T], T], cache: bool = False) -> T:
    """Чтение и запись под одной блокировкой: иначе два быстрых сохранения теряются."""
    global _seq
    ensure_dirs()
    with _lock_for(name):
        try:
            with open(_path(name, cache), "r", encoding="utf-8") as f:
                current = json.load(f)
        except Exception:
            current = fallback
        nxt = mutate(current)
        _seq += 1
        target = _path(name, cache)
        tmp = "%s.%d.%d.tmp" % (target, os.getpid(), _seq)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(nxt, f, ensure_ascii=False, indent=2)
        os.replace(tmp, target)
        return nxt


def cached(name: str, ttl_seconds: float, loader: Callable[[], Any]) -> Any:
    """Кэш на диске. Источник упал, а прошлое значение есть — отдаём его."""
    box = read_json(name, None, cache=True)
    fresh = isinstance(box, dict) and "at" in box and (time.time() - box["at"]) < ttl_seconds
    if fresh:
        return box.get("value")
    try:
        value = loader()
        write_json(name, {"at": time.time(), "value": value}, cache=True)
        return value
    except Exception:
        if isinstance(box, dict) and "value" in box:
            return box["value"]
        raise


def cache_age_minutes(name: str) -> Optional[float]:
    box = read_json(name, None, cache=True)
    if not isinstance(box, dict) or "at" not in box:
        return None
    return round((time.time() - box["at"]) / 60, 1)


def cache_files(prefix: str) -> list:
    try:
        return [f for f in os.listdir(CACHE_DIR) if f.startswith(prefix)]
    except Exception:
        return []

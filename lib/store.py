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


# Память об отказах. Без неё медленный источник наказывает при каждом обращении:
# он не успевает за таймаут, значение в кэше не обновляется, и следующий вызов
# снова честно ждёт таймаут. Раз источник только что не ответил — не трогаем его
# несколько минут и сразу отдаём прошлое значение.
FAILURE_PAUSE = 5 * 60
_failed_until: Dict[str, float] = {}
_fail_lock = threading.Lock()


def cached(name: str, ttl_seconds: float, loader: Callable[[], Any]) -> Any:
    """Кэш на диске. Источник упал, а прошлое значение есть — отдаём его."""
    box = read_json(name, None, cache=True)
    fresh = isinstance(box, dict) and "at" in box and (time.time() - box["at"]) < ttl_seconds
    if fresh:
        return box.get("value")

    with _fail_lock:
        paused = _failed_until.get(name, 0) > time.time()
    if paused and isinstance(box, dict) and "value" in box:
        return box["value"]

    try:
        value = loader()
        write_json(name, {"at": time.time(), "value": value}, cache=True)
        with _fail_lock:
            _failed_until.pop(name, None)
        return value
    except Exception:
        with _fail_lock:
            _failed_until[name] = time.time() + FAILURE_PAUSE
        if isinstance(box, dict) and "value" in box:
            return box["value"]
        raise


def sweep_temp_files(older_than_seconds: float = 3600) -> int:
    """Подчищает .tmp от прерванных записей — иначе они копятся в data/."""
    removed = 0
    for folder in (DATA_DIR, CACHE_DIR):
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            if ".tmp" not in name:
                continue
            path = os.path.join(folder, name)
            try:
                if time.time() - os.path.getmtime(path) > older_than_seconds:
                    os.remove(path)
                    removed += 1
            except OSError:
                continue
    return removed


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

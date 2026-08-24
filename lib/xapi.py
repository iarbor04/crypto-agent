"""X (Twitter) через официальный API v2. Ключ задаётся в интерфейсе.

Читающие эндпоинты у X платные: на бесплатном тарифе они отдают 403.
Поэтому ошибки доступа переводим в человеческий текст, а не в пустоту —
пользователь должен понимать, что дело в тарифе, а не в дашборде.
"""

from __future__ import annotations

import os
import re
import urllib.parse
from typing import Any, Dict, List, Optional

from . import store
from .net import HttpError, fetch_json

API = "https://api.x.com/2"
CACHE_MINUTES = 30
# Сколько постов забираем на токен: больше не нужно, а лимиты чтения жёсткие.
LIMIT = 10


def credentials() -> Dict[str, str]:
    saved = (store.read_json("settings.json", {}) or {}).get("x") or {}
    return {"bearerToken": (saved.get("bearerToken") or os.environ.get("X_BEARER_TOKEN") or "").strip()}


def configured() -> bool:
    return bool(credentials()["bearerToken"])


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": "Bearer " + token}


def _explain(e: Exception) -> str:
    if isinstance(e, HttpError):
        if e.status == 401:
            return "Токен не принят: проверьте Bearer token в настройках проекта X"
        if e.status == 403:
            return "У ключа нет доступа к чтению постов — на бесплатном тарифе X это закрыто, нужен Basic или выше"
        if e.status == 429:
            return "Лимит запросов X исчерпан, попробуйте позже"
        if e.status:
            return "X ответил ошибкой %s" % e.status
    return "X недоступен: сеть или сам сервис не отвечают"


TOKEN_RE = re.compile(r"^[\x21-\x7e]+$")


def check(token: str = "") -> Dict[str, Any]:
    """Проверка ключа кнопкой в интерфейсе. Пустой аргумент — берём сохранённый."""
    token = (token or credentials()["bearerToken"]).strip()
    if not token:
        return {"ok": False, "error": "Токен не задан"}
    if not TOKEN_RE.match(token):
        # заголовок с кириллицей urllib отправить не может, а ошибка выходит невнятной
        return {"ok": False, "error": "В токене есть недопустимые символы: скопируйте Bearer token целиком, без кавычек и пробелов"}
    try:
        me = fetch_json(API + "/users/by/username/x", headers=_headers(token), timeout=15)
        handle = ((me or {}).get("data") or {}).get("username")
        return {"ok": True, "note": "чтение работает" + (" (проверено на @%s)" % handle if handle else "")}
    except Exception as e:
        return {"ok": False, "error": _explain(e)}


def _user_id(handle: str, token: str) -> Optional[str]:
    def loader():
        return fetch_json(API + "/users/by/username/" + urllib.parse.quote(handle),
                          headers=_headers(token), timeout=15)

    # id аккаунта не меняется — держим сутки, чтобы не жечь лимит чтения
    res = store.cached("x-user-%s.json" % handle.lower(), 24 * 3600, loader)
    return ((res or {}).get("data") or {}).get("id")


def get_posts(handle: str) -> Dict[str, Any]:
    """Последние посты аккаунта токена. Пустой список — это не ошибка."""
    token = credentials()["bearerToken"]
    if not token or not handle:
        return {"posts": [], "error": None}

    def loader():
        uid = _user_id(handle, token)
        if not uid:
            return {"data": []}
        url = "%s/users/%s/tweets?max_results=%d&tweet.fields=created_at,public_metrics&exclude=retweets,replies" % (
            API, uid, LIMIT
        )
        return fetch_json(url, headers=_headers(token), timeout=15)

    try:
        res = store.cached("x-posts-%s.json" % handle.lower(), CACHE_MINUTES * 60, loader)
    except Exception as e:
        return {"posts": [], "error": _explain(e)}

    posts = []
    for row in ((res or {}).get("data") or [])[:LIMIT]:
        metrics = row.get("public_metrics") or {}
        posts.append(
            {
                "text": (row.get("text") or "").strip(),
                "at": row.get("created_at"),
                "likes": metrics.get("like_count") or 0,
                "reposts": metrics.get("retweet_count") or 0,
                "url": "https://x.com/%s/status/%s" % (handle, row.get("id")),
            }
        )
    return {"posts": posts, "error": None, "handle": handle}


def digest(handle: str) -> Optional[str]:
    """Сжатая выжимка для промпта: даты, отклик и сам текст."""
    data = get_posts(handle)
    if not data["posts"]:
        return None
    lines: List[str] = []
    for p in data["posts"][:6]:
        when = (p["at"] or "")[:10]
        text = " ".join(p["text"].split())[:180]
        lines.append("- %s (%d лайков, %d репостов): %s" % (when, p["likes"], p["reposts"], text))
    return "\n".join(lines)

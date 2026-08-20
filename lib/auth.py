"""Вход по одному паролю. Нужен, только когда дашборд выставлен наружу.

Если DASHBOARD_PASSWORD не задан, защита выключена целиком и локальный
запуск ведёт себя как раньше. Если задан — ни страницы, ни API не отдаются
без сессионной куки, а кука подписана секретом, который лежит в data/
и переживает перезапуск.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time
from typing import Any, Dict, Optional, Tuple

from . import store

COOKIE_NAME = "portfolio_session"
TOKEN_TTL = 30 * 24 * 3600
# Подбор пароля по сети: после пяти промахов адрес отдыхает минуту.
MAX_FAILURES = 5
LOCKOUT = 60.0

_failures: Dict[str, Tuple[int, float]] = {}
_lock = threading.Lock()


def password() -> str:
    return (os.environ.get("DASHBOARD_PASSWORD") or "").strip()


def enabled() -> bool:
    return bool(password())


def _secret() -> bytes:
    """Секрет подписи. Один на установку, хранится рядом с данными."""
    saved = store.read_json("session-key.json", {})
    key = saved.get("key") if isinstance(saved, dict) else None
    if not key:
        key = secrets.token_hex(32)
        store.write_json("session-key.json", {"key": key})
    return key.encode("utf-8")


def _sign(expires: int) -> str:
    return hmac.new(_secret(), str(expires).encode("utf-8"), hashlib.sha256).hexdigest()


def make_token() -> str:
    expires = int(time.time()) + TOKEN_TTL
    return "%d.%s" % (expires, _sign(expires))


def check_token(token: Optional[str]) -> bool:
    if not token or "." not in token:
        return False
    raw_expires, _, signature = token.partition(".")
    try:
        expires = int(raw_expires)
    except ValueError:
        return False
    if expires < time.time():
        return False
    return hmac.compare_digest(signature, _sign(expires))


def locked_out(who: str) -> float:
    """Сколько секунд адресу ещё отдыхать после серии промахов."""
    with _lock:
        count, until = _failures.get(who, (0, 0.0))
    if count >= MAX_FAILURES and until > time.time():
        return until - time.time()
    return 0.0


def check_password(given: str, who: str = "-") -> bool:
    expected = password()
    if not expected:
        return True
    ok = hmac.compare_digest((given or "").strip().encode("utf-8"), expected.encode("utf-8"))
    with _lock:
        if ok:
            _failures.pop(who, None)
        else:
            count, _ = _failures.get(who, (0, 0.0))
            count += 1
            _failures[who] = (count, time.time() + LOCKOUT if count >= MAX_FAILURES else 0.0)
    return ok


def cookie_header(token: str, secure: bool) -> str:
    parts = [
        "%s=%s" % (COOKIE_NAME, token),
        "Path=/",
        "Max-Age=%d" % TOKEN_TTL,
        "HttpOnly",
        "SameSite=Lax",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header(secure: bool) -> str:
    parts = ["%s=" % COOKIE_NAME, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def token_from_cookies(raw: Optional[str]) -> Optional[str]:
    for chunk in (raw or "").split(";"):
        name, _, value = chunk.strip().partition("=")
        if name == COOKIE_NAME:
            return value
    return None


def state() -> Dict[str, Any]:
    return {"required": enabled()}

"""Настройки установки: Telegram, расписание, ИИ, период обновления.

Значения из интерфейса важнее переменных окружения — правит их пользователь.
Файл один, поэтому чтение и запись идут под общей блокировкой.
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict, List

from . import store

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _server_timezone() -> str:
    return os.environ.get("TZ") or "UTC"


def _normalize_schedule(raw: Dict[str, Any]) -> Dict[str, Any]:
    raw = raw or {}
    times = [t for t in (raw.get("times") or []) if isinstance(t, str) and TIME_RE.match(t)]
    times = sorted(set(times))[:8]
    # Пустой список — это режим «вручную», а не отсутствие настройки.
    # Значения по умолчанию подставляем только когда о временах вообще не спрашивали.
    if not times and "times" not in raw:
        times = ["09:00", "21:00"]
    return {
        "enabled": bool(raw.get("enabled", True)),
        "times": times,
        "timezone": raw.get("timezone") or _server_timezone(),
        "catchUp": bool(raw.get("catchUp", True)),
    }


def get_settings() -> Dict[str, Any]:
    saved = store.read_json("settings.json", {}) or {}
    ai = saved.get("ai") or {}
    return {
        "botToken": saved.get("botToken") or os.environ.get("TELEGRAM_BOT_TOKEN", ""),
        "chatId": saved.get("chatId") or os.environ.get("TELEGRAM_CHAT_ID", ""),
        "sendEmptyDigest": bool(saved.get("sendEmptyDigest", False)),
        "refreshMinutes": max(5, min(int(saved.get("refreshMinutes") or 30), 240)),
        "schedule": _normalize_schedule(saved.get("schedule") or {}),
        "ai": {
            "enabled": bool(ai.get("enabled", True)),
            "maxTokensPerRun": max(0, min(int(ai.get("maxTokensPerRun") or 3), 8)),
            "apiKey": ai.get("apiKey") or os.environ.get("ASCN_API_KEY", ""),
            "model": ai.get("model") or os.environ.get("ASCN_MODEL", "ascn_v1.2"),
            "template": ai.get("template") if ai.get("template") in ("summary", "full", "custom") else "summary",
            "customPrompt": ai.get("customPrompt") or "",
            # X смотрит сам ассистент: своего доступа к нему у нас нет.
            # notable — только по токенам, где что-то происходит.
            "social": ai.get("social") if ai.get("social") in ("off", "notable", "all") else "notable",
        },
    }


def save_settings(patch: Dict[str, Any]) -> Dict[str, Any]:
    def mutate(cur: Dict[str, Any]) -> Dict[str, Any]:
        cur = cur or {}
        ai_cur = cur.get("ai") or {}
        ai_patch = patch.get("ai") or {}
        out = dict(cur)

        if isinstance(patch.get("botToken"), str) and patch["botToken"].strip():
            out["botToken"] = patch["botToken"].strip()
        if isinstance(patch.get("chatId"), str):
            out["chatId"] = patch["chatId"].strip()
        if isinstance(patch.get("sendEmptyDigest"), bool):
            out["sendEmptyDigest"] = patch["sendEmptyDigest"]
        if patch.get("refreshMinutes") is not None:
            out["refreshMinutes"] = max(5, min(int(patch["refreshMinutes"]), 240))
        if isinstance(patch.get("schedule"), dict):
            merged = dict(cur.get("schedule") or {})
            merged.update(patch["schedule"])
            out["schedule"] = _normalize_schedule(merged)

        if ai_patch:
            out["ai"] = {
                "enabled": ai_patch.get("enabled", ai_cur.get("enabled", True)),
                "maxTokensPerRun": max(
                    0, min(int(ai_patch.get("maxTokensPerRun", ai_cur.get("maxTokensPerRun", 3))), 8)
                ),
                "apiKey": (ai_patch.get("apiKey") or "").strip() or ai_cur.get("apiKey", ""),
                "model": (ai_patch.get("model") or "").strip() or ai_cur.get("model", "ascn_v1.2"),
                "template": ai_patch.get("template") if ai_patch.get("template") in ("summary", "full", "custom")
                else ai_cur.get("template", "summary"),
                "customPrompt": ai_patch.get("customPrompt") if isinstance(ai_patch.get("customPrompt"), str)
                else ai_cur.get("customPrompt", ""),
                "social": ai_patch.get("social") if ai_patch.get("social") in ("off", "notable", "all")
                else ai_cur.get("social", "notable"),
            }
        return out

    store.update_json("settings.json", {}, mutate)
    return get_settings()


def mask(secret: str) -> str:
    if not secret:
        return ""
    return (secret[:6] + "…" + secret[-4:]) if len(secret) > 12 else "…"


DEMO_HOLDINGS: List[Dict[str, Any]] = [
    {"symbol": "ETH", "amount": 1.5, "coinId": "ethereum"},
    {"symbol": "SOL", "amount": 40, "coinId": "solana"},
    {"symbol": "APE", "amount": 5000, "coinId": "apecoin"},
    {"symbol": "USDC", "amount": 2500, "coinId": "usd-coin"},
]


def get_portfolio() -> Dict[str, Any]:
    saved = store.read_json("portfolio.json", None)
    if isinstance(saved, dict) and isinstance(saved.get("holdings"), list):
        return saved
    # свежая установка: пустой портфель, файл не создаём до первого сохранения
    return {"holdings": [], "updatedAt": None}


def save_portfolio(raw: Any) -> Dict[str, Any]:
    import datetime

    holdings: List[Dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        symbol = re.sub(r"[^A-Z0-9]", "", str(item.get("symbol", "")).upper())
        try:
            amount = float(item.get("amount"))
        except (TypeError, ValueError):
            continue
        if not symbol or amount <= 0:
            continue
        existing = next((h for h in holdings if h["symbol"] == symbol), None)
        if existing:
            existing["amount"] += amount
            continue
        entry = {"symbol": symbol, "amount": amount}
        if item.get("coinId"):
            entry["coinId"] = str(item["coinId"])
        holdings.append(entry)

    portfolio = {
        "holdings": holdings,
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    store.write_json("portfolio.json", portfolio)
    return portfolio


def seed_demo() -> Dict[str, Any]:
    return save_portfolio(DEMO_HOLDINGS)

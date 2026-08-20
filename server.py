#!/usr/bin/env python3
"""Дашборд крипто-портфеля на чистом Python 3: только стандартная библиотека.

Запуск:  python3 server.py   (или ./run.sh)
Адрес:   http://0.0.0.0:3500 — слушает наружу, чтобы открывался из песочницы.

Ни Node.js, ни npm, ни сторонних пакетов. Веб-сервер на http.server,
внешние API через urllib, хранение в JSON-файлах в data/.
"""

from __future__ import annotations

import json
import mimetypes
import os
import socket
import socketserver
import sys
import threading
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable, Dict, Optional, Tuple

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from lib import auth, market, net, sources, store  # noqa: E402
from lib.agent import (  # noqa: E402
    ask_ascn,
    ascn_credentials,
    detect_chats,
    get_bot_info,
    get_job,
    get_runs,
    run_agent,
    run_agent_background,
    send_telegram,
)
from lib.analyze import analyze_portfolio  # noqa: E402
from lib.scheduler import next_run, start_scheduler, tzdata_available, zone_note  # noqa: E402
from lib.settings import (  # noqa: E402
    get_portfolio,
    get_settings,
    mask,
    save_portfolio,
    save_settings,
    seed_demo,
)

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "3500"))
PUBLIC_DIR = os.path.join(ROOT, "public")


def _bound_sockets() -> None:
    """Ни одно соединение не должно висеть без предела, даже если про таймаут забыли."""
    socket.setdefaulttimeout(30)


def load_env() -> None:
    """Читаем .env.local без сторонних библиотек. Файла может и не быть."""
    for name in (".env.local", ".env"):
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key, value = key.strip(), value.strip().strip("'\"")
                if key and value and key not in os.environ:
                    os.environ[key] = value


# ————— Обработчики API —————


def api_analysis(_: Dict[str, str], __: Any) -> Any:
    return analyze_portfolio()


def api_health(_: Dict[str, str], __: Any) -> Any:
    """Проверяет сервер, доступ наружу и свежесть кэшей по каждому источнику."""
    egress = net.egress_state()
    checks = [
        ("CoinGecko · цены", "цены, объёмы, спарклайны", "markets-", 30),
        ("CoinGecko · профили", "ранг, категории, контракты", "coin-", 1440),
        ("DeFiLlama · пулы", "стейкинг, лендинг, LP", "llama-pools.json", 30),
        ("DeFiLlama · протоколы", "категории и TVL", "llama-protocols.json", 1440),
        ("DeFiLlama · взломы", "история инцидентов", "llama-hacks.json", 1440),
        ("DeFiLlama · стейблкоины", "контроль депега", "stablecoins.json", 360),
        ("Binance · пары", "список спотовых пар", "binance-symbols.json", 1440),
        ("Binance · фондирование", "ставки перпов", "funding.json", 15),
        ("Новости", "заголовки по токенам", "news-feed.json", 20),
        ("Fear & Greed", "настроение рынка", "fear-greed.json", 60),
    ]
    sources_state = []
    for name, what, cache, ttl in checks:
        if cache.endswith(".json"):
            age = store.cache_age_minutes(cache)
            files = 1 if age is not None else 0
        else:
            found = store.cache_files(cache)
            ages = [a for a in (store.cache_age_minutes(f) for f in found) if a is not None]
            age = min(ages) if ages else None
            files = len(found)
        sources_state.append(
            {
                "name": name,
                "what": what,
                "files": files,
                "ageMinutes": age,
                "ttlMinutes": ttl,
                "fresh": None if age is None else age <= ttl,
            }
        )

    settings = get_settings()
    return {
        "ok": True,
        "python": sys.version.split()[0],
        "dataDir": os.path.isdir(store.DATA_DIR),
        "telegramReady": bool(settings["botToken"] and settings["chatId"]),
        "ascnKey": bool(settings["ai"]["apiKey"]),
        "coingeckoKey": bool(os.environ.get("COINGECKO_API_KEY")),
        "agentSecretSet": bool(os.environ.get("AGENT_SECRET")),
        "scheduler": settings["schedule"],
        "egress": {"ok": egress["ok"], "reason": egress["reason"]},
        "tzdata": tzdata_available(),
        "timezoneNote": zone_note(settings["schedule"]["timezone"]),
        "sources": sources_state,
    }


def api_portfolio_get(_: Dict[str, str], __: Any) -> Any:
    return get_portfolio()


def api_portfolio_post(_: Dict[str, str], body: Any) -> Any:
    return save_portfolio((body or {}).get("holdings"))


def api_portfolio_demo(_: Dict[str, str], __: Any) -> Any:
    return seed_demo()


def api_history(query: Dict[str, str], __: Any) -> Any:
    try:
        days = int(query.get("days", "90"))
    except ValueError:
        days = 90
    holdings = get_portfolio()["holdings"]
    pairs = []
    for h in holdings:
        coin_id = h.get("coinId") or market.resolve_coin_id(h["symbol"])
        if coin_id:
            pairs.append((coin_id, h["amount"]))
    return sources.get_portfolio_history(pairs, days)


def api_opportunities(query: Dict[str, str], __: Any) -> Any:
    symbol = (query.get("symbol") or "").upper()
    if not symbol:
        return {"error": "нужен параметр symbol", "_status": 400}
    try:
        value = float(query.get("value", "0"))
    except ValueError:
        value = 0
    return {"symbol": symbol, "opportunities": sources.get_opportunities(symbol, value, 20)}


def api_resolve(query: Dict[str, str], __: Any) -> Any:
    return {"candidates": market.search_coins(query.get("q", ""))}


def api_price(query: Dict[str, str], __: Any) -> Any:
    ids = [i for i in (query.get("ids") or "").split(",") if i][:25]
    return {"prices": market.get_prices(ids) if ids else {}}


def api_venues(query: Dict[str, str], __: Any) -> Any:
    return {"venues": sources.get_venues(query.get("coinId", ""))}


def api_pool(query: Dict[str, str], __: Any) -> Any:
    return {
        "history": sources.get_pool_history(query.get("id", "")),
        "economics": sources.get_protocol_economics(query.get("slug", "")),
    }


def api_settings_get(_: Dict[str, str], __: Any) -> Any:
    s = get_settings()
    state = store.read_json("schedule-state.json", {"lastRunAt": None}) or {}
    return {
        "chatId": s["chatId"],
        "hasBotToken": bool(s["botToken"]),
        "botTokenMask": mask(s["botToken"]),
        "sendEmptyDigest": s["sendEmptyDigest"],
        "refreshMinutes": s["refreshMinutes"],
        "schedule": s["schedule"],
        "ai": {
            "enabled": s["ai"]["enabled"],
            "maxTokensPerRun": s["ai"]["maxTokensPerRun"],
            "model": s["ai"]["model"],
            "hasApiKey": bool(s["ai"]["apiKey"]),
            "apiKeyMask": mask(s["ai"]["apiKey"]),
            "fromEnv": bool(os.environ.get("ASCN_API_KEY")) and not (store.read_json("settings.json", {}).get("ai") or {}).get("apiKey"),
        },
        "next": next_run(s["schedule"]["times"], s["schedule"]["timezone"]) if s["schedule"]["enabled"] else None,
        "lastScheduledRun": state.get("lastRunAt"),
    }


def api_settings_post(_: Dict[str, str], body: Any) -> Any:
    s = save_settings(body or {})
    return {
        "ok": True,
        "refreshMinutes": s["refreshMinutes"],
        "schedule": s["schedule"],
        "ai": {"enabled": s["ai"]["enabled"], "maxTokensPerRun": s["ai"]["maxTokensPerRun"], "model": s["ai"]["model"], "hasApiKey": bool(s["ai"]["apiKey"])},
        "next": next_run(s["schedule"]["times"], s["schedule"]["timezone"]) if s["schedule"]["enabled"] else None,
    }


def api_agent_run(query: Dict[str, str], __: Any) -> Any:
    secret = query.get("secret")
    expected = os.environ.get("AGENT_SECRET")
    if secret is not None:
        if not expected or secret != expected:
            return {"error": "Неверный secret", "_status": 401}
    trigger = "cron" if secret else "manual"

    running = get_job()
    if running and running.get("status") == "running":
        return {"job": running, "alreadyRunning": True, "_status": 202}

    if query.get("wait") == "1":
        return run_agent(trigger)
    return {"job": run_agent_background(trigger), "_status": 202}


def api_agent_job(_: Dict[str, str], __: Any) -> Any:
    return {"job": get_job()}


def api_agent_history(_: Dict[str, str], __: Any) -> Any:
    return {"runs": get_runs()}


def api_telegram_test(_: Dict[str, str], __: Any) -> Any:
    res = send_telegram(
        "<b>✅ Связь есть</b>\nЭто тестовое сообщение из дашборда портфеля. Сводки будут приходить сюда по расписанию."
    )
    if not res["sent"]:
        res["_status"] = 400
    return res


def api_telegram_detect(_: Dict[str, str], body: Any) -> Any:
    token = ((body or {}).get("botToken") or "").strip() or None
    info = get_bot_info(token)
    if not info.get("bot"):
        return {"error": info.get("error") or "Бот не отвечает", "_status": 400}
    found = detect_chats(token)
    out = {"bot": info["bot"], "chats": found["chats"]}
    if found.get("error"):
        out["chatsError"] = found["error"]
    return out


def api_ascn_check(_: Dict[str, str], body: Any) -> Any:
    saved = ascn_credentials()
    api_key = ((body or {}).get("apiKey") or "").strip() or saved["apiKey"]
    model = ((body or {}).get("model") or "").strip() or saved["model"]
    if not api_key:
        return {"ok": False, "error": "Ключ не задан", "_status": 400}
    res = ask_ascn("Проверка связи: ответь одним словом OK", "", {"apiKey": api_key, "model": model})
    if res.get("content"):
        return {"ok": True, "model": model, "seconds": res["seconds"], "answer": res["content"][:40]}
    return {"ok": False, "error": res.get("error"), "_status": 400}


ROUTES: Dict[Tuple[str, str], Callable[[Dict[str, str], Any], Any]] = {
    ("GET", "/api/analysis"): api_analysis,
    ("GET", "/api/health"): api_health,
    ("GET", "/api/auth"): lambda *_: {"required": auth.enabled(), "authorized": True},
    ("GET", "/api/portfolio"): api_portfolio_get,
    ("POST", "/api/portfolio"): api_portfolio_post,
    ("POST", "/api/portfolio/demo"): api_portfolio_demo,
    ("GET", "/api/history"): api_history,
    ("GET", "/api/opportunities"): api_opportunities,
    ("GET", "/api/resolve"): api_resolve,
    ("GET", "/api/price"): api_price,
    ("GET", "/api/venues"): api_venues,
    ("GET", "/api/pool"): api_pool,
    ("GET", "/api/settings"): api_settings_get,
    ("POST", "/api/settings"): api_settings_post,
    ("POST", "/api/agent/run"): api_agent_run,
    ("GET", "/api/agent/job"): api_agent_job,
    ("GET", "/api/agent/history"): api_agent_history,
    ("POST", "/api/telegram/test"): api_telegram_test,
    ("POST", "/api/telegram/detect"): api_telegram_detect,
    ("POST", "/api/ascn/check"): api_ascn_check,
}


# Что отдаётся до входа: страница входа и то, без чего она не нарисуется.
OPEN_FILES = {"/styles.css", "/favicon.svg", "/emblem.svg"}


class Handler(BaseHTTPRequestHandler):
    server_version = "crypto-agent/1.0"
    protocol_version = "HTTP/1.1"

    # ————— вход —————

    def _secure_link(self) -> bool:
        return (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip() == "https"

    def _authorized(self) -> bool:
        if not auth.enabled():
            return True
        return auth.check_token(auth.token_from_cookies(self.headers.get("Cookie")))

    def _who(self) -> str:
        forwarded = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        return forwarded or self.client_address[0]

    def _do_login(self) -> None:
        wait = auth.locked_out(self._who())
        if wait:
            self._send_json({"error": "Слишком много попыток, подождите %d с" % int(wait + 1), "_status": 429})
            return
        given = (self._read_body() or {}).get("password") or ""
        if not auth.check_password(given, self._who()):
            self._send_json({"error": "Неверный пароль", "_status": 401})
            return
        body = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
        self._send(200, body, "application/json; charset=utf-8",
                   {"Set-Cookie": auth.cookie_header(auth.make_token(), self._secure_link())})

    def _do_logout(self) -> None:
        body = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
        self._send(200, body, "application/json; charset=utf-8",
                   {"Set-Cookie": auth.clear_cookie_header(self._secure_link())})

    def log_message(self, fmt: str, *args: Any) -> None:  # тише в консоли
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ————— вспомогательное —————

    def _send(self, status: int, body: bytes, content_type: str, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, data: Any, status: int = 200) -> None:
        if isinstance(data, dict) and "_status" in data:
            status = data.pop("_status")
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _read_body(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _serve_static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        # три страницы одного приложения отдают один и тот же html
        if rel in ("risks", "agent"):
            rel = "index.html"
        target = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        if not target.startswith(PUBLIC_DIR) or not os.path.isfile(target):
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        with open(target, "rb") as f:
            self._send(200, f.read(), ctype)

    # ————— методы —————

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        if not self._authorized():
            if parsed.path == "/api/health":
                # С самой машины отдаём полную картину: кто дошёл до localhost,
                # тот и так читает .env.local, а диагностика нужна именно ему.
                # Снаружи — только факт жизни, чтобы проверки платформы проходили,
                # а конфигурация не светилась.
                # Заголовки X-Forwarded-* означают, что запрос пришёл через
                # прокси: на хостинге он может стучаться и с петли, поэтому
                # такой запрос считаем внешним, а сам заголовок — подделываемым.
                proxied = bool(self.headers.get("X-Forwarded-For") or self.headers.get("X-Forwarded-Proto"))
                if not proxied and self.client_address[0] in ("127.0.0.1", "::1"):
                    self._send_json(api_health({}, None))
                else:
                    self._send_json({
                        "ok": True,
                        "authRequired": True,
                        "detail": "полный ответ — после входа или с localhost",
                    })
                return
            if parsed.path == "/api/auth":
                self._send_json({"required": True, "authorized": False})
                return
            if parsed.path.startswith("/api/"):
                self._send_json({"error": "Нужен вход", "authRequired": True, "_status": 401})
                return
            self._serve_static(parsed.path if parsed.path in OPEN_FILES else "/login.html")
            return
        handler = ROUTES.get(("GET", parsed.path))
        if handler:
            try:
                self._send_json(handler(query, None))
            except Exception as e:
                traceback.print_exc()
                # источник упал — отвечаем предупреждением, а не пятисоткой
                self._send_json({"data": None, "warning": "Источник временно недоступен", "detail": str(e)}, 200)
            return
        if parsed.path.startswith("/api/"):
            self._send_json({"error": "неизвестный маршрут"}, 404)
            return
        self._serve_static(parsed.path)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        if parsed.path == "/api/login":
            self._do_login()
            return
        if parsed.path == "/api/logout":
            self._do_logout()
            return
        if not self._authorized():
            # внешнему планировщику пароль не нужен: у него свой AGENT_SECRET
            cron = parsed.path == "/api/agent/run" and query.get("secret")
            expected = os.environ.get("AGENT_SECRET")
            if not (cron and expected and query.get("secret") == expected):
                self._send_json({"error": "Нужен вход", "authRequired": True, "_status": 401})
                return
        handler = ROUTES.get(("POST", parsed.path))
        if not handler:
            self._send_json({"error": "неизвестный маршрут"}, 404)
            return
        try:
            self._send_json(handler(query, self._read_body()))
        except Exception as e:
            traceback.print_exc()
            self._send_json({"data": None, "warning": "Источник временно недоступен", "detail": str(e)}, 200)


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    load_env()
    _bound_sockets()
    store.ensure_dirs()
    start_scheduler()
    httpd = Server((HOST, PORT), Handler)
    print("Дашборд запущен: http://%s:%d" % ("localhost" if HOST == "0.0.0.0" else HOST, PORT), flush=True)
    print("Слушаю на %s:%d — можно открывать извне песочницы" % (HOST, PORT), flush=True)
    print("Данные в %s · остановить Ctrl+C" % store.DATA_DIR, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено", flush=True)
        httpd.shutdown()


if __name__ == "__main__":
    main()

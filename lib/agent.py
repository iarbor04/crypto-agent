"""Агент: разбор по расписанию, ИИ-анализ важных токенов и сводка в Telegram."""

from __future__ import annotations

import datetime
import re
import threading
import time
import urllib.parse
from typing import Any, Dict, List, Optional

from . import store
from .analyze import analyze_portfolio
from .net import fetch_json
from .score import risk_level
from .settings import get_settings

ASCN_BASE = "https://b2b.api.ascn.ai"
ASCN_TIMEOUT = 15 * 60


def _money(n: float) -> str:
    return "$" + format(int(round(n)), ",").replace(",", " ")


def _sign(n: float) -> str:
    return "%s%.1f%%" % ("+" if n > 0 else "", n)


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ————— Telegram —————


def escape_html(text: str) -> str:
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _chunks(text: str, size: int = 3800) -> List[str]:
    if len(text) <= size:
        return [text]
    parts, buf = [], ""
    for line in text.split("\n"):
        if len(buf) + len(line) + 1 > size:
            parts.append(buf)
            buf = ""
        buf += ("\n" if buf else "") + line
    if buf:
        parts.append(buf)
    return parts


def send_telegram(text: str) -> Dict[str, Any]:
    s = get_settings()
    token, chat_id = s["botToken"], s["chatId"]
    if not token or not chat_id:
        return {"sent": False, "error": "Не заданы токен бота и chat id — настройте на странице «Агент»"}
    try:
        for part in _chunks(text):
            res = fetch_json(
                "https://api.telegram.org/bot%s/sendMessage" % token,
                method="POST",
                payload={
                    "chat_id": chat_id,
                    "text": part,
                    "parse_mode": "HTML",
                    "link_preview_options": {"is_disabled": True},
                },
                timeout=30,
            )
            if not res.get("ok"):
                return {"sent": False, "error": res.get("description") or "Telegram отказал"}
        return {"sent": True}
    except Exception as e:
        return {"sent": False, "error": str(e)}


def get_bot_info(token: Optional[str] = None) -> Dict[str, Any]:
    token = token or get_settings()["botToken"]
    if not token:
        return {"bot": None, "error": "Токен бота не задан"}
    try:
        res = fetch_json("https://api.telegram.org/bot%s/getMe" % token, timeout=20)
        if not res.get("ok"):
            return {"bot": None, "error": res.get("description") or "Бот не отвечает"}
        r = res.get("result") or {}
        return {"bot": {"username": r.get("username", ""), "name": r.get("first_name", "")}}
    except Exception as e:
        return {"bot": None, "error": str(e)}


def detect_chats(token: Optional[str] = None) -> Dict[str, Any]:
    """Ищет chat id по последним сообщениям бота — самый частый камень при установке."""
    token = token or get_settings()["botToken"]
    if not token:
        return {"chats": [], "error": "Токен бота не задан"}
    try:
        res = fetch_json("https://api.telegram.org/bot%s/getUpdates?limit=100" % token, timeout=25)
        if not res.get("ok"):
            return {"chats": [], "error": res.get("description") or "Telegram отказал"}
        seen: Dict[str, Dict[str, str]] = {}
        types = {"private": "личка", "channel": "канал", "group": "группа", "supergroup": "группа"}
        for u in res.get("result") or []:
            chat = (u.get("message") or u.get("channel_post") or {}).get("chat")
            if not chat:
                continue
            cid = str(chat.get("id"))
            if cid in seen:
                continue
            seen[cid] = {
                "id": cid,
                "title": chat.get("title") or chat.get("username") or chat.get("first_name") or cid,
                "type": types.get(chat.get("type"), "чат"),
            }
        return {"chats": list(reversed(list(seen.values())))}
    except Exception as e:
        return {"chats": [], "error": str(e)}


# ————— ASCN: ИИ-разбор токена —————


def ascn_credentials() -> Dict[str, str]:
    ai = get_settings()["ai"]
    return {"apiKey": ai["apiKey"], "model": ai["model"]}


# Шаблоны разбора. «Итог» — по умолчанию: коротко, с привязкой к прошлому выводу.
# «Полный» — четыре раздела, когда нужен разбор целиком.
TEMPLATES = {
    "summary": {"title": "Только итог", "what": "тот же анализ, но не длиннее 150 слов"},
    "full": {"title": "Полный разбор", "what": "анализ монеты за сутки и неделю плюс перспективы"},
    "custom": {"title": "Свой промпт", "what": "текст задаёте сами"},
}


def build_token_prompt(token: Dict[str, Any], template: str = "full", custom: str = "") -> str:
    """Запрос ассистенту, написанный от цели, а не от формата.

    Формулируем, кто читатель и что ему нужно понять; чем именно это раскрывать —
    решает ассистент. Предписанные разделы пробовались и заставляли писать абзацы
    про недоступные данные; голый «сделай анализ» уводил в пересказ метрик, которые
    и так на экране. Единственное, что задано жёстко, — запрет рекомендаций
    (принцип продукта из AGENTS.md) и короткий вывод текстом, который читают
    в списке позиций.
    """
    m = token.get("market") or {}
    contract = ((token.get("meta") or {}).get("chains") or [{}])[0] if token.get("meta") else {}
    name = (token.get("meta") or {}).get("name") or m.get("name") or token["symbol"]
    where = (" (%s, контракт %s в сети %s)" % (name, contract.get("address"), contract.get("chain"))
             if contract.get("address") else " (%s)" % name)

    lines = [
        "Помоги держателю монеты %s%s понять, что с ней происходит и чего ждать дальше."
        % (token["symbol"], where),
        "",
        "Цена, изменения за сутки, неделю и месяц, объём, капитализация, RSI и глубина",
        "стакана у него уже на экране — повторять их незачем. Ему нужно то, чего там нет:",
        "что движет монетой прямо сейчас, что изменилось за сутки и за неделю, какие",
        "события, разлоки и решения команды впереди, какие риски и какие перспективы.",
        "Читатель — опытный трейдер: пиши числами, датами, адресами и источниками.",
        "",
        "Не давай рекомендаций: не советуй покупать, продавать, сокращать или держать —",
        "решение он принимает сам.",
        "Заверши коротким выводом в 2-3 предложения обычным текстом, не таблицей.",
    ]
    if template == "summary":
        lines.append("Уложись в 150 слов.")
    prompt = "\n".join(lines)
    if template == "custom" and custom.strip():
        return prompt + "\n\n" + custom.strip()
    return prompt


def ask_ascn(message: str, symbol: str = "", creds: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    creds = creds or ascn_credentials()
    key, model = creds.get("apiKey"), creds.get("model") or "ascn_v1.2"
    started = time.time()
    elapsed = lambda: round(time.time() - started)

    if not key:
        return {"symbol": symbol, "content": None, "error": "Ключ ASCN не задан — вставьте его на странице «Агент»", "seconds": 0}
    # ключ уходит в HTTP-заголовок: с кириллицей или пробелами запрос не соберётся
    if not re.match(r"^[\x21-\x7e]+$", key):
        return {
            "symbol": symbol,
            "content": None,
            "error": "Ключ содержит недопустимые символы — ожидаются латинские буквы и цифры",
            "seconds": 0,
        }

    try:
        res = fetch_json(
            ASCN_BASE + "/api/ai-assistant/v2/invoke_assistant",
            method="POST",
            headers={"X-API-Key": key},
            payload={"message": message, "model": model, "auto_hil": True},
            timeout=ASCN_TIMEOUT,
        )
    except Exception as e:
        return {"symbol": symbol, "content": None, "error": str(e), "seconds": elapsed()}

    if res.get("error"):
        return {"symbol": symbol, "content": None, "error": res["error"], "seconds": elapsed()}
    if not res.get("content"):
        return {
            "symbol": symbol,
            "content": None,
            "error": "ассистент запросил уточнение" if res.get("hil") else "пустой ответ",
            "seconds": elapsed(),
        }
    return {"symbol": symbol, "content": res["content"], "error": None, "seconds": elapsed()}


SECTION_RE = re.compile(r"(?<!\n)[ \t]*\*{0,2}\b(ЧТО ЗА ПОЗИЦИЮ|ЧТО ПРОТИВ|ПРОТИВ|ЗА|ИТОГ|ВЫВОД|КОРОТКО)\*{0,2}[ \t]*:")


def _normalize_sections(content: str) -> str:
    """Модель нередко пишет «ЗА:» и «ПРОТИВ:» внутри абзаца, а не с новой строки.
    Тогда они утекают в итог и не попадают в списки — ставим перевод строки.
    Регистр здесь важен: строчное «за:» в обычной фразе трогать нельзя."""
    return SECTION_RE.sub(lambda m: "\n" + m.group(1) + ":", content or "")


def parse_pros_cons(content: str) -> Dict[str, List[str]]:
    """Два списка фактов из ответа: по ним карточки показывают плюсы и минусы."""
    content = _normalize_sections(content)

    def grab(heading: str) -> List[str]:
        # заголовок только с начала строки: короткие «ЗА»/«ПРОТИВ» иначе
        # находятся внутри обычного текста
        m = re.search(r"(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*)?%s(?:\*\*)?\s*:" % heading, content, re.I)
        if not m:
            return []
        tail = content[m.end():]
        stop = re.search(r"\n\s*(?:\*\*)?(?:ЧТО ПРОТИВ|ЧТО ЗА|ПРОТИВ|ЗА|РЕШЕНИЕ|ИТОГ|ВЫВОД|КОРОТКО)\b", tail, re.I)
        block = tail[: stop.start()] if stop else tail
        lines = []
        for raw in block.split("\n"):
            line = re.sub(r"^[\s>]*[-*•·]\s*", "", raw).replace("**", "").strip()
            if 8 < len(line) < 600:
                lines.append(line)
        flat: List[str] = []
        for line in lines:
            # модель иногда пишет всё одной строкой: «1) … 2) … 3) …».
            # Цифра перед скобкой должна стоять после пробела, иначе резались
            # обычные числа: «($81.25)» ломалось по «5)», а «RSI(14)» по «4)».
            if re.search(r"(?:(?<=\s)|^)\d\)\s", line[2:]):
                flat += [p.strip() for p in re.split(r"(?:(?<=\s)|^)\d\)\s*", line) if len(p.strip()) > 8]
            else:
                flat.append(line)
        return [re.sub(r"^[-*•·\s]+", "", f).strip() for f in flat][:8]

    pros = grab("ЧТО ЗА ПОЗИЦИЮ") or grab("ЗА")
    cons = grab("ЧТО ПРОТИВ") or grab("ПРОТИВ")
    return {
        "pros": pros,
        "cons": cons,
        "summary": parse_summary(content),
        "short": parse_short(content),
        "body": parse_body(content),
    }


def parse_summary(content: str) -> str:
    """Краткий итог: то, что показывается в карточке и уходит в сводку."""
    content = _normalize_sections(content)
    # Заголовок ищем только с начала строки и по границе слова: иначе «ВЫВОД»
    # находится внутри фразы «Прошлый вывод…» и отрезает начало итога.
    m = re.search(r"(?:^|\n)\s*(?:\*\*)?(?:ИТОГ|ВЫВОД)(?:\*\*)?\s*(?::|\n)\s*", content or "", re.I)
    if m:
        block = content[m.end():]
    else:
        block = _conclusion(content or "")
    # Ответ часто идёт одним абзацем без заголовка, поэтому режем не по пустой
    # строке, а по началу разделов «ЗА»/«ПРОТИВ» — они уже на своих строках.
    stop = re.search(r"\n\s*(?:\*\*)?(?:ЧТО ЗА ПОЗИЦИЮ|ЧТО ПРОТИВ|ПРОТИВ|ЗА|КОРОТКО)\b\s*:", block)
    if stop:
        block = block[: stop.start()]
    text = re.sub(r"^[\s>*•·-]+", "", block.replace("**", "")).strip()
    # ассистент подписывает вывод: «Вывод для держателя: …» — в карточке это лишнее
    text = re.sub(r"^(?:итог|вывод|заключение|резюме)[^:.\n]{0,30}:\s*", "", text, flags=re.I)
    text = re.sub(r"\s*\n\s*", " ", text)
    # решётки markdown-заголовков модель ставит и в конце абзаца тоже
    text = re.sub(r"\s*#{2,}\s*", " ", text).strip()
    return text[:4000]


def _prose_paragraphs(content: str) -> List[str]:
    """Абзацы обычного текста: без заголовков, таблиц и списков."""
    out: List[str] = []
    buf: List[str] = []

    def flush():
        if buf:
            out.append(" ".join(buf).strip())
            del buf[:]

    for raw in (content or "").split("\n"):
        line = raw.strip()
        if not line:
            flush()
            continue
        if (re.match(r"^#{1,6}\s", line) or line.startswith("|")
                or set(line) <= set("-—=*_ ")
                or re.match(r"^[-*•·]\s", line) or re.match(r"^\d+[.)]\s", line)):
            flush()
            continue
        buf.append(line.replace("**", "").strip())
    flush()
    return [p for p in out if p]


META_RE = re.compile(r"tradingview|виджет|в интерфейсе|на графике выше|вы уже видите", re.I)


DISCLAIMER_RE = re.compile(
    r"не являет\w* (?:инвестиционн\w+ )?рекомендац|информационн\w+ характер"
    r"|принимает\w* самостоятельно|do your own research|\bDYOR\b|не финансов\w+ совет",
    re.I)


def _is_disclaimer(text: str) -> bool:
    """Служебный абзац, который не является выводом.

    Два вида. Оговорка: ассистента просят не рекомендовать, и он дописывает
    «анализ носит информационный характер» — абзац стоит последним и уезжал
    в карточку вместо вывода. И реплика про интерфейс: «вы уже видите график
    APE/USDT в TradingView» — это про экран, а не про монету."""
    return bool(DISCLAIMER_RE.search(text or "") or META_RE.search(text or ""))


CONCLUSION_HEAD_RE = re.compile(r"^\s*#{1,6}[^\n]*\b(итог\w*|вывод\w*|заключен\w+|резюме)\b[^\n]*$",
                                re.I | re.M)


def _conclusion(content: str) -> str:
    """Вывод свободного ответа.

    Сначала ищем раздел, названный итогом или выводом — ассистент почти всегда
    его делает («## Итоговый свод фактов и следствий»). Если такого нет, берём
    последний содержательный абзац."""
    head = CONCLUSION_HEAD_RE.search(content or "")
    if head:
        paragraphs = [p for p in _prose_paragraphs(content[head.end():]) if not _is_disclaimer(p)]
        joined = " ".join(paragraphs).strip()
        if len(joined) >= 60:
            return joined
    return _closing_paragraph(content or "")


def _closing_paragraph(content: str) -> str:
    """Итог свободного ответа — последний содержательный абзац.

    У ответа без служебного заголовка «ИТОГ» вывод стоит в конце: перед ним идут
    заголовки, таблицы метрик и списки катализаторов. Первый абзац тут не годится
    — там оказывались то «Основные метрики», то строка с адресом контракта."""
    paragraphs = [p for p in _prose_paragraphs(content) if not _is_disclaimer(p)]
    if not paragraphs:
        return ""
    for p in reversed(paragraphs):
        if len(p) >= 80:
            return p
    return paragraphs[-1]


def parse_body(content: str) -> str:
    """Сам разбор — то, что ассистент написал до служебного хвоста.

    Хвост (ЧТО ЗА ПОЗИЦИЮ / ЧТО ПРОТИВ / ИТОГ / КОРОТКО) разбирается отдельно и
    показывается своими блоками. Всё, что выше, — это и есть анализ, ради
    которого запрос делался, и на карточке риска он занимает главное место."""
    content = _normalize_sections(content or "")
    stop = re.search(
        r"\n\s*(?:#{1,4}\s*)?\*{0,2}\s*(?:ЧТО ЗА ПОЗИЦИЮ|ЧТО ПРОТИВ|ИТОГ|ВЫВОД|КОРОТКО)\*{0,2}\s*:",
        content, re.I)
    body = content[: stop.start()] if stop else content
    return body.strip()[:12000]


def parse_short(content: str) -> str:
    """Одна фраза для карточки в списке позиций. Полный итог туда не влезает.

    Раздела может не быть: у шаблона «свой промпт» его никто не просил, да и
    модель иногда забывает. Тогда возвращаем пустую строку, а карточка сама
    откатывается на первое предложение итога."""
    content = _normalize_sections(content)
    m = re.search(r"(?:^|\n)\s*(?:\*\*)?КОРОТКО(?:\*\*)?\s*(?::|\n)\s*", content or "", re.I)
    if not m:
        return ""
    block = content[m.end():]
    stop = re.search(r"\n\s*(?:\*\*)?(?:ЧТО ЗА ПОЗИЦИЮ|ЧТО ПРОТИВ|ПРОТИВ|ЗА|ИТОГ|ВЫВОД)\b\s*:", block)
    if stop:
        block = block[: stop.start()]
    # берём первую непустую строку: список из одного пункта модель всё равно
    # иногда пишет дефисом
    for raw in block.split("\n"):
        line = re.sub(r"^[\s>*•·-]+", "", raw.replace("**", "")).strip()
        line = re.sub(r"\s*#{2,}\s*", " ", line).strip()
        if len(line) > 8:
            return line[:200]
    return ""


HISTORY_LIMIT = 12


def last_insight(symbol: str) -> Optional[Dict[str, Any]]:
    """Последний разбор токена — нужен, чтобы новый вывод спорил с прошлым."""
    saved = (store.read_json("ai-insights.json", {}) or {}).get(symbol.upper())
    return saved if isinstance(saved, dict) else None


def insight_history(symbol: str) -> List[Dict[str, Any]]:
    rows = (store.read_json("ai-history.json", {}) or {}).get(symbol.upper()) or []
    return rows if isinstance(rows, list) else []


def save_insight(symbol: str, content: str, template: str = "full", seconds: Optional[float] = None) -> Dict[str, Any]:
    """Пишем разбор в две книги: последнее состояние и историю по токену."""
    parsed = parse_pros_cons(content)
    entry = {
        "at": _now(),
        "summary": parsed["summary"],
        "short": parsed["short"],
        "body": parsed["body"],
        "pros": parsed["pros"],
        "cons": parsed["cons"],
        "content": content,
        "template": template,
        "seconds": seconds,
    }
    key = symbol.upper()

    def put_last(cur):
        cur = cur or {}
        cur[key] = entry
        return cur

    def put_history(cur):
        cur = cur or {}
        rows = cur.get(key) or []
        # полный текст храним и здесь: прошлый разбор нужно уметь открыть целиком
        rows.insert(0, {k: entry[k] for k in ("at", "summary", "short", "body", "pros", "cons", "template", "seconds", "content")})
        cur[key] = rows[:HISTORY_LIMIT]
        return cur

    store.update_json("ai-insights.json", {}, put_last)
    store.update_json("ai-history.json", {}, put_history)
    return entry


def analyze_one(symbol: str) -> Dict[str, Any]:
    """Разбор одного токена по кнопке в карточке."""
    settings = get_settings()
    creds = ascn_credentials()
    if not creds["apiKey"]:
        return {"error": "Ключ ASCN не задан", "_status": 400}
    analysis = analyze_portfolio()
    token = next((t for t in (analysis.get("tokens") or []) if t["symbol"].upper() == symbol.upper()), None)
    if not token:
        return {"error": "Токена %s нет в портфеле" % symbol, "_status": 404}
    ai = settings["ai"]
    prompt = build_token_prompt(token, template=ai.get("template") or "full",
                                custom=ai.get("customPrompt") or "")
    res = ask_ascn(prompt, token["symbol"], creds)
    if not res.get("content"):
        return {"error": res.get("error") or "Ассистент не ответил", "_status": 502}
    entry = save_insight(token["symbol"], res["content"], ai.get("template") or "full", res.get("seconds"))
    return {"ok": True, "symbol": token["symbol"], "insight": entry, "history": insight_history(token["symbol"])}


def markdown_to_telegram(md: str) -> str:
    """Telegram знает только b/i/u/s/code/pre/a — заголовки и списки переводим."""
    text = escape_html(md)
    text = re.sub(r"^#{1,6}\s*(.+)$", lambda m: "<b>%s</b>" % m.group(1).strip(), text, flags=re.M)
    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<b><i>\1</i></b>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(^|\n)\s*[*-]\s+", r"\1• ", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ————— Сводка и прогон —————


def _snapshot_of(analysis: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "at": analysis["generatedAt"],
        "totalValueUsd": analysis["totalValueUsd"],
        "tokens": {
            t["symbol"]: {
                "price": (t.get("market") or {}).get("price") or 0,
                "score": t["score"],
                "verdict": t["verdict"],
                "bestApy": t["bestApy"],
                "newsUrls": [n["url"] for n in t["news"]],
            }
            for t in analysis["tokens"]
        },
    }


def _diff_alerts(analysis: Dict[str, Any], prev: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Смысл агента — показать дельту, а не пересказать портфель."""
    if not prev:
        return []
    out = []
    order = ["accumulate", "hold", "watch", "reduce", "sell"]
    for t in analysis["tokens"]:
        before = (prev.get("tokens") or {}).get(t["symbol"])
        if not before:
            continue

        if before["verdict"] != t["verdict"]:
            worse = order.index(t["verdict"]) > order.index(before["verdict"])
            out.append(
                {
                    "level": ("critical" if t["verdict"] == "sell" else "warning") if worse else "positive",
                    "symbol": t["symbol"],
                    "title": "%s: риск %s → %s" % (t["symbol"], risk_level(before["score"])["short"], risk_level(t["score"])["short"]),
                    "body": "\n".join("• " + r["text"] for r in t["reasons"][:2]),
                    "action": "Оценка ухудшилась" if worse else "Оценка улучшилась",
                }
            )
        elif abs(t["score"] - before["score"]) >= 12:
            out.append(
                {
                    "level": "warning" if t["score"] < before["score"] else "positive",
                    "symbol": t["symbol"],
                    "title": "%s: оценка риска изменилась (%s → %s)" % (t["symbol"], risk_level(before["score"])["short"], risk_level(t["score"])["short"]),
                    "body": "\n".join("• " + r["text"] for r in t["reasons"][:2]),
                    "action": "",
                }
            )

        price_now = (t.get("market") or {}).get("price")
        if before["price"] and price_now:
            move = (price_now - before["price"]) / before["price"] * 100
            if abs(move) >= 12:
                out.append(
                    {
                        "level": "warning" if move < 0 else "positive",
                        "symbol": t["symbol"],
                        "title": "%s: цена %s с прошлой проверки" % (t["symbol"], _sign(move)),
                        "body": "Было $%.6g, стало $%.6g" % (before["price"], price_now),
                        "action": "",
                    }
                )

        seen = set(before.get("newsUrls") or [])
        fresh_bad = next((n for n in t["news"] if n["url"] not in seen and n["tone"] <= -2 and (n.get("ageDays") or 99) <= 14), None)
        if fresh_bad:
            out.append(
                {
                    "level": "critical",
                    "symbol": t["symbol"],
                    "title": "%s: новая плохая новость (%s)" % (t["symbol"], ", ".join(fresh_bad["tags"])),
                    "body": "«%s»\n%s" % (fresh_bad["title"], fresh_bad["source"]),
                    "action": "",
                }
            )
    return out


ICON = {"critical": "🔴", "warning": "🟡", "positive": "🟢", "info": "💤"}
TITLES = {"critical": "Требует внимания", "warning": "Внимание", "positive": "Позитив", "info": "Деньги лежат без дела"}


def build_digest(analysis: Dict[str, Any], alerts: List[Dict[str, Any]], prev: Optional[Dict[str, Any]]) -> str:
    lines = ["<b>📊 Портфель %s</b>" % _money(analysis["totalValueUsd"])]
    base = analysis["totalValueUsd"] - analysis["change24hUsd"]
    change_pct = (analysis["change24hUsd"] / base * 100) if base > 0 else 0
    lines.append("За сутки: %s%s (%s)" % ("+" if analysis["change24hUsd"] >= 0 else "−", _money(abs(analysis["change24hUsd"])), _sign(change_pct)))
    if prev:
        delta = analysis["totalValueUsd"] - prev["totalValueUsd"]
        pct = (delta / prev["totalValueUsd"] * 100) if prev["totalValueUsd"] else 0
        lines.append("С прошлой проверки: %s%s (%s)" % ("+" if delta >= 0 else "−", _money(abs(delta)), _sign(pct)))

    for level in ("critical", "warning", "positive", "info"):
        items = [a for a in alerts if a["level"] == level][:6]
        if not items:
            continue
        lines += ["", "%s <b>%s</b>" % (ICON[level], TITLES[level])]
        for it in items:
            lines.append("<b>%s</b>" % escape_html(it["title"]))
            if it.get("body"):
                lines.append(escape_html(it["body"]))
            if it.get("action"):
                lines.append("→ " + escape_html(it["action"]))
            lines.append("")

    fg = (analysis.get("context") or {}).get("fearGreed")
    if fg:
        lines.append("Рынок: %s %d/100" % (fg["label"], fg["value"]))

    worst = sorted(analysis["tokens"], key=lambda t: t["score"])[:3]
    lines += ["", "<b>Самые слабые позиции</b>"]
    for t in worst:
        lines.append(
            "%s — риск %s · %s · за неделю %s"
            % (t["symbol"], risk_level(t["score"])["short"], _money(t["valueUsd"]), _sign((t.get("market") or {}).get("change7d") or 0))
        )
    if analysis["potentialYearlyUsd"] >= 1:
        lines += ["", "💰 На стейкинге можно заработать %s в год, не продавая токены" % _money(analysis["potentialYearlyUsd"])]
    return "\n".join(lines)


def _pick_for_ai(analysis: Dict[str, Any], alerts: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
    """Один токен стоит 3-6 минут ожидания, поэтому берём только изменившиеся."""
    weight = {"critical": 3, "warning": 2, "positive": 1.5, "info": 0}
    scores: Dict[str, float] = {}
    for a in alerts:
        w = weight.get(a["level"], 0)
        if w:
            scores[a["symbol"]] = scores.get(a["symbol"], 0) + w
    for t in analysis["tokens"]:
        if t["verdict"] == "sell":
            scores[t["symbol"]] = scores.get(t["symbol"], 0) + 2
        elif t["verdict"] == "reduce":
            scores[t["symbol"]] = scores.get(t["symbol"], 0) + 1
        if any(abs(n["tone"]) >= 2 for n in t["news"]):
            scores[t["symbol"]] = scores.get(t["symbol"], 0) + 1

    # Итог ассистента нужен в карточке каждого токена, поэтому у тех, где его
    # нет или он старше суток, приоритет: иначе один и тот же проблемный токен
    # разбирался бы каждый прогон, а остальные не получили бы итога никогда.
    for t in analysis["tokens"]:
        saved = last_insight(t["symbol"]) or {}
        age_hours = None
        if saved.get("at"):
            try:
                stamp = datetime.datetime.fromisoformat(saved["at"].replace("Z", "+00:00")).timestamp()
                age_hours = (time.time() - stamp) / 3600
            except Exception:
                age_hours = None
        if not saved.get("summary") or age_hours is None or age_hours > 24:
            scores[t["symbol"]] = scores.get(t["symbol"], 0) + 4

    picked = [t for t in analysis["tokens"] if scores.get(t["symbol"], 0) > 0 and t["valueUsd"] >= 20]
    picked.sort(key=lambda t: (scores.get(t["symbol"], 0), t["valueUsd"]), reverse=True)
    return picked[: max(0, limit)]


def get_job() -> Optional[Dict[str, Any]]:
    return store.read_json("agent-job.json", None)


def _update_job(patch: Dict[str, Any]) -> None:
    current = store.read_json("agent-job.json", None)
    if not current:
        return
    current.update(patch)
    store.write_json("agent-job.json", current)


def start_job(trigger: str) -> Dict[str, Any]:
    job = {
        "id": str(int(time.time() * 1000)),
        "status": "running",
        "trigger": trigger,
        "startedAt": _now(),
        "step": "разбираю портфель",
        "aiDone": 0,
        "aiTotal": 0,
    }
    store.write_json("agent-job.json", job)
    return job


def get_runs() -> List[Dict[str, Any]]:
    return store.read_json("agent-runs.json", []) or []


def run_agent(trigger: str = "manual") -> Dict[str, Any]:
    analysis = analyze_portfolio()
    prev = store.read_json("last-snapshot.json", None)
    alerts = _diff_alerts(analysis, prev) + analysis["alerts"]

    seen = set()
    unique = []
    for a in alerts:
        key = (a["level"], a["symbol"], a["title"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(a)

    settings = get_settings()
    important = [a for a in unique if a["level"] != "info"]
    should_send = bool(important) or settings["sendEmptyDigest"] or trigger == "manual"

    creds = ascn_credentials()
    ai_enabled = settings["ai"]["enabled"] and bool(creds["apiKey"]) and should_send
    candidates = _pick_for_ai(analysis, unique, settings["ai"]["maxTokensPerRun"]) if ai_enabled else []
    _update_job({"step": "ИИ разбирает токены" if candidates else "формирую сводку", "aiTotal": len(candidates)})

    ai_results: List[Dict[str, Any]] = []
    if candidates:
        lock = threading.Lock()
        done = [0]

        template = settings["ai"].get("template") or "full"

        def work(token):
            prompt = build_token_prompt(token, template=template,
                                        custom=settings["ai"].get("customPrompt") or "")
            res = ask_ascn(prompt, token["symbol"], creds)
            with lock:
                done[0] += 1
                ai_results.append(res)
                _update_job({"aiDone": done[0]})

        threads = [threading.Thread(target=work, args=(t,), daemon=True) for t in candidates]
        for t in threads:
            t.start()
        for t in threads:
            t.join(ASCN_TIMEOUT + 30)

    fresh = [r for r in ai_results if r.get("content")]
    for r in fresh:
        save_insight(r["symbol"], r["content"], settings["ai"].get("template") or "full", r.get("seconds"))

    _update_job({"step": "отправляю в Telegram"})
    digest = build_digest(analysis, unique, prev)
    telegram = {"sent": False, "error": "Нечего сообщать — важных изменений нет"}
    if should_send:
        telegram = send_telegram(digest)
        for r in fresh:
            part = "<b>🔍 %s — разбор ИИ</b>\n\n%s" % (escape_html(r["symbol"]), markdown_to_telegram(r["content"]))
            sub = send_telegram(part)
            if not sub["sent"] and telegram.get("sent"):
                telegram = {"sent": True, "error": "часть разборов не ушла: %s" % sub.get("error")}

    store.write_json("last-snapshot.json", _snapshot_of(analysis))

    run = {
        "id": str(int(time.time() * 1000)),
        "at": analysis["generatedAt"],
        "trigger": trigger,
        "totalValueUsd": analysis["totalValueUsd"],
        "alerts": unique,
        "telegram": telegram,
        "summary": re.sub(r"<[^>]+>", "", digest),
        "ai": [{"symbol": r["symbol"], "content": r.get("content"), "error": r.get("error"), "seconds": r.get("seconds", 0)} for r in ai_results],
    }
    history = get_runs()
    store.write_json("agent-runs.json", ([run] + history)[:60])
    _update_job({"status": "done", "step": "готово", "finishedAt": _now(), "runId": run["id"]})
    return run


def run_agent_background(trigger: str = "manual") -> Dict[str, Any]:
    """Разбор идёт минутами — запускаем в потоке и отдаём задачу сразу."""
    job = start_job(trigger)

    def worker():
        try:
            run_agent(trigger)
        except Exception as e:
            _update_job({"status": "error", "step": "ошибка", "finishedAt": _now(), "error": str(e)})

    threading.Thread(target=worker, daemon=True).start()
    return job

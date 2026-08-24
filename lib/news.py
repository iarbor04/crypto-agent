"""Новости: 14 публичных RSS плюс поиск по конкретной монете через Bing News.

Общие ленты пишут в основном про топ-10, поэтому по каждому токену
дополнительно запрашивается поисковая выдача с фильтром за последний месяц.
Google News не используем: его фид разрешён только для персональных читалок,
а выдача забита конвертерами валют и страницами с ценами.
"""

from __future__ import annotations

import re
import time
import urllib.parse
from typing import Any, Dict, List, Optional

from . import store
from .net import fetch_text

FEEDS = [
    ("https://cointelegraph.com/rss", "Cointelegraph"),
    ("https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk"),
    ("https://decrypt.co/feed", "Decrypt"),
    ("https://cryptoslate.com/feed/", "CryptoSlate"),
    ("https://www.theblock.co/rss.xml", "The Block"),
    ("https://u.today/rss", "U.Today"),
    ("https://ambcrypto.com/feed/", "AMBCrypto"),
    ("https://beincrypto.com/feed/", "BeInCrypto"),
    ("https://www.newsbtc.com/feed/", "NewsBTC"),
    ("https://cryptobriefing.com/feed/", "Crypto Briefing"),
    ("https://blockworks.co/feed", "Blockworks"),
    ("https://www.dlnews.com/arc/outboundfeeds/rss/", "DL News"),
    ("https://protos.com/feed/", "Protos"),
    ("https://bitcoinmagazine.com/feed", "Bitcoin Magazine"),
]

NEGATIVE = [
    (r"\b(hack|hacked|exploit|exploited|drain(ed)?|stolen)\b", 3, "взлом"),
    (r"\b(rug ?pull|scam|fraud|ponzi)\b", 3, "скам"),
    (r"\b(shut(ting)? down|shuts down|wind(ing)? down|bankrupt|insolvent|liquidation)\b", 3, "проект закрывается"),
    (r"\b(delist(ed|ing)?)\b|removed from (binance|coinbase|kraken|okx|bybit|upbit|the exchange)", 3, "делистинг"),
    (r"\b(sec (sues|charges|probe)|lawsuit|sued|indicted|investigation|subpoena)\b", 2, "юридические риски"),
    (r"\b(unlock|vesting|cliff|token unlock)\b", 2, "разлок токенов"),
    (r"\b(exit scam|team sold|insider(s)? sold|dump(ed|ing)?)\b", 2, "продажи команды"),
    (r"\b(depeg|depegged|bad debt|insolvency)\b", 3, "депег"),
    (r"\b(plunge|plummet|crash|tank(s|ed)?|slump|sell-?off|bleed)\b", 1, "падение"),
    (r"\b(layoff|lay ?offs|resign(ed|s|ation)|steps? down)\b", 1, "уход команды"),
    # «could halt ETH» в заголовках про цену — не остановка выводов, поэтому
    # требуем, чтобы рядом стояло, что именно остановили
    (r"(halt(s|ed)?|pause[sd]?|suspend(s|ed)?|freeze[sd]?)\s+(all\s+)?(trading|withdrawal|deposit|transfer|operation|redemption)"
     r"|(trading|withdrawals?|deposits?)\s+(are\s+|is\s+|were\s+)?(halted|paused|frozen|suspended)", 3, "остановка выводов"),
]

POSITIVE = [
    (r"\b(listing|listed on|lists)\b", 2, "листинг"),
    (r"\b(partnership|partners with|integrat(es|ion)|collaborat)\b", 1, "партнёрство"),
    (r"\b(mainnet|upgrade|launch(es|ed)?)\b", 1, "релиз"),
    (r"\b(buyback|burn(s|ed|ing)?|deflationary)\b", 2, "байбэк"),
    (r"\b(etf|institutional|treasury (buy|adds)|acquires?)\b", 2, "институционалы"),
    (r"\b(raise[sd]?|funding round|series [ab])\b", 1, "раунд"),
    (r"\b(record|all-?time high|ath|surge|rally|soar|jump(s|ed)?)\b", 1, "рост"),
    (r"\b(staking (live|launch)|rewards? (live|program)|airdrop)\b", 1, "награды"),
]

CRITICAL_TAGS = {"взлом", "скам", "делистинг", "проект закрывается", "депег", "остановка выводов"}

JUNK = re.compile(
    r"конвертировать|convert |price prediction|цена, график|прогноз цены|курс [a-z]{2,5} к|how to buy|где купить|калькулятор",
    re.I,
)


def score_headline(title: str) -> Dict[str, Any]:
    tone = 0
    tags: List[str] = []
    for pattern, weight, tag in NEGATIVE:
        if re.search(pattern, title, re.I):
            tone -= weight
            tags.append(tag)
    for pattern, weight, tag in POSITIVE:
        if re.search(pattern, title, re.I):
            tone += weight
            tags.append(tag)
    return {"tone": max(-3, min(3, tone)), "tags": sorted(set(tags), key=tags.index)}


def _decode(text: str) -> str:
    text = re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", text, flags=re.S)
    text = re.sub(r"<[^>]+>", "", text)
    for src, dst in [
        ("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'"), ("&apos;", "'"),
        ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&#8217;", "’"), ("&rsquo;", "’"),
    ]:
        text = text.replace(src, dst)
    return text.strip()


def _parse_date(raw: str) -> Optional[str]:
    if not raw:
        return None
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            parsed = time.strptime(raw.strip()[:31] if "%z" in fmt else raw.strip(), fmt)
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", parsed)
        except Exception:
            continue
    return None


def _parse_rss(xml: str, source: str, limit: int = 80) -> List[Dict[str, Any]]:
    items = re.findall(r"<item[\s>][\s\S]*?</item>", xml or "")[:limit]
    out = []
    for item in items:

        def pick(tag: str) -> str:
            m = re.search(r"<%s[^>]*>([\s\S]*?)</%s>" % (tag, tag), item, re.I)
            return _decode(m.group(1)) if m else ""

        title = pick("title")
        if not title:
            continue
        out.append(
            {
                "title": title,
                "url": pick("link") or pick("guid"),
                "source": source,
                "publishedAt": _parse_date(pick("pubDate") or pick("dc:date")),
                "body": (pick("description") or pick("content:encoded"))[:400],
            }
        )
    return out


def get_feed() -> List[Dict[str, Any]]:
    """Общая лента: качаем раз в 20 минут, дальше фильтруем по токену."""

    def loader():
        collected: List[Dict[str, Any]] = []
        for url, source in FEEDS:
            try:
                collected.extend(_parse_rss(fetch_text(url, timeout=15), source))
            except Exception:
                continue
        return collected

    try:
        return store.cached("news-feed.json", 20 * 60, loader) or []
    except Exception:
        return []


def _mentions(text: str, symbol: str, name: Optional[str]) -> bool:
    if not text:
        return False
    if name and len(name) > 3 and re.search(r"\b%s\b" % re.escape(name), text, re.I):
        return True
    # тикер ловим только в сильной форме: APE, $APE, (APE)
    if len(symbol) >= 3 and re.search(r"(^|[\s(\[$\"'])\$?%s($|[\s)\],.:;!?\"'])" % re.escape(symbol), text):
        return True
    return False


def _search_news(symbol: str, name: Optional[str]) -> List[Dict[str, Any]]:
    query = "%s crypto" % (name if name and len(name) > 3 else symbol)

    def url_for(fresh: bool) -> str:
        base = "https://www.bing.com/news/search?q=%s&format=RSS" % urllib.parse.quote(query)
        # qft=interval="8" — выдача за последний месяц, иначе поиск поднимает статьи трёхлетней давности
        return base + ('&qft=interval%3d%228%22' if fresh else "")

    def clean(xml: str) -> List[Dict[str, Any]]:
        rows = _parse_rss(xml, "Поиск")
        return [
            n
            for n in rows
            if not JUNK.search(n["title"])
            and not JUNK.search(n["body"])
            and (_mentions(n["title"], symbol, name) or _mentions(n["body"], symbol, name))
        ][:12]

    try:
        recent = clean(
            store.cached("search-fresh-%s.json" % symbol.lower(), 3600, lambda: fetch_text(url_for(True), timeout=15))
        )
        if len(recent) >= 2:
            return recent
        rest = clean(
            store.cached("search-%s.json" % symbol.lower(), 6 * 3600, lambda: fetch_text(url_for(False), timeout=15))
        )
        return recent + rest
    except Exception:
        return []


def get_news(symbol: str, name: Optional[str] = None, limit: int = 6) -> List[Dict[str, Any]]:
    feed = get_feed()
    from_feeds = [n for n in feed if _mentions(n["title"], symbol, name) or _mentions(n["body"], symbol, name)]
    relevant = from_feeds + _search_news(symbol, name)

    seen = set()
    unique = []
    for n in relevant:
        key = n["title"].lower()[:60]
        if key in seen:
            continue
        seen.add(key)
        scored = dict(n)
        scored.update(score_headline(n["title"]))
        age_days = None
        if n.get("publishedAt"):
            try:
                stamp = time.mktime(time.strptime(n["publishedAt"], "%Y-%m-%dT%H:%M:%SZ"))
                age_days = int((time.time() - stamp) / 86400)
            except Exception:
                age_days = None
        scored["ageDays"] = age_days
        # Монета в заголовке — новость про неё. Только в тексте — это упоминание:
        # «взломали Term Finance, вынесли Ethereum-депозиты» не делает ETH взломанным.
        scored["subject"] = _mentions(n["title"], symbol, name)
        unique.append(scored)

    def sort_key(n: Dict[str, Any]):
        fresh = 1 if (n["ageDays"] is not None and n["ageDays"] <= 14) else 0
        # свежие вперёд, внутри группы новее вперёд, и только потом по силе тона
        return (-fresh, -(0 if n["ageDays"] is None else -n["ageDays"]), -abs(n["tone"]))

    unique.sort(key=lambda n: (
        0 if (n["ageDays"] is not None and n["ageDays"] <= 14) else 1,
        n["ageDays"] if n["ageDays"] is not None else 9999,
        -abs(n["tone"]),
    ))
    return unique[:limit]

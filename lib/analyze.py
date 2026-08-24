"""Полный разбор портфеля: цены, доходности, ликвидность, новости, оценка риска.

Ни один источник не критичен: у каждого свой лимит времени, у всего разбора —
общий дедлайн. Что не успело, попадает в warnings, а страница показывает
остальное вместо ошибки.
"""

from __future__ import annotations

import datetime
import threading
import time
from typing import Any, Dict, List, Optional

from . import market as market_mod
from . import sources, store
from .net import run_parallel
from .news import get_news
from .score import risk_level, score_token
from .settings import get_portfolio, get_settings

STABLES = {"USDT", "USDC", "DAI", "USDE", "FDUSD", "TUSD", "PYUSD", "USDS", "RLUSD"}


def _money(n: float) -> str:
    return "$" + format(int(round(n)), ",").replace(",", " ")


def _soft(label: str, seconds: float, fn, fallback, warnings: set):
    """Источник со своим лимитом времени. Не успел или упал — идём дальше."""
    result = {"value": fallback, "done": False}

    def worker():
        try:
            result["value"] = fn()
            result["done"] = True
        except Exception:
            result["value"] = fallback

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join(seconds)
    if not result["done"] and thread.is_alive():
        warnings.add(label)
    elif not result["done"]:
        warnings.add(label)
    return result["value"]


def _exits_for(market: Optional[Dict[str, Any]], symbol: str) -> List[Dict[str, str]]:
    out = []
    if market and market.get("coinId"):
        out.append(
            {
                "label": "Где есть ликвидность",
                "url": "https://www.coingecko.com/en/coins/%s#markets" % market["coinId"],
                "hint": "Все биржи и пары с реальным объёмом — выходить надо там, где глубина стакана",
            }
        )
    out.append(
        {
            "label": "Свап на DEX (EVM)",
            "url": "https://app.1inch.io/",
            "hint": "Агрегатор соберёт маршрут по нескольким пулам — меньше проскальзывание",
        }
    )
    out.append({"label": "Свап на Solana", "url": "https://jup.ag/", "hint": "Если токен живёт в Solana — Jupiter даст маршрут"})
    out.append(
        {
            "label": "Хедж фьючерсом %s" % symbol,
            "url": "https://www.binance.com/en/futures/%sUSDT" % symbol,
            "hint": "Если продавать не хочется — можно зашортить эквивалент и убрать риск цены",
        }
    )
    return out


def _read_insight(symbol: str) -> Optional[Dict[str, Any]]:
    """Разбор ассистента живёт между прогонами агента — 48 часов."""
    everything = store.read_json("ai-insights.json", {}) or {}
    hit = everything.get(symbol.upper())
    if not hit:
        return None
    try:
        stamp = datetime.datetime.fromisoformat(hit["at"].replace("Z", "+00:00")).timestamp()
    except Exception:
        return None
    return hit if (time.time() - stamp) / 3600 <= 48 else None


def _portfolio_series(tokens: List[Dict[str, Any]]) -> List[int]:
    """Стоимость по часам за 7 дней — складываем спарклайны позиций."""
    with_series = [t for t in tokens if t.get("market") and len(t["market"].get("sparkline7d") or []) > 10]
    if not with_series:
        return []
    length = min(len(t["market"]["sparkline7d"]) for t in with_series)
    flat = sum(t["valueUsd"] for t in tokens if t not in with_series)
    series = [flat] * length
    for t in with_series:
        prices = t["market"]["sparkline7d"]
        offset = len(prices) - length
        for i in range(length):
            series[i] += prices[offset + i] * t["amount"]
    return [round(v) for v in series]


def build_alerts(tokens: List[Dict[str, Any]], context: Dict[str, Any]) -> List[Dict[str, Any]]:
    alerts: List[Dict[str, Any]] = []

    for t in tokens:
        peg = (context.get("stables") or {}).get(t["symbol"])
        if peg is not None and abs(peg - 1) > 0.005 and t["valueUsd"] >= 50:
            alerts.append(
                {
                    "level": "critical" if abs(peg - 1) > 0.02 else "warning",
                    "symbol": t["symbol"],
                    "title": "%s отклонился от привязки: $%.4f" % (t["symbol"], peg),
                    "body": "Стейблкоин торгуется %s доллара на %.2f%% — по позиции %s это %s"
                    % ("ниже" if peg < 1 else "выше", abs(peg - 1) * 100, _money(t["valueUsd"]), _money(abs(peg - 1) * t["valueUsd"])),
                    "action": "Проверить причину депега" if peg < 1 else "Отклонение вверх обычно временное",
                }
            )

    for t in tokens:
        level = risk_level(t["score"])["short"]
        bad = [r for r in t["reasons"] if r["kind"] == "bad"]
        if t["verdict"] in ("sell", "reduce"):
            capacity = (t.get("liquidity") or {}).get("sellCapacityUsd")
            action = "В позиции %s" % _money(t["valueUsd"])
            if capacity:
                action += ", рынок съедает за раз %s" % _money(capacity)
            alerts.append(
                {
                    "level": "critical" if t["verdict"] == "sell" else "warning",
                    "symbol": t["symbol"],
                    "title": "%s: риск %s" % (t["symbol"], level),
                    "body": "\n".join("• " + r["text"] for r in bad[:3]),
                    "action": action,
                }
            )

        good_news = next((n for n in t["news"] if n["tone"] >= 2 and (n.get("ageDays") or 99) <= 14), None)
        if good_news and t["score"] >= 55:
            alerts.append(
                {
                    "level": "positive",
                    "symbol": t["symbol"],
                    "title": "%s: позитив — %s" % (t["symbol"], ", ".join(good_news["tags"]) or "хорошие новости"),
                    "body": "«%s»" % good_news["title"],
                    "action": ("Ставка %.1f%% в год доступна в %s" % (t["best"]["apy"], t["best"]["project"])) if t.get("best") else "",
                }
            )

        best = t.get("best")
        if best and best["apy"] >= 3 and t["valueUsd"] >= 100 and t["verdict"] not in ("sell", "reduce"):
            alerts.append(
                {
                    "level": "info",
                    "symbol": t["symbol"],
                    "title": "%s лежит без дела: можно %.1f%% в год" % (t["symbol"], best["apy"]),
                    "body": "%s (%s) — риск %d/5, в пуле %s" % (best["project"], best["chain"], best["risk"], _money(best["tvlUsd"])),
                    "action": "Это ~%s в год с текущей позиции" % _money(t["potentialYearlyUsd"]),
                }
            )

    order = {"critical": 0, "warning": 1, "positive": 2, "info": 3}
    alerts.sort(key=lambda a: order[a["level"]])
    return alerts


def analyze_portfolio() -> Dict[str, Any]:
    settings = get_settings()
    holdings = get_portfolio()["holdings"]
    warnings: set = set()
    deadline = time.time() + 75

    def left() -> float:
        return max(2.0, deadline - time.time())

    ids: List[Optional[str]] = []
    for h in holdings:
        if h.get("coinId"):
            ids.append(h["coinId"])
        else:
            ids.append(_soft("тикер %s" % h["symbol"], min(15, left()), lambda s=h["symbol"]: market_mod.resolve_coin_id(s), None, warnings))

    markets = _soft(
        "цены CoinGecko", min(30, left()), lambda: market_mod.get_markets([i for i in ids if i]), {}, warnings
    )
    benchmark = _soft("бенчмарк рынка", min(20, left()), market_mod.get_benchmark, {"change7d": 0, "change30d": 0, "change200d": 0, "change1y": 0}, warnings)
    context = _soft("контекст рынка", min(25, left()), sources.get_market_context, {"fearGreed": None, "funding": {}, "stables": {}}, warnings)
    all_hacks = _soft("база взломов", min(25, left()), sources.get_hacks, [], warnings)

    # Профили тянем одной очередью: запросы к CoinGecko всё равно идут по одному,
    # и отдельный лимит на каждый токен съедал время последних в списке.
    # Словарь заполняется по ходу, поэтому при таймауте остаётся то, что успели.
    metas: Dict[str, Any] = {}

    def load_metas():
        for cid in [i for i in ids if i]:
            if cid in metas:
                continue
            try:
                metas[cid] = market_mod.get_coin_meta(cid)
            except Exception:
                metas[cid] = None
        return metas

    _soft("профили токенов", min(40, left()), load_metas, metas, warnings)

    # Ликвидность независима по токенам, а DexScreener отвечает медленно.
    # Тянем всё разом: четыре токена — это восемь секунд, а не тридцать два.
    liquidities: Dict[str, Any] = {}

    def load_liquidity():
        tasks = {}
        for i, h in enumerate(holdings):
            meta = metas.get(ids[i]) if ids[i] else None
            contract = ((meta or {}).get("chains") or [{}])[0].get("address") if meta else None
            tasks[h["symbol"]] = lambda s=h["symbol"], c=contract: sources.get_liquidity(s, c)
        liquidities.update(run_parallel(tasks, timeout=22))
        return liquidities

    _soft("стакан и DEX", min(25, left()), load_liquidity, liquidities, warnings)

    tokens: List[Dict[str, Any]] = []
    for i, h in enumerate(holdings):
        coin_id = ids[i]
        mkt = markets.get(coin_id) if coin_id else None
        value_usd = (mkt["price"] * h["amount"]) if mkt else 0
        is_stable = h["symbol"] in STABLES

        news = [] if is_stable else _soft("новости", min(20, left()), lambda s=h["symbol"], n=(mkt or {}).get("name"): get_news(s, n), [], warnings)
        opportunities = _soft(
            "пулы DeFiLlama", min(30, left()), lambda s=h["symbol"], v=value_usd: sources.get_opportunities(s, v), [], warnings
        )
        meta = metas.get(coin_id) if coin_id else None
        contract = ((meta or {}).get("chains") or [{}])[0].get("address") if meta else None
        liquidity = liquidities.get(h["symbol"])
        indicators = _soft("индикаторы", min(20, left()), lambda s=h["symbol"]: sources.get_indicators(s), None, warnings)
        cex_earn = _soft("вклады на биржах", min(12, left()), lambda s=h["symbol"]: sources.get_cex_earn(s), None, warnings)

        best = sources.pick_safe(opportunities)
        token_hacks = sources.find_hacks(all_hacks, (meta or {}).get("name") or (mkt or {}).get("name") or h["symbol"])[:3]

        if is_stable:
            scored = {
                "score": 70,
                "verdict": "hold",
                "reasons": [
                    {
                        "text": ("Стейблкоин: риска цены нет, но лежать без дела не должен — есть %.1f%% в год в %s (риск %d/5)"
                                 % (best["apy"], best["project"], best["risk"])) if best else "Стейблкоин: риска цены нет",
                        "weight": 0,
                        "kind": "neutral",
                    }
                ],
                "newsTone": 0,
            }
        else:
            scored = score_token(mkt, news, benchmark, opportunities, best, liquidity, value_usd, token_hacks)

        token = {
            "symbol": h["symbol"],
            "amount": h["amount"],
            "market": mkt,
            "meta": meta,
            "liquidity": liquidity,
            "indicators": indicators,
            "indicatorsRead": sources.read_indicators(indicators) if indicators else [],
            "ai": _read_insight(h["symbol"]),
            "cexEarn": cex_earn,
            "funding": (context.get("funding") or {}).get(h["symbol"]),
            "hacks": token_hacks,
            "valueUsd": value_usd,
            "share": 0.0,
            "score": scored["score"],
            "verdict": scored["verdict"],
            "risk": risk_level(scored["score"]),
            "reasons": scored["reasons"],
            "news": news,
            "newsTone": scored["newsTone"],
            "opportunities": opportunities,
            "best": best,
            "bestApy": best["apy"] if best else None,
            "potentialYearlyUsd": (value_usd * best["apy"] / 100) if best else 0,
            "exits": _exits_for(mkt, h["symbol"]),
        }
        if not mkt:
            token["error"] = "Токен не найден на CoinGecko — проверьте тикер"
        tokens.append(token)

    tokens.sort(key=lambda t: t["valueUsd"], reverse=True)
    total = sum(t["valueUsd"] for t in tokens)
    for t in tokens:
        t["share"] = (t["valueUsd"] / total * 100) if total else 0

    change24 = 0.0
    for t in tokens:
        ch = (t.get("market") or {}).get("change24h")
        if ch is not None and (100 + ch) != 0:
            change24 += t["valueUsd"] * ch / (100 + ch)

    return {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "refreshMinutes": settings["refreshMinutes"],
        "totalValueUsd": total,
        "change24hUsd": change24,
        "potentialYearlyUsd": sum(t["potentialYearlyUsd"] for t in tokens),
        "idleValueUsd": sum(t["valueUsd"] for t in tokens if t["best"]),
        "series": _portfolio_series(tokens),
        "context": context,
        "warnings": sorted(warnings),
        "partial": bool(warnings),
        "tokens": tokens,
        "alerts": build_alerts(tokens, context),
    }

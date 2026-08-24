"""Внешние источники, кроме CoinGecko: DeFiLlama, Binance, DexScreener, новости.

Ничего из этого не требует ключей. Каждая функция при ошибке возвращает
пустое значение — сервер не падает и показывает то, что удалось собрать.
"""

from __future__ import annotations

import math
import re
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from . import store
from .net import fetch_json, fetch_text

# ————— DeFiLlama: пулы доходности —————

LST_PREFIXES = {
    "ST", "WST", "R", "CB", "WEE", "EZ", "RS", "OS", "M", "J", "JITO", "B", "BN", "SW",
    "ANKR", "FRX", "SFRX", "LS", "YN", "PUF", "UNI", "SUPER", "STONE", "LIQ", "H", "K",
}


def get_pools() -> List[Dict[str, Any]]:
    """~16 тысяч пулов и 10 МБ json — режем до полезного и кэшируем на 30 минут."""

    def loader():
        res = fetch_json("https://yields.llama.fi/pools", timeout=45)
        out = []
        for p in res.get("data", []):
            if (p.get("tvlUsd") or 0) < 100_000 or (p.get("apy") or 0) <= 0:
                continue
            out.append(
                {
                    "chain": p.get("chain"),
                    "project": p.get("project"),
                    "symbol": p.get("symbol") or "",
                    "tvlUsd": round(p.get("tvlUsd") or 0),
                    "apy": p.get("apy"),
                    "apyBase": p.get("apyBase"),
                    "apyReward": p.get("apyReward"),
                    "apyMean30d": p.get("apyMean30d"),
                    "apyPct7D": p.get("apyPct7D"),
                    "pool": p.get("pool"),
                    "poolMeta": p.get("poolMeta"),
                    "stablecoin": p.get("stablecoin"),
                    "ilRisk": p.get("ilRisk"),
                    "exposure": p.get("exposure"),
                    "outlier": p.get("outlier"),
                    "pred": ((p.get("predictions") or {}) or {}).get("predictedClass"),
                }
            )
        return out

    try:
        return store.cached("llama-pools.json", 30 * 60, loader) or []
    except Exception:
        return []


def get_protocols() -> Dict[str, Dict[str, Any]]:
    def loader():
        rows = fetch_json("https://api.llama.fi/protocols", timeout=45)
        return {
            r["slug"]: {
                "slug": r["slug"],
                "name": r.get("name"),
                "category": r.get("category") or "",
                "url": r.get("url"),
                "audits": r.get("audits"),
            }
            for r in rows
            if r.get("slug")
        }

    try:
        return store.cached("llama-protocols.json", 24 * 3600, loader) or {}
    except Exception:
        return {}


def get_hacks() -> List[Dict[str, Any]]:
    """История взломов. amount у DeFiLlama уже в долларах: Ronin = 624 000 000."""

    def loader():
        rows = fetch_json("https://api.llama.fi/hacks", timeout=40)
        return [
            {
                "date": time.strftime("%Y-%m-%d", time.gmtime(r.get("date") or 0)),
                "name": r.get("name") or "",
                "amountUsd": round(r.get("amount") or 0),
                "technique": r.get("technique") or "",
            }
            for r in rows
        ]

    try:
        return store.cached("llama-hacks.json", 24 * 3600, loader) or []
    except Exception:
        return []


def _words(text: str) -> List[str]:
    return [w for w in re.split(r"[^a-z0-9]+", (text or "").lower()) if w]


# Названия взломов режем на слова один раз: find_hacks зовётся по разу
# на каждый подходящий пул, а список инцидентов один и тот же.
_hack_words: Dict[int, List[List[str]]] = {}
_hack_answers: Dict[str, List[Dict[str, Any]]] = {}


def _hack_index(all_hacks: List[Dict[str, Any]]) -> List[List[str]]:
    key = id(all_hacks)
    cached_words = _hack_words.get(key)
    if cached_words is None or len(cached_words) != len(all_hacks):
        cached_words = [_words(h.get("name")) for h in all_hacks]
        _hack_words.clear()
        _hack_words[key] = cached_words
    return cached_words


def find_hacks(all_hacks: List[Dict[str, Any]], name: str) -> List[Dict[str, Any]]:
    """Слова названия инцидента должны быть началом названия протокола.

    Подстрока не годится: «ethereum» цепляет Ethereum Classic и Verus-Ethereum Bridge.
    """
    target = _words(name)
    if not target or len(target[0]) < 3:
        return []
    memo_key = "%d|%s" % (len(all_hacks), " ".join(target))
    hit = _hack_answers.get(memo_key)
    if hit is not None:
        return hit
    index = _hack_index(all_hacks)
    hits = []
    for i, hw in enumerate(index):
        if not hw or len(hw) > len(target):
            continue
        if all(w == target[j] for j, w in enumerate(hw)):
            hits.append(all_hacks[i])
    hits = sorted(hits, key=lambda h: h["date"], reverse=True)
    if len(_hack_answers) > 2000:
        _hack_answers.clear()
    _hack_answers[memo_key] = hits
    return hits


def years_since(date: str) -> float:
    try:
        stamp = time.mktime(time.strptime(date, "%Y-%m-%d"))
    except Exception:
        return 99.0
    return (time.time() - stamp) / 31_536_000


def fmt_hack_amount(usd: float) -> str:
    if usd >= 1e9:
        return "$%.1fB" % (usd / 1e9)
    if usd >= 1e6:
        return "$%.1fM" % (usd / 1e6)
    if usd >= 1e3:
        return "$%dK" % round(usd / 1e3)
    return "$%d" % round(usd)


def _split_pool_symbol(sym: str) -> List[str]:
    return [p for p in re.split(r"[-/+_\s]+", sym or "") if p]


def _token_matches(pool_token: str, symbol: str) -> Optional[str]:
    t = re.sub(r"[^A-Z0-9]", "", (pool_token or "").upper())
    s = (symbol or "").upper()
    if not t:
        return None
    if t == s:
        return "exact"
    if t == "W" + s:
        return "wrapped"
    if len(t) > len(s) and t.endswith(s) and t[: len(t) - len(s)] in LST_PREFIXES:
        return "lst"
    return None


def _classify(pool: Dict[str, Any], category: str, match: str, parts: int) -> str:
    cat = (category or "").lower()
    if parts > 1:
        return "lp"
    if match == "lst" or "liquid staking" in cat or "restaking" in cat:
        return "liquid-staking"
    if "lending" in cat or "cdp" in cat:
        return "lending"
    if "staking" in cat or "yield" in cat:
        return "staking"
    if (pool.get("apyReward") or 0) > 0:
        return "farm"
    return "staking"


def _risk_of(pool: Dict[str, Any], category: str, kind: str, hacks: List[Dict[str, Any]]) -> Tuple[int, List[str]]:
    risk = 2
    notes: List[str] = []
    apy = pool.get("apy") or 0
    tvl = pool.get("tvlUsd") or 0

    if tvl < 1_000_000:
        risk += 2
        notes.append("В пуле меньше $1M — выход может оказаться дорогим")
    elif tvl < 10_000_000:
        risk += 1
        notes.append("В пуле меньше $10M")
    elif tvl > 500_000_000:
        risk -= 1
        notes.append("Большой пул — протокол проверенный")

    if pool.get("ilRisk") == "yes":
        risk += 1
        notes.append("Цены двух токенов могут разъехаться — часть вложенного превратится в подешевевший")
    if kind == "lp":
        notes.append("Нужны два актива, доход зависит от объёма торгов")

    reward_share = (pool.get("apyReward") or 0) / apy if apy else 0
    if reward_share > 0.7:
        risk += 1
        notes.append("Почти весь доход платится наградными токенами — так долго не держится")
    if apy > 100:
        risk += 1
        notes.append("Больше 100% в год — почти всегда временно")
    if apy > 500:
        risk += 1
    if pool.get("outlier"):
        risk += 1
        notes.append("DeFiLlama считает ставку выбросом")
    if pool.get("pred") == "Down":
        notes.append("Прогноз DeFiLlama: доходность скорее упадёт")
    if "cdp" in (category or "").lower():
        risk += 1
        notes.append("Залоговый протокол — есть риск ликвидации")

    recent = [h for h in hacks if years_since(h["date"]) < 3]
    if recent:
        worst = max(recent, key=lambda h: h["amountUsd"])
        fresh = years_since(worst["date"]) < 1
        big = worst["amountUsd"] >= 10_000_000
        medium = worst["amountUsd"] >= 1_000_000
        risk += (2 if fresh else 1) if big else (1 if medium and fresh else 0)
        notes.append(
            "Протокол взламывали %s на %s (%s)" % (worst["date"], fmt_hack_amount(worst["amountUsd"]), worst["technique"])
        )

    return max(1, min(5, int(risk))), notes


def get_opportunities(symbol: str, value_usd: float = 0, limit: int = 12) -> List[Dict[str, Any]]:
    """Куда можно поставить токен, отсортировано по устойчивой доходности."""
    pools = get_pools()
    protocols = get_protocols()
    all_hacks = get_hacks()
    sym = (symbol or "").upper()
    out: List[Dict[str, Any]] = []

    for p in pools:
        parts = _split_pool_symbol(p["symbol"])
        if len(parts) > 3:
            continue
        match = None
        for part in parts:
            match = _token_matches(part, sym)
            if match:
                break
        if not match:
            continue

        proto = protocols.get(p["project"]) or {}
        category = proto.get("category") or ""
        kind = _classify(p, category, match, len(parts))
        proto_hacks = find_hacks(all_hacks, proto.get("name") or p["project"])
        risk, notes = _risk_of(p, category, kind, proto_hacks)
        if match == "lst":
            notes.append("Через производный токен — деньги остаются ликвидными")
        if match == "wrapped":
            notes.append("Нужен wrapped-вариант (W%s)" % sym)

        apy = p.get("apy") or 0
        trend = None
        if p.get("apyPct7D") is not None:
            trend = "up" if p["apyPct7D"] > 0.5 else ("down" if p["apyPct7D"] < -0.5 else "flat")

        out.append(
            {
                "id": p["pool"],
                "kind": kind,
                "project": proto.get("name") or p["project"],
                "projectSlug": p["project"],
                "chain": p["chain"],
                "pair": ("%s (%s)" % (p["symbol"], p["poolMeta"])) if p.get("poolMeta") else p["symbol"],
                "apy": apy,
                "apyBase": p.get("apyBase"),
                "apyReward": p.get("apyReward"),
                "apyMean30d": p.get("apyMean30d"),
                "tvlUsd": p["tvlUsd"],
                "ilRisk": p.get("ilRisk") == "yes",
                "stablecoin": bool(p.get("stablecoin")),
                "risk": risk,
                "riskNotes": notes,
                "trend": trend,
                "url": "https://defillama.com/yields/pool/%s" % p["pool"],
                "yearlyUsd": (value_usd * apy / 100) if value_usd else 0,
            }
        )

    def quality(o: Dict[str, Any]) -> float:
        mean30 = o.get("apyMean30d")
        sustainable = min(o["apy"], mean30 * 1.3) if mean30 and mean30 > 0 else o["apy"] * 0.7
        effective = min(sustainable, 30)
        risk_factor = [1, 1, 0.8, 0.5, 0.22, 0.06][o["risk"]]
        depth = max(0.25, min(1.0, (math.log10(max(o["tvlUsd"], 1)) - 4) / 5))
        shape = 0.45 if o["kind"] == "lp" else (0.85 if o["kind"] == "farm" else 1.0)
        reward_share = (o.get("apyReward") or 0) / o["apy"] if o["apy"] else 0
        emission = 0.7 if reward_share > 0.6 else 1.0
        return effective * risk_factor * depth * shape * emission

    out.sort(key=quality, reverse=True)
    seen = set()
    unique = []
    for o in out:
        key = (o["project"], o["kind"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(o)
    return unique[:limit]


def pick_safe(opportunities: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """«Поставить сюда» — только один токен, умеренный риск, глубокий пул."""
    for o in opportunities:
        if o["kind"] != "lp" and o["risk"] <= 3 and o["tvlUsd"] >= 1_000_000 and o["apy"] >= 1:
            return o
    return None


def get_pool_history(pool_id: str) -> Optional[Dict[str, Any]]:
    if not re.match(r"^[a-z0-9-]{8,}$", pool_id or "", re.I):
        return None

    def loader():
        res = fetch_json("https://yields.llama.fi/chart/%s" % pool_id, timeout=30)
        points = [
            {"date": (p.get("timestamp") or "")[:10], "apy": p.get("apy") or 0, "tvlUsd": round(p.get("tvlUsd") or 0)}
            for p in (res.get("data") or [])
            if p.get("apy") is not None
        ][-180:]
        last90 = sorted(p["apy"] for p in points[-90:])
        return {
            "points": points,
            "apyMedian90d": last90[len(last90) // 2] if last90 else None,
            "apyMin90d": last90[0] if last90 else None,
            "apyMax90d": last90[-1] if last90 else None,
        }

    try:
        return store.cached("pool-%s.json" % pool_id, 6 * 3600, loader)
    except Exception:
        return None


def get_protocol_economics(slug: str) -> Optional[Dict[str, Any]]:
    if not slug:
        return None

    def loader():
        f = fetch_json("https://api.llama.fi/summary/fees/%s" % urllib.parse.quote(slug), timeout=30)
        return {
            "name": f.get("displayName") or f.get("name") or slug,
            "fees24h": f.get("total24h"),
            "fees30d": f.get("total30d"),
            "audits": f.get("audits"),
        }

    try:
        return store.cached("fees-%s.json" % slug, 24 * 3600, loader)
    except Exception:
        return None


# ————— Binance: стакан, свечи, фондирование —————

BINANCE = "https://api.binance.com/api/v3"


def binance_symbols() -> set:
    def loader():
        rows = fetch_json(BINANCE + "/ticker/price", timeout=25)
        return [r["symbol"] for r in rows if r["symbol"].endswith("USDT")]

    try:
        return set(store.cached("binance-symbols.json", 24 * 3600, loader) or [])
    except Exception:
        return set()


def _walk_bids(bids: List[List[str]], mid: float, max_drop_pct: float) -> float:
    floor = mid * (1 - max_drop_pct / 100)
    total = 0.0
    for price_s, qty_s in bids:
        price = float(price_s)
        if price < floor:
            break
        total += price * float(qty_s)
    return total


def get_orderbook(symbol: str) -> Optional[Dict[str, Any]]:
    pair = (symbol or "").upper() + "USDT"
    if pair not in binance_symbols():
        return None
    try:
        book = store.cached(
            "depth-%s.json" % pair, 5 * 60, lambda: fetch_json(BINANCE + "/depth?symbol=%s&limit=500" % pair, timeout=20)
        )
        bids, asks = book.get("bids") or [], book.get("asks") or []
        if not bids or not asks:
            return None
        best_bid, best_ask = float(bids[0][0]), float(asks[0][0])
        mid = (best_bid + best_ask) / 2
        if mid <= 0:
            return None
        return {
            "venue": "Binance",
            "pair": pair,
            "mid": mid,
            "spreadPct": (best_ask - best_bid) / mid * 100,
            "usd05": _walk_bids(bids, mid, 0.5),
            "usd1": _walk_bids(bids, mid, 1),
            "usd2": _walk_bids(bids, mid, 2),
        }
    except Exception:
        return None


def get_dex_liquidity(address: str) -> Optional[Dict[str, Any]]:
    if not address:
        return None
    try:
        res = store.cached(
            "dex-%s.json" % address[:12],
            # DexScreener отвечает медленно (до 20 секунд) и упирался в общий
            # лимит на каждом разборе. Глубина пулов меняется небыстро, поэтому
            # держим ответ час, а ждём не дольше восьми секунд: не успел —
            # берётся прошлое значение из кэша.
            60 * 60,
            lambda: fetch_json("https://api.dexscreener.com/latest/dex/tokens/%s" % address, timeout=15),
        )
        pairs = res.get("pairs") or []
        if not pairs:
            return None
        mapped = sorted(
            [
                {
                    "chain": p.get("chainId"),
                    "dex": p.get("dexId"),
                    "pair": "%s/%s" % ((p.get("baseToken") or {}).get("symbol"), (p.get("quoteToken") or {}).get("symbol")),
                    "liquidityUsd": round((p.get("liquidity") or {}).get("usd") or 0),
                    "volume24h": round((p.get("volume") or {}).get("h24") or 0),
                    "url": p.get("url"),
                }
                for p in pairs
            ],
            key=lambda p: p["liquidityUsd"],
            reverse=True,
        )
        return {"totalUsd": sum(p["liquidityUsd"] for p in mapped), "pairs": mapped[:4]}
    except Exception:
        return None


DEX_DEPTH_SHARE = 0.0025


def get_liquidity(symbol: str, contract: Optional[str]) -> Optional[Dict[str, Any]]:
    book = get_orderbook(symbol)
    dex = get_dex_liquidity(contract) if contract else None
    if not book and not dex:
        return None
    dex_depth = (dex["totalUsd"] * DEX_DEPTH_SHARE) if dex else 0
    return {
        "binance": book,
        "dexTotalUsd": dex["totalUsd"] if dex else 0,
        "dexPairs": dex["pairs"] if dex else [],
        "sellCapacityUsd": round((book["usd1"] if book else 0) + dex_depth),
    }


def get_venues(coin_id: str, limit: int = 6) -> List[Dict[str, Any]]:
    """Площадки со спредом — отвечает на «где именно продавать»."""
    from .net import cg_get

    if not coin_id:
        return []
    stable = {"USDT", "USDC", "USD", "FDUSD", "BUSD", "DAI", "EUR"}
    try:
        res = store.cached(
            "venues-%s.json" % coin_id, 30 * 60, lambda: cg_get("/coins/%s/tickers" % coin_id, {"depth": "true"}, timeout=25)
        )
        rows = []
        for t in res.get("tickers") or []:
            if str(t.get("target", "")).upper() not in stable:
                continue
            rows.append(
                {
                    "name": (t.get("market") or {}).get("name"),
                    "pair": "%s/%s" % (t.get("base"), t.get("target")),
                    "volumeUsd": round((t.get("converted_volume") or {}).get("usd") or 0),
                    "spreadPct": t.get("bid_ask_spread_percentage"),
                    "url": t.get("trade_url"),
                }
            )
        rows.sort(key=lambda r: r["volumeUsd"], reverse=True)
        return rows[:limit]
    except Exception:
        return []


# ————— Индикаторы по дневным свечам —————


def _rsi(close: List[float], period: int = 14) -> Optional[float]:
    if len(close) < period + 1:
        return None
    gain = loss = 0.0
    for i in range(1, period + 1):
        d = close[i] - close[i - 1]
        gain += max(d, 0)
        loss += max(-d, 0)
    avg_gain, avg_loss = gain / period, loss / period
    for i in range(period + 1, len(close)):
        d = close[i] - close[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(d, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-d, 0)) / period
    if avg_loss == 0:
        return 100.0
    return 100 - 100 / (1 + avg_gain / avg_loss)


def _sma(values: List[float], n: int) -> Optional[float]:
    return sum(values[-n:]) / n if len(values) >= n else None


def get_indicators(symbol: str) -> Optional[Dict[str, Any]]:
    pair = (symbol or "").upper() + "USDT"
    if pair not in binance_symbols():
        return None
    try:
        rows = store.cached(
            "klines-%s.json" % pair,
            3600,
            lambda: fetch_json(BINANCE + "/klines?symbol=%s&interval=1d&limit=210" % pair, timeout=25),
        )
        if not rows or len(rows) < 30:
            return None
        high = [float(r[2]) for r in rows]
        low = [float(r[3]) for r in rows]
        close = [float(r[4]) for r in rows]
        volume = [float(r[5]) for r in rows]
        price = close[-1]
        sma50, sma200 = _sma(close, 50), _sma(close, 200)

        atr_sum = 0.0
        for i in range(len(close) - 14, len(close)):
            atr_sum += max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
        atr_pct = (atr_sum / 14) / price * 100 if price else None

        range_high, range_low = max(high[-30:]), min(low[-30:])
        vol_now, vol_base = _sma(volume, 7), _sma(volume, 30)
        return {
            "rsi14": _rsi(close),
            "sma50": sma50,
            "sma200": sma200,
            "aboveSma50": (price > sma50) if sma50 else None,
            "goldenCross": (sma50 > sma200) if (sma50 and sma200) else None,
            "atrPct": atr_pct,
            "rangeHigh": range_high,
            "rangeLow": range_low,
            "rangePosition": ((price - range_low) / (range_high - range_low) * 100) if range_high > range_low else None,
            "volumeTrendPct": ((vol_now / vol_base - 1) * 100) if (vol_now and vol_base) else None,
            "source": pair,
        }
    except Exception:
        return None


def read_indicators(ind: Dict[str, Any]) -> List[Dict[str, str]]:
    """Расшифровка индикаторов словами — для карточки и промпта."""
    out: List[Dict[str, str]] = []
    rsi = ind.get("rsi14")
    if rsi is not None:
        if rsi >= 70:
            out.append({"text": "RSI %d — перекупленность, покупатели выдохлись" % rsi, "tone": "bad"})
        elif rsi <= 30:
            out.append({"text": "RSI %d — перепроданность, продавцы выдохлись" % rsi, "tone": "good"})
        else:
            out.append({"text": "RSI %d — без крайностей" % rsi, "tone": "neutral"})
    if ind.get("aboveSma50") is not None:
        above = ind["aboveSma50"]
        out.append(
            {"text": "Цена %s средней за 50 дней" % ("выше" if above else "ниже"), "tone": "good" if above else "bad"}
        )
    if ind.get("goldenCross") is not None:
        up = ind["goldenCross"]
        out.append(
            {
                "text": "Средняя за 50 дней %s годовой — тренд %s" % (("выше", "вверх") if up else ("ниже", "вниз")),
                "tone": "good" if up else "bad",
            }
        )
    pos = ind.get("rangePosition")
    if pos is not None:
        out.append(
            {
                "text": "В месячном коридоре цена на %d%% пути от минимума к максимуму" % pos,
                "tone": "good" if pos >= 75 else ("bad" if pos <= 25 else "neutral"),
            }
        )
    vol = ind.get("volumeTrendPct")
    if vol is not None:
        if vol > 25:
            out.append({"text": "Объёмы за неделю выше месячных на %d%% — интерес растёт" % vol, "tone": "good"})
        elif vol < -25:
            out.append({"text": "Объёмы за неделю ниже месячных на %d%% — интерес уходит" % abs(vol), "tone": "bad"})
        else:
            out.append({"text": "Объёмы держатся на уровне месяца", "tone": "neutral"})
    if ind.get("atrPct") is not None:
        out.append({"text": "Средний дневной размах %.1f%%" % ind["atrPct"], "tone": "neutral"})
    return out


# ————— Контекст рынка —————


def get_fear_greed() -> Optional[Dict[str, Any]]:
    labels = {
        "Extreme Fear": "крайний страх",
        "Fear": "страх",
        "Neutral": "нейтрально",
        "Greed": "жадность",
        "Extreme Greed": "крайняя жадность",
    }
    try:
        res = store.cached("fear-greed.json", 3600, lambda: fetch_json("https://api.alternative.me/fng/?limit=1", timeout=15))
        first = (res.get("data") or [None])[0]
        if not first:
            return None
        return {"value": int(first["value"]), "label": labels.get(first["value_classification"], first["value_classification"])}
    except Exception:
        return None


def get_funding() -> Dict[str, float]:
    """Ставки фондирования по всем перпам одним запросом."""

    def loader():
        return fetch_json("https://fapi.binance.com/fapi/v1/premiumIndex", timeout=25)

    try:
        rows = store.cached("funding.json", 15 * 60, loader) or []
        out = {}
        for r in rows:
            sym = r.get("symbol") or ""
            if not sym.endswith("USDT"):
                continue
            try:
                out[sym[:-4]] = float(r.get("lastFundingRate"))
            except (TypeError, ValueError):
                continue
        return out
    except Exception:
        return {}


def get_stable_prices() -> Dict[str, float]:
    def loader():
        return fetch_json("https://stablecoins.llama.fi/stablecoins?includePrices=true", timeout=40)

    try:
        res = store.cached("stablecoins.json", 6 * 3600, loader) or {}
        out = {}
        for a in res.get("peggedAssets") or []:
            if a.get("price") is not None:
                out[str(a.get("symbol", "")).upper()] = float(a["price"])
        return out
    except Exception:
        return {}


def get_market_context() -> Dict[str, Any]:
    return {"fearGreed": get_fear_greed(), "funding": get_funding(), "stables": get_stable_prices()}


# ————— История стоимости портфеля —————


def get_portfolio_history(pairs: List[Tuple[str, float]], days: int) -> Dict[str, Any]:
    """Цены за любой период. Лимит coins.llama.fi — 500 точек на запрос суммарно."""
    span = max(7, min(days, 730))
    if not pairs:
        return {"days": span, "series": [], "from": ""}

    per_coin = max(20, min(span, 500 // len(pairs)))
    step_days = max(1, math.ceil(span / per_coin))
    points = math.ceil(span / step_days)
    ids = "_".join(sorted(p[0] for p in pairs))[:60]

    def loader():
        coins = ",".join("coingecko:%s" % pid for pid, _ in pairs)
        start = int(time.time()) - span * 86400
        return fetch_json(
            "https://coins.llama.fi/chart/%s?start=%d&span=%d&period=%dd" % (coins, start, points, step_days),
            timeout=30,
        )

    try:
        chart = store.cached("history-%d-%s.json" % (span, ids), 3600, loader) or {}
    except Exception:
        return {"days": span, "series": [], "from": ""}

    rows = []
    for pid, amount in pairs:
        prices = ((chart.get("coins") or {}).get("coingecko:%s" % pid) or {}).get("prices") or []
        if len(prices) > 2:
            rows.append((amount, prices))
    if not rows:
        return {"days": span, "series": [], "from": ""}

    length = min(len(p) for _, p in rows)
    series = [0.0] * length
    for amount, prices in rows:
        offset = len(prices) - length
        for i in range(length):
            series[i] += prices[offset + i]["price"] * amount
    first_ts = rows[0][1][len(rows[0][1]) - length]["timestamp"]
    return {
        "days": span,
        "series": [round(v) for v in series],
        "from": time.strftime("%Y-%m-%d", time.gmtime(first_ts)),
    }

def get_cex_earn(symbol: str) -> Optional[Dict[str, Any]]:
    """Ставка биржевого вклада. Без ключа отдаёт только OKX: у Binance,
    Bybit и KuCoin эти эндпоинты закрыты подписью, выдумывать их нельзя."""

    def loader():
        rows = (fetch_json("https://www.okx.com/api/v5/finance/savings/lending-rate-summary", timeout=12) or {}).get("data") or []
        out = {}
        for r in rows:
            try:
                rate = float(r.get("estRate") or r.get("preRate") or 0) * 100
            except (TypeError, ValueError):
                continue
            if rate > 0:
                out[(r.get("ccy") or "").upper()] = round(rate, 2)
        return out

    try:
        table = store.cached("cex-earn.json", 60 * 60, loader) or {}
    except Exception:
        return None
    apy = table.get(symbol.upper())
    if not apy:
        return None
    return {"venue": "OKX", "kind": "Гибкий вклад", "apy": apy, "note": "ставка плавающая, начисление ежедневно"}

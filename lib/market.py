"""CoinGecko: цены, профили монет, поиск тикеров."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, List, Optional

from . import store
from .net import cg_get
from .settings import get_settings

CHAIN_LABEL = {
    "ethereum": "Ethereum",
    "binance-smart-chain": "BNB Chain",
    "polygon-pos": "Polygon",
    "arbitrum-one": "Arbitrum",
    "optimistic-ethereum": "Optimism",
    "solana": "Solana",
    "base": "Base",
    "avalanche": "Avalanche",
    "hyperevm": "HyperEVM",
    "monad": "Monad",
    "sui": "Sui",
    "tron": "Tron",
    "ton": "TON",
}


def _hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:10]


def resolve_coin_id(symbol: str) -> Optional[str]:
    """Тикер -> id CoinGecko. Точное совпадение тикера важнее ранга."""
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    mapping = store.read_json("symbol-map.json", {})
    if sym in mapping:
        return mapping[sym]

    coin_id = None
    try:
        res = cg_get("/search", {"query": sym})
        coins = res.get("coins", []) if isinstance(res, dict) else []
        exact = [c for c in coins if str(c.get("symbol", "")).upper() == sym]
        pool = exact or coins
        pool.sort(key=lambda c: c.get("market_cap_rank") or 10 ** 9)
        coin_id = pool[0]["id"] if pool else None
    except Exception:
        return None

    if coin_id:
        store.update_json("symbol-map.json", {}, lambda cur: dict(cur, **{sym: coin_id}))
    return coin_id


def search_coins(query: str, limit: int = 6) -> List[Dict[str, Any]]:
    q = (query or "").strip()
    if len(q) < 2:
        return []
    try:
        res = cg_get("/search", {"query": q})
    except Exception:
        return []
    coins = res.get("coins", []) if isinstance(res, dict) else []
    by_rank = lambda c: c.get("market_cap_rank") or 10 ** 9
    exact = sorted([c for c in coins if str(c.get("symbol", "")).upper() == q.upper()], key=by_rank)
    rest = sorted([c for c in coins if str(c.get("symbol", "")).upper() != q.upper()], key=by_rank)
    out = []
    for c in (exact + rest)[:limit]:
        out.append(
            {
                "coinId": c.get("id"),
                "symbol": str(c.get("symbol", "")).upper(),
                "name": c.get("name"),
                "rank": c.get("market_cap_rank"),
                "image": c.get("large") or c.get("thumb"),
            }
        )
    return out


def get_markets(coin_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """Рыночные данные пачкой. Срок жизни кэша задаёт пользователь."""
    ids = sorted({i for i in coin_ids if i})
    if not ids:
        return {}
    ttl = get_settings()["refreshMinutes"] * 60
    key = "markets-%s.json" % _hash(",".join(ids))

    def loader():
        return cg_get(
            "/coins/markets",
            {
                "vs_currency": "usd",
                "ids": ",".join(ids),
                "sparkline": "true",
                "price_change_percentage": "1h,24h,7d,30d,200d,1y",
                "per_page": "250",
            },
            timeout=30,
        )

    rows = store.cached(key, ttl, loader) or []
    out: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        out[r.get("id")] = {
            "coinId": r.get("id"),
            "symbol": str(r.get("symbol", "")).upper(),
            "name": r.get("name"),
            "image": r.get("image"),
            "price": r.get("current_price") or 0,
            "marketCap": r.get("market_cap") or 0,
            "rank": r.get("market_cap_rank"),
            "volume24h": r.get("total_volume") or 0,
            "change1h": r.get("price_change_percentage_1h_in_currency"),
            "change24h": r.get("price_change_percentage_24h_in_currency"),
            "change7d": r.get("price_change_percentage_7d_in_currency"),
            "change30d": r.get("price_change_percentage_30d_in_currency"),
            "change200d": r.get("price_change_percentage_200d_in_currency"),
            "change1y": r.get("price_change_percentage_1y_in_currency"),
            "athChangePct": r.get("ath_change_percentage"),
            "athDate": r.get("ath_date"),
            "circulatingSupply": r.get("circulating_supply"),
            "totalSupply": r.get("total_supply"),
            "sparkline7d": ((r.get("sparkline_in_7d") or {}).get("price") or []),
        }
    return out


def get_benchmark() -> Dict[str, float]:
    """Рынок целиком: если токен падает, а рынок растёт — дело в токене."""
    zero = {"change7d": 0.0, "change30d": 0.0, "change200d": 0.0, "change1y": 0.0}
    try:
        markets = get_markets(["bitcoin", "ethereum"])
        values = list(markets.values())
        if not values:
            return zero
        out = {}
        for field in zero:
            nums = [v.get(field) or 0 for v in values]
            out[field] = sum(nums) / len(nums)
        return out
    except Exception:
        return zero


def _plain_text(html: str, limit: int = 320) -> str:
    text = re.sub(r"<[^>]+>", "", html or "")
    text = (
        text.replace("&amp;", "&").replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")
    )
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    dot = cut.rfind(". ")
    return cut[: dot + 1] if dot > limit * 0.5 else cut.rstrip() + "…"


def _pick_categories(raw: List[Optional[str]]) -> List[str]:
    clean = [c for c in (raw or []) if c]
    meaningful = [c for c in clean if not re.search(r"ecosystem|portfolio|index$", c, re.I)]
    return (meaningful or clean)[:4]


def get_coin_meta(coin_id: str) -> Optional[Dict[str, Any]]:
    """Профиль токена: ранг, категории, описание, ссылки, контракты. Кэш сутки."""
    if not coin_id:
        return None
    try:

        def loader():
            c = cg_get(
                "/coins/" + coin_id,
                {
                    "localization": "false",
                    "tickers": "false",
                    "market_data": "false",
                    "community_data": "false",
                    "developer_data": "false",
                    "sparkline": "false",
                },
                timeout=25,
            )
            platforms = c.get("platforms") or {}
            chains = [
                {"chain": CHAIN_LABEL.get(k, k), "address": v}
                for k, v in list(platforms.items())[:6]
                if k and v
            ]
            links = c.get("links") or {}
            homepage = next((u for u in (links.get("homepage") or []) if u), None)
            explorer = next((u for u in (links.get("blockchain_site") or []) if u), None)
            twitter = links.get("twitter_screen_name")
            github = next(iter(((links.get("repos_url") or {}).get("github") or [])), None)
            desc = c.get("description") or {}
            return {
                "coinId": c.get("id"),
                "name": c.get("name"),
                "symbol": str(c.get("symbol", "")).upper(),
                "rank": c.get("market_cap_rank"),
                "categories": _pick_categories(c.get("categories") or []),
                "description": _plain_text(desc.get("ru") or desc.get("en") or ""),
                "homepage": homepage,
                "explorer": explorer,
                "twitter": ("https://x.com/" + twitter) if twitter else None,
                "github": github,
                "chains": chains,
                "genesisDate": c.get("genesis_date"),
                "watchlistUsers": c.get("watchlist_portfolio_users"),
                "cgUrl": "https://www.coingecko.com/en/coins/" + str(c.get("id")),
            }

        return store.cached("coin-%s.json" % coin_id, 24 * 3600, loader)
    except Exception:
        return None


def get_prices(coin_ids: List[str]) -> Dict[str, float]:
    """Только цены — для ввода суммы в долларах в редакторе портфеля."""
    markets = get_markets(coin_ids)
    return {cid: m["price"] for cid, m in markets.items()}

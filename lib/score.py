"""Оценка позиции 0..100. Наружу показывается как уровень риска словами.

Восемь блоков, каждый со своим весом, чтобы решение было объяснимым: карточка
показывает не только уровень, но и какие именно факторы его сделали.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from .news import CRITICAL_TAGS
from .sources import fmt_hack_amount

VERDICT_ORDER = ["accumulate", "hold", "watch", "reduce", "sell"]


def ramp(value: Optional[float], lo: float, hi: float, points: float) -> float:
    if value is None:
        return points * 0.5
    t = (value - lo) / (hi - lo)
    return max(0.0, min(1.0, t)) * points


def _pct(n: Optional[float]) -> str:
    if n is None:
        return "н/д"
    return "%s%.1f%%" % ("+" if n > 0 else "", n)


def _short(n: float) -> str:
    a = abs(n)
    if a >= 1e9:
        return "%.1fB" % (n / 1e9)
    if a >= 1e6:
        return "%.1fM" % (n / 1e6)
    if a >= 1e3:
        return "%.1fK" % (n / 1e3)
    return "%d" % n


def _money(n: float) -> str:
    return "$" + format(int(round(n)), ",").replace(",", " ")


def verdict_of(score: float) -> str:
    if score < 28:
        return "sell"
    if score < 42:
        return "reduce"
    if score < 56:
        return "watch"
    if score < 72:
        return "hold"
    return "accumulate"


def risk_level(score: float) -> Dict[str, Any]:
    """Наружу — слова, не число. Полоса заполняется вместе с риском."""
    pct = max(4, min(100, 100 - score))
    if score < 28:
        return {"label": "Риск критический", "short": "критический", "step": 1, "pct": pct}
    if score < 42:
        return {"label": "Риск высокий", "short": "высокий", "step": 2, "pct": pct}
    if score < 56:
        return {"label": "Риск повышенный", "short": "повышенный", "step": 3, "pct": pct}
    if score < 72:
        return {"label": "Риск умеренный", "short": "умеренный", "step": 4, "pct": pct}
    return {"label": "Риск низкий", "short": "низкий", "step": 5, "pct": pct}


def score_token(
    market: Optional[Dict[str, Any]],
    news: List[Dict[str, Any]],
    benchmark: Dict[str, float],
    opportunities: List[Dict[str, Any]],
    best: Optional[Dict[str, Any]],
    liquidity: Optional[Dict[str, Any]],
    value_usd: float,
    hacks: List[Dict[str, Any]],
) -> Dict[str, Any]:
    reasons: List[Dict[str, Any]] = []

    if not market:
        return {
            "score": 35,
            "verdict": "watch",
            "reasons": [{"text": "Нет рыночных данных — токен не найден на CoinGecko", "weight": 0, "kind": "neutral"}],
            "newsTone": 0,
        }

    # 1. Динамика против рынка (25)
    rel7 = (market.get("change7d") or 0) - benchmark.get("change7d", 0)
    rel30 = (market.get("change30d") or 0) - benchmark.get("change30d", 0)
    rel_score = ramp(rel7, -20, 15, 12) + ramp(rel30, -30, 25, 13)
    if rel7 < -8 or rel30 < -15:
        reasons.append(
            {
                "text": "Отстаёт от рынка: %s за 7д и %s за 30д относительно BTC/ETH" % (_pct(rel7), _pct(rel30)),
                "weight": -(25 - rel_score),
                "kind": "bad",
            }
        )
    elif rel7 > 8 or rel30 > 15:
        reasons.append(
            {
                "text": "Сильнее рынка: %s за 7д и %s за 30д относительно BTC/ETH" % (_pct(rel7), _pct(rel30)),
                "weight": rel_score - 12,
                "kind": "good",
            }
        )

    # 2. Абсолютный тренд 30 дней (10)
    trend_score = ramp(market.get("change30d"), -35, 15, 10)
    if (market.get("change30d") or 0) < -20:
        reasons.append({"text": "Цена за 30 дней %s" % _pct(market.get("change30d")), "weight": -(10 - trend_score), "kind": "bad"})
    elif (market.get("change30d") or 0) > 15:
        reasons.append({"text": "Цена за 30 дней %s" % _pct(market.get("change30d")), "weight": trend_score - 5, "kind": "good"})

    # 3. Ликвидность выхода (10): реальная глубина против размера позиции
    vol_ratio = (market.get("volume24h") or 0) / market["marketCap"] if market.get("marketCap") else 0
    capacity = (liquidity or {}).get("sellCapacityUsd") or 0
    if capacity > 0 and value_usd > 0:
        cover = capacity / value_usd
        import math

        liq_score = ramp(math.log10(max(cover, 0.01)), -0.5, 1.3, 10)
        if cover < 1.5:
            reasons.append(
                {
                    "text": "Позиция %s против ёмкости выхода %s — за один раз не продать, цену уроните сами"
                    % (_money(value_usd), _money(capacity)),
                    "weight": -(10 - liq_score),
                    "kind": "bad",
                }
            )
        elif cover > 15:
            reasons.append(
                {
                    "text": "Ликвидности с запасом: рынок съедает %s за раз при позиции %s" % (_money(capacity), _money(value_usd)),
                    "weight": 4,
                    "kind": "good",
                }
            )
    else:
        liq_score = ramp(vol_ratio, 0.002, 0.04, 10)
        if vol_ratio < 0.005:
            reasons.append(
                {
                    "text": "Тонкий объём: $%s в сутки при капитализации $%s — выходить придётся частями"
                    % (_short(market.get("volume24h") or 0), _short(market.get("marketCap") or 0)),
                    "weight": -(10 - liq_score),
                    "kind": "bad",
                }
            )
        elif vol_ratio > 0.03:
            reasons.append(
                {"text": "Хорошая ликвидность: оборот %.1f%% капитализации в сутки" % (vol_ratio * 100), "weight": 4, "kind": "good"}
            )

    if 0 < (market.get("marketCap") or 0) < 5_000_000:
        liq_score = min(liq_score, 3)
        reasons.append(
            {"text": "Капитализация всего $%s — микрокап, риск манипуляций" % _short(market["marketCap"]), "weight": -8, "kind": "bad"}
        )

    # 4. Новости (18) — только свежие: поиск поднимает статьи трёхлетней давности
    fresh = [n for n in news if n.get("ageDays") is not None and n["ageDays"] <= 14]
    tones = [n["tone"] for n in fresh]
    worst = min(tones) if tones else 0
    best_tone = max(tones) if tones else 0
    news_tone = (sum(tones) / len(tones)) if tones else 0
    news_score = ramp(worst * 0.6 + best_tone * 0.4, -3, 2.5, 18)
    critical = [n for n in fresh if set(n.get("tags") or []) & CRITICAL_TAGS]
    if critical:
        reasons.append(
            {
                "text": "Критичный новостной фон (%s): «%s»" % (", ".join(critical[0]["tags"]), critical[0]["title"][:110]),
                "weight": -20,
                "kind": "bad",
            }
        )
    elif worst <= -2:
        hit = next((n for n in fresh if n["tone"] == worst), None)
        reasons.append({"text": "Негативные новости: «%s»" % (hit["title"][:110] if hit else ""), "weight": -10, "kind": "bad"})
    elif best_tone >= 2:
        hit = next((n for n in fresh if n["tone"] == best_tone), None)
        reasons.append({"text": "Позитивные новости: «%s»" % (hit["title"][:110] if hit else ""), "weight": 8, "kind": "good"})

    # 5. Структурный тренд (15) — 200 дней и год, тоже относительно рынка
    rel200 = (market.get("change200d") or 0) - benchmark.get("change200d", 0)
    rel1y = (market.get("change1y") or 0) - benchmark.get("change1y", 0)
    struct_score = ramp(rel200, -40, 25, 7) + ramp(rel1y, -60, 50, 8)
    if rel1y < -25 or rel200 < -20:
        reasons.append(
            {
                "text": "Долго проигрывает рынку: %s за 200 дней и %s за год (рынок %s)"
                % (_pct(market.get("change200d")), _pct(market.get("change1y")), _pct(benchmark.get("change1y"))),
                "weight": -(15 - struct_score),
                "kind": "bad",
            }
        )
    elif rel1y > 25:
        reasons.append(
            {
                "text": "Обгоняет рынок вдолгую: %s за год против %s у рынка" % (_pct(market.get("change1y")), _pct(benchmark.get("change1y"))),
                "weight": struct_score - 7,
                "kind": "good",
            }
        )

    # 6. Просадка от максимума и его давность (12)
    ath = market.get("athChangePct") if market.get("athChangePct") is not None else -50
    ath_years = 1.0
    if market.get("athDate"):
        try:
            stamp = time.mktime(time.strptime(market["athDate"][:10], "%Y-%m-%d"))
            ath_years = (time.time() - stamp) / 31_536_000
        except Exception:
            ath_years = 1.0
    ath_fresh = 4 if ath_years < 1 else (2 if ath_years < 2 else 0)
    ath_score = ramp(ath, -97, -35, 8) + ath_fresh
    if ath < -90:
        suffix = " (хай был %.1f года назад)" % ath_years if ath_years >= 2 else ""
        reasons.append(
            {
                "text": "Ниже исторического максимума на %.1f%%%s — рынок давно потерял веру" % (min(99.9, abs(ath)), suffix),
                "weight": -(12 - ath_score),
                "kind": "bad",
            }
        )

    # 7. Разлоки (8)
    unlock_score = 8.0
    circ, total = market.get("circulatingSupply"), market.get("totalSupply")
    if circ and total and total > 0:
        share = circ / total
        unlock_score = ramp(share, 0.3, 0.9, 8)
        if share < 0.6:
            reasons.append(
                {
                    "text": "В обороте только %d%% сапплая — впереди разлоки и давление продаж" % (share * 100),
                    "weight": -(8 - unlock_score),
                    "kind": "bad",
                }
            )

    # 8. Есть ли что с ним делать (2)
    safe_apy = (best or {}).get("apy") or 0
    util_score = 2 if safe_apy >= 3 else (1 if opportunities else 0)
    if best and safe_apy >= 3:
        reasons.append(
            {
                "text": "Можно ставить под %.1f%% в год (%s, %s, риск %d/5)" % (safe_apy, best["project"], best["chain"], best["risk"]),
                "weight": 2,
                "kind": "good",
            }
        )
    elif not opportunities:
        reasons.append({"text": "Нет доступного стейкинга или лендинга — токен лежит мёртвым грузом", "weight": -4, "kind": "bad"})
    elif not best:
        reasons.append(
            {"text": "Заработать можно только в высокорисковых пулах — не для основной позиции", "weight": -3, "kind": "bad"}
        )

    score = rel_score + trend_score + struct_score + liq_score + news_score + ath_score + unlock_score + util_score

    if (market.get("change24h") or 0) <= -15:
        score -= 10
        reasons.append({"text": "Обвал за сутки: %s" % _pct(market.get("change24h")), "weight": -10, "kind": "bad"})

    fresh_hack = next((h for h in hacks if years_since_safe(h["date"]) < 2), None)
    if fresh_hack:
        weight = -7 if fresh_hack["amountUsd"] >= 10_000_000 else -4
        score += weight
        reasons.append(
            {
                "text": "Проект взламывали %s на %s (%s)" % (fresh_hack["date"], fmt_hack_amount(fresh_hack["amountUsd"]), fresh_hack["technique"]),
                "weight": weight,
                "kind": "bad",
            }
        )

    # Актив, упавший от хая почти в ноль и продолжающий падать год, — структурная история
    structurally_dead = ath <= -95 and (market.get("change1y") or 0) < -30 and (market.get("change200d") or 0) < 0
    if structurally_dead:
        score = min(score, 36)
        reasons.append(
            {
                "text": "Структурно сломанный актив: −95% и ниже от максимума, падение продолжается год",
                "weight": -14,
                "kind": "bad",
            }
        )

    if critical:
        score = min(score, 22)

    score = max(0, min(100, round(score)))
    reasons.sort(key=lambda r: abs(r["weight"]), reverse=True)
    return {"score": score, "verdict": verdict_of(score), "reasons": reasons, "newsTone": news_tone}


def years_since_safe(date: str) -> float:
    try:
        stamp = time.mktime(time.strptime(date, "%Y-%m-%d"))
    except Exception:
        return 99.0
    return (time.time() - stamp) / 31_536_000


def risk_headline(score: float, has_upside: bool) -> str:
    if score < 28:
        return "Слабый актив, отскок не меняет картину" if has_upside else "Актив против вас по всем фронтам"
    if score < 42:
        return "Есть плюсы, но минусы весомее" if has_upside else "Минусы перевешивают, плюсов не нашлось"
    if score < 56:
        return "Смешанная картина, требует контроля" if has_upside else "Слабо, но пока не критично"
    if score < 72:
        return "Позиция рабочая, риски терпимые" if has_upside else "Позиция рабочая"
    return "Сильная позиция, можно зарабатывать" if has_upside else "Сильная позиция"

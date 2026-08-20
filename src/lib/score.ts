import { fmtHackAmount } from "./hacks";
import type { Benchmark } from "./market";
import type { Liquidity, MarketData, NewsItem, Opportunity, TokenAnalysis, Verdict } from "./types";

type Reason = TokenAnalysis["reasons"][number];

const CRITICAL_TAGS = ["проект закрывается", "взлом", "скам", "делистинг", "депег/плохой долг", "остановка выводов"];

function ramp(value: number, lo: number, hi: number, points: number): number {
  if (!Number.isFinite(value)) return points * 0.5;
  const t = (value - lo) / (hi - lo);
  return Math.max(0, Math.min(1, t)) * points;
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "н/д";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export function verdictOf(score: number): Verdict {
  if (score < 28) return "sell";
  if (score < 42) return "reduce";
  if (score < 56) return "watch";
  if (score < 72) return "hold";
  return "accumulate";
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  sell: "Продавать",
  reduce: "Сокращать",
  watch: "Наблюдать",
  hold: "Держать",
  accumulate: "Держать и зарабатывать",
};

/**
 * Здоровье токена 0..100. Считаем по 7 блокам, чтобы решение было объяснимым:
 * дашборд показывает не только цифру, но и какие именно факторы её сделали.
 */
export function scoreToken(input: {
  market: MarketData | null;
  news: NewsItem[];
  benchmark: Benchmark;
  opportunities: Opportunity[];
  best: Opportunity | null;
  liquidity?: Liquidity | null;
  valueUsd?: number;
  hacks?: { date: string; amountUsd: number; technique: string }[];
}): { score: number; verdict: Verdict; reasons: Reason[]; newsTone: number } {
  const { market, news, benchmark, opportunities, best, liquidity, valueUsd = 0, hacks = [] } = input;
  const reasons: Reason[] = [];

  if (!market) {
    return {
      score: 35,
      verdict: "watch",
      reasons: [{ text: "Нет рыночных данных по токену — не удалось найти его на CoinGecko", weight: 0, kind: "neutral" }],
      newsTone: 0,
    };
  }

  // 1. Относительная динамика (25) — падает ли токен сильнее рынка
  const rel7 = (market.change7d ?? 0) - benchmark.change7d;
  const rel30 = (market.change30d ?? 0) - benchmark.change30d;
  const relScore = ramp(rel7, -20, 15, 12) + ramp(rel30, -30, 25, 13);
  if (rel7 < -8 || rel30 < -15) {
    reasons.push({
      text: `Отстаёт от рынка: ${pct(rel7)} за 7д и ${pct(rel30)} за 30д относительно BTC/ETH`,
      weight: -(25 - relScore),
      kind: "bad",
    });
  } else if (rel7 > 8 || rel30 > 15) {
    reasons.push({
      text: `Сильнее рынка: ${pct(rel7)} за 7д и ${pct(rel30)} за 30д относительно BTC/ETH`,
      weight: relScore - 12,
      kind: "good",
    });
  }

  // 2. Абсолютный тренд (15)
  const trendScore = ramp(market.change30d ?? 0, -35, 15, 10);
  if ((market.change30d ?? 0) < -20) {
    reasons.push({ text: `Цена за 30 дней ${pct(market.change30d)}`, weight: -(10 - trendScore), kind: "bad" });
  } else if ((market.change30d ?? 0) > 15) {
    reasons.push({ text: `Цена за 30 дней ${pct(market.change30d)}`, weight: trendScore - 5, kind: "good" });
  }

  // 3. Ликвидность (10) — сможете ли вы выйти своей суммой, а не «есть ли объём вообще».
  // Если знаем реальную глубину стакана и DEX-пулов, считаем по ней; иначе прокси объём/капа.
  const volRatio = market.marketCap > 0 ? market.volume24h / market.marketCap : 0;
  const capacity = liquidity?.sellCapacityUsd ?? 0;
  let liqScore: number;

  if (capacity > 0 && valueUsd > 0) {
    // сколько раз позиция влезает в «ёмкость выхода»: 0.3 раза — плохо, 20 раз — отлично
    const cover = capacity / valueUsd;
    liqScore = ramp(Math.log10(Math.max(cover, 0.01)), -0.5, 1.3, 10);
    if (cover < 1.5) {
      reasons.push({
        text: `Позиция ${fmtMoney(valueUsd)} против ёмкости выхода ${fmtMoney(capacity)} — продать за один раз не получится, цену уроните сами`,
        weight: -(10 - liqScore),
        kind: "bad",
      });
    } else if (cover > 15) {
      reasons.push({
        text: `Ликвидности хватает с запасом: рынок съест ${fmtMoney(capacity)} за раз при вашей позиции ${fmtMoney(valueUsd)}`,
        weight: 4,
        kind: "good",
      });
    }
  } else {
    liqScore = ramp(volRatio, 0.002, 0.04, 10);
    if (volRatio < 0.005) {
      reasons.push({
        text: `Тонкий объём: $${fmtShort(market.volume24h)} в сутки на капитализацию $${fmtShort(market.marketCap)} — выходить придётся частями`,
        weight: -(10 - liqScore),
        kind: "bad",
      });
    } else if (volRatio > 0.03) {
      reasons.push({ text: `Хорошая ликвидность: оборот ${(volRatio * 100).toFixed(1)}% капитализации в сутки`, weight: 4, kind: "good" });
    }
  }

  if (market.marketCap > 0 && market.marketCap < 5_000_000) {
    liqScore = Math.min(liqScore, 3);
    reasons.push({ text: `Капитализация всего $${fmtShort(market.marketCap)} — микрокап, риск манипуляций`, weight: -8, kind: "bad" });
  }

  // 4. Новости (20)
  const tones = news.map((n) => n.tone);
  const worstTone = tones.length ? Math.min(...tones) : 0;
  const bestTone = tones.length ? Math.max(...tones) : 0;
  const newsTone = tones.length ? tones.reduce((a, b) => a + b, 0) / tones.length : 0;
  const newsScore = ramp(worstTone * 0.6 + bestTone * 0.4, -3, 2.5, 18);
  const criticalNews = news.filter((n) => n.tags.some((t) => CRITICAL_TAGS.includes(t)));
  if (criticalNews.length) {
    reasons.push({
      text: `Критичный новостной фон (${criticalNews[0].tags.join(", ")}): «${criticalNews[0].title.slice(0, 110)}»`,
      weight: -20,
      kind: "bad",
    });
  } else if (worstTone <= -2) {
    reasons.push({ text: `Негативные новости: «${news.find((n) => n.tone === worstTone)?.title.slice(0, 110)}»`, weight: -10, kind: "bad" });
  } else if (bestTone >= 2) {
    reasons.push({ text: `Позитивные новости: «${news.find((n) => n.tone === bestTone)?.title.slice(0, 110)}»`, weight: 8, kind: "good" });
  }

  // 5. Структурный тренд (15) — 200 дней и год, тоже относительно рынка.
  // Медвежий год есть у всех; наказывать надо за отставание, а не за рынок.
  const rel200 = (market.change200d ?? 0) - benchmark.change200d;
  const rel1y = (market.change1y ?? 0) - benchmark.change1y;
  const structScore = ramp(rel200, -40, 25, 7) + ramp(rel1y, -60, 50, 8);
  if (rel1y < -25 || rel200 < -20) {
    reasons.push({
      text: `Долго проигрывает рынку: ${pct(market.change200d)} за 200 дней и ${pct(market.change1y)} за год (рынок ${pct(benchmark.change1y)})`,
      weight: -(15 - structScore),
      kind: "bad",
    });
  } else if (rel1y > 25) {
    reasons.push({
      text: `Обгоняет рынок вдолгую: ${pct(market.change1y)} за год против ${pct(benchmark.change1y)} у рынка`,
      weight: structScore - 7,
      kind: "good",
    });
  }

  // 6. Просадка от максимума и его давность (12)
  const ath = market.athChangePct ?? -50;
  const athAgeYears = market.athDate ? (Date.now() - new Date(market.athDate).getTime()) / 31_536_000_000 : 1;
  const athFresh = athAgeYears < 1 ? 4 : athAgeYears < 2 ? 2 : 0;
  const athScore = ramp(ath, -97, -35, 8) + athFresh;
  if (ath < -90) {
    reasons.push({
      text: `Ниже исторического максимума на ${Math.min(99.9, Math.abs(ath)).toFixed(1)}%${
        athAgeYears >= 2 ? ` (хай был ${athAgeYears.toFixed(1)} года назад)` : ""
      } — рынок давно потерял веру`,
      weight: -(12 - athScore),
      kind: "bad",
    });
  }

  // 7. Разлоки (8) — сколько сапплая ещё придёт в рынок
  let unlockScore = 8;
  if (market.circulatingSupply && market.totalSupply && market.totalSupply > 0) {
    const circShare = market.circulatingSupply / market.totalSupply;
    unlockScore = ramp(circShare, 0.3, 0.9, 8);
    if (circShare < 0.6) {
      reasons.push({
        text: `В обороте только ${(circShare * 100).toFixed(0)}% сапплая — впереди разлоки и давление продаж`,
        weight: -(8 - unlockScore),
        kind: "bad",
      });
    }
  }

  // 8. Есть ли что с ним делать (2)
  const safeApy = best?.apy ?? 0;
  const utilScore = safeApy >= 3 ? 2 : opportunities.length ? 1 : 0;
  if (best && safeApy >= 3) {
    reasons.push({
      text: `Можно ставить под ${safeApy.toFixed(1)}% годовых (${best.project}, ${best.chain}, риск ${best.risk}/5)`,
      weight: 2,
      kind: "good",
    });
  } else if (!opportunities.length) {
    reasons.push({ text: "Нет доступного стейкинга/лендинга — токен лежит мёртвым грузом", weight: -4, kind: "bad" });
  } else if (!best) {
    reasons.push({
      text: "Заработать можно только в высокорисковых пулах (тонкий TVL, эмиссия) — не для основной позиции",
      weight: -3,
      kind: "bad",
    });
  }

  let score = relScore + trendScore + structScore + liqScore + newsScore + athScore + unlockScore + utilScore;

  // Резкий обвал за сутки — отдельный штраф, его нельзя размывать в тренде
  if ((market.change24h ?? 0) <= -15) {
    score -= 10;
    reasons.push({ text: `Обвал за сутки: ${pct(market.change24h)}`, weight: -10, kind: "bad" });
  }
  // Взлом самого проекта — факт, который стоит держать перед глазами
  const freshHack = hacks.find((h) => (Date.now() - new Date(h.date).getTime()) / 31_536_000_000 < 2);
  if (freshHack) {
    const weight = freshHack.amountUsd >= 10_000_000 ? -7 : -4;
    score += weight;
    reasons.push({
      text: `Проект взламывали ${freshHack.date} на ${fmtHackAmount(freshHack.amountUsd)} (${freshHack.technique})`,
      weight,
      kind: "bad",
    });
  }

  // Актив, который упал от хая почти в ноль и продолжает падать год —
  // это не «просадка», а структурная история. Держать такое в основной позиции нельзя.
  const structurallyDead = ath <= -95 && (market.change1y ?? 0) < -30 && (market.change200d ?? 0) < 0;
  if (structurallyDead) {
    score = Math.min(score, 36);
    reasons.push({
      text: "Структурно сломанный актив: −95% и ниже от максимума, падение продолжается год — отскок статистически маловероятен",
      weight: -14,
      kind: "bad",
    });
  }

  // Критичные новости перебивают любую хорошую математику
  if (criticalNews.length) score = Math.min(score, 22);

  score = Math.max(0, Math.min(100, Math.round(score)));
  reasons.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  return { score, verdict: verdictOf(score), reasons, newsTone };
}

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("ru-RU")}`;
}

export function fmtShort(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

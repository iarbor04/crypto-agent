import { getCoinMeta } from "./coinmeta";
import { getMarketContext } from "./context";
import { findHacks, getHacks } from "./hacks";
import { getIndicators } from "./indicators";
import { getLiquidity } from "./liquidity";
import { getMarketBenchmark, getMarkets, resolveCoinId } from "./market";
import { riskOf } from "./format";
import { getNews } from "./news";
import { getPortfolio } from "./portfolio";
import { scoreToken } from "./score";
import { getOpportunities, pickSafe } from "./yields";
import { readJson } from "./store";
import type { AiInsight, Alert, Analysis, MarketContext, MarketData, TokenAnalysis } from "./types";

const money = (n: number) => `$${Math.round(n).toLocaleString("ru-RU")}`;

/**
 * Разбор не должен падать целиком из-за одного источника: у пользователя может
 * не быть ключа CoinGecko, DexScreener может тормозить, RSS — отвалиться.
 * Каждый источник получает свой лимит времени, а неудачи собираются в warnings.
 */
async function soft<T>(label: string, ms: number, task: () => Promise<T>, fallback: T, warnings: Set<string>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } catch {
    warnings.add(label);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

const STABLES = new Set(["USDT", "USDC", "DAI", "USDE", "FDUSD", "TUSD", "PYUSD", "USDS", "RLUSD"]);

function exitsFor(market: MarketData | null, symbol: string): TokenAnalysis["exits"] {
  const cgId = market?.coinId;
  const out: TokenAnalysis["exits"] = [];
  if (cgId) {
    out.push({
      label: "Где есть ликвидность",
      url: `https://www.coingecko.com/en/coins/${cgId}#markets`,
      hint: "Список всех бирж и пар с реальным объёмом — выходить надо там, где глубина стакана",
    });
  }
  out.push({
    label: "Свап на DEX (EVM)",
    url: "https://app.1inch.io/",
    hint: "Агрегатор соберёт маршрут по нескольким пулам — меньше проскальзывание на неликвидных токенах",
  });
  out.push({
    label: "Свап на Solana",
    url: "https://jup.ag/",
    hint: "Если токен живёт в Solana — Jupiter даст лучший маршрут",
  });
  out.push({
    label: `Хедж фьючерсом ${symbol}`,
    url: `https://www.binance.com/en/futures/${symbol}USDT`,
    hint: "Если продавать не хочется (налоги, разлок, залог) — можно зашортить эквивалент и убрать риск цены",
  });
  return out;
}

/** Полный разбор портфеля: цены, новости, доходности, скоринг и алерты. */
export async function analyzePortfolio(): Promise<Analysis> {
  const portfolio = await getPortfolio();
  const holdings = portfolio.holdings;
  const warnings = new Set<string>();
  // общий дедлайн: лучше отдать неполные данные, чем уронить страницу таймаутом
  const deadline = Date.now() + 55_000;
  const left = () => deadline - Date.now();

  const ids = await Promise.all(
    holdings.map((h) =>
      h.coinId
        ? Promise.resolve(h.coinId)
        : soft(`тикер ${h.symbol}`, 15_000, () => resolveCoinId(h.symbol), null, warnings),
    ),
  );
  const markets = await soft(
    "цены CoinGecko",
    25_000,
    () => getMarkets(ids.filter((x): x is string => Boolean(x))),
    {},
    warnings,
  );
  const benchmark = await soft(
    "бенчмарк рынка",
    15_000,
    () => getMarketBenchmark(),
    { change7d: 0, change30d: 0, change200d: 0, change1y: 0 },
    warnings,
  );
  const [context, allHacks] = await Promise.all([
    soft("контекст рынка", 20_000, () => getMarketContext(), { fearGreed: null, funding: {}, stables: {} }, warnings),
    soft("база взломов", 20_000, () => getHacks(), [], warnings),
  ]);

  const tokens: TokenAnalysis[] = [];
  for (let i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    const market = ids[i] ? markets[ids[i]!] ?? null : null;
    const valueUsd = market ? market.price * h.amount : 0;
    const isStable = STABLES.has(h.symbol);

    const [news, opportunities, meta] = await Promise.all([
      isStable
        ? Promise.resolve([])
        : soft("новости", Math.min(12_000, Math.max(2_000, left())), () => getNews(h.symbol, market?.name), [], warnings),
      soft(
        "пулы DeFiLlama",
        Math.min(25_000, Math.max(3_000, left())),
        () => getOpportunities(h.symbol, valueUsd),
        [],
        warnings,
      ),
      ids[i]
        ? soft(`профиль ${h.symbol}`, Math.min(15_000, Math.max(2_000, left())), () => getCoinMeta(ids[i]!), null, warnings)
        : Promise.resolve(null),
    ]);

    // Стакан и DEX-пулы: бесплатные Binance и DexScreener, лимит CoinGecko не тратят.
    const contract = meta?.chains[0]?.address;
    const liquidity = await soft(
      "стакан и DEX",
      Math.min(12_000, Math.max(2_000, left())),
      () => getLiquidity(h.symbol, contract),
      null,
      warnings,
    );
    const [indicators, aiInsight] = await Promise.all([
      soft("индикаторы", Math.min(12_000, Math.max(2_000, left())), () => getIndicators(h.symbol), null, warnings),
      readInsight(h.symbol),
    ]);
    const hacks = findHacks(allHacks, meta?.name ?? market?.name ?? h.symbol).slice(0, 3);
    const funding = context.funding[h.symbol] ?? null;

    const best = pickSafe(opportunities);

    const scored = isStable
      ? {
          score: 70,
          verdict: "hold" as const,
          reasons: [
            {
              text: best
                ? `Стейблкоин: риска цены нет, но лежать без дела не должен — есть ${best.apy.toFixed(1)}% годовых в ${best.project} (риск ${best.risk}/5)`
                : "Стейблкоин: риска цены нет",
              weight: 0,
              kind: "neutral" as const,
            },
          ],
          newsTone: 0,
        }
      : scoreToken({ market, news, benchmark, opportunities, best, liquidity, valueUsd, hacks });

    tokens.push({
      symbol: h.symbol,
      amount: h.amount,
      market,
      meta,
      liquidity,
      indicators,
      ai: aiInsight,
      funding,
      hacks,
      valueUsd,
      share: 0,
      score: scored.score,
      verdict: scored.verdict,
      reasons: scored.reasons,
      news,
      newsTone: scored.newsTone,
      opportunities,
      best,
      bestApy: best?.apy ?? null,
      potentialYearlyUsd: best ? (valueUsd * best.apy) / 100 : 0,
      exits: exitsFor(market, h.symbol),
      ...(market ? {} : { error: "Токен не найден на CoinGecko — проверьте тикер" }),
    });
  }

  tokens.sort((a, b) => b.valueUsd - a.valueUsd);

  const totalValueUsd = tokens.reduce((s, t) => s + t.valueUsd, 0);
  for (const t of tokens) t.share = totalValueUsd > 0 ? (t.valueUsd / totalValueUsd) * 100 : 0;
  const change24hUsd = tokens.reduce(
    (s, t) => s + (t.market?.change24h != null ? (t.valueUsd * t.market.change24h) / (100 + t.market.change24h) : 0),
    0,
  );
  const potentialYearlyUsd = tokens.reduce((s, t) => s + t.potentialYearlyUsd, 0);
  const idleValueUsd = tokens.filter((t) => t.best).reduce((s, t) => s + t.valueUsd, 0);

  const { refreshMinutes } = await import("./telegram").then((m) => m.getSettings());

  return {
    generatedAt: new Date().toISOString(),
    refreshMinutes,
    totalValueUsd,
    change24hUsd,
    potentialYearlyUsd,
    idleValueUsd,
    series: portfolioSeries(tokens),
    context,
    warnings: [...warnings],
    partial: warnings.size > 0,
    tokens,
    alerts: buildAlerts(tokens, context),
  };
}

/** Разбор ассистента по токену, если он свежий: живёт между прогонами агента. */
async function readInsight(symbol: string): Promise<AiInsight | null> {
  const all = await readJson<Record<string, AiInsight>>("ai-insights.json", {});
  const hit = all[symbol.toUpperCase()];
  if (!hit) return null;
  const ageHours = (Date.now() - new Date(hit.at).getTime()) / 3_600_000;
  return ageHours <= 48 ? hit : null;
}

/**
 * Стоимость портфеля по часам за 7 дней: складываем спарклайны позиций.
 * Длины у монет отличаются на пару точек — выравниваем по концу массива.
 */
function portfolioSeries(tokens: TokenAnalysis[]): number[] {
  const withSeries = tokens.filter((t) => t.market && t.market.sparkline7d.length > 10);
  if (!withSeries.length) return [];
  const len = Math.min(...withSeries.map((t) => t.market!.sparkline7d.length));
  const flat = tokens.filter((t) => !withSeries.includes(t)).reduce((s, t) => s + t.valueUsd, 0);

  const out = new Array<number>(len).fill(flat);
  for (const t of withSeries) {
    const prices = t.market!.sparkline7d;
    const offset = prices.length - len;
    for (let i = 0; i < len; i++) out[i] += prices[offset + i] * t.amount;
  }
  return out.map((v) => Math.round(v));
}

/** Базовые алерты по текущему состоянию (без сравнения с прошлым запуском). */
export function buildAlerts(tokens: TokenAnalysis[], context?: MarketContext): Alert[] {
  const alerts: Alert[] = [];

  for (const t of tokens) {
    const peg = context?.stables?.[t.symbol];
    if (peg != null && Math.abs(peg - 1) > 0.005 && t.valueUsd >= 50) {
      alerts.push({
        level: Math.abs(peg - 1) > 0.02 ? "critical" : "warning",
        symbol: t.symbol,
        title: `${t.symbol} отклонился от привязки: $${peg.toFixed(4)}`,
        body: `Стейблкоин торгуется ${peg < 1 ? "ниже" : "выше"} доллара на ${(Math.abs(peg - 1) * 100).toFixed(2)}% — по позиции ${money(t.valueUsd)} это ${money(Math.abs(peg - 1) * t.valueUsd)}`,
        action: peg < 1 ? "Проверить причину депега, при просадке глубже 2% — выходить" : "Отклонение вверх обычно временное",
      });
    }
  }
  for (const t of tokens) {
    const share = t.valueUsd;
    const critical = t.reasons.find((r) => r.kind === "bad" && r.weight <= -15);

    if (t.verdict === "sell") {
      alerts.push({
        level: "critical",
        symbol: t.symbol,
        title: `${t.symbol}: риск ${riskOf(t.score).short}`,
        body: t.reasons.filter((r) => r.kind === "bad").slice(0, 3).map((r) => `• ${r.text}`).join("\n") || critical?.text || "Слабая динамика и фон",
        action: `В позиции $${Math.round(share).toLocaleString("ru-RU")}${
          t.liquidity?.sellCapacityUsd
            ? `, рынок съедает за раз $${Math.round(t.liquidity.sellCapacityUsd).toLocaleString("ru-RU")}`
            : ""
        }`,
      });
    } else if (t.verdict === "reduce") {
      alerts.push({
        level: "warning",
        symbol: t.symbol,
        title: `${t.symbol}: риск ${riskOf(t.score).short}`,
        body: t.reasons.filter((r) => r.kind === "bad").slice(0, 2).map((r) => `• ${r.text}`).join("\n"),
        action: t.funding != null ? `Фьючерс есть: плата за плечо ${(t.funding * 3 * 365 * 100).toFixed(0)}% в год` : "Фьючерса на Binance нет",
      });
    }

    const goodNews = t.news.find((n) => n.tone >= 2);
    if (goodNews && t.score >= 55) {
      alerts.push({
        level: "positive",
        symbol: t.symbol,
        title: `${t.symbol}: позитив — ${goodNews.tags.join(", ") || "хорошие новости"}`,
        body: `«${goodNews.title}»`,
        action: t.best ? `Ставка ${t.best.apy.toFixed(1)}% в год доступна в ${t.best.project}` : "",
      });
    }

    if (t.best && t.best.apy >= 3 && t.valueUsd >= 100 && t.verdict !== "sell" && t.verdict !== "reduce") {
      alerts.push({
        level: "info",
        symbol: t.symbol,
        title: `${t.symbol} лежит без дела: можно ${t.best.apy.toFixed(1)}% в год`,
        body: `${t.best.project} (${t.best.chain}) — риск ${t.best.risk}/5, TVL $${Math.round(t.best.tvlUsd).toLocaleString("ru-RU")}`,
        action: `Это ~$${Math.round(t.potentialYearlyUsd).toLocaleString("ru-RU")} в год с текущей позиции`,
      });
    }
  }
  const order = { critical: 0, warning: 1, positive: 2, info: 3 };
  return alerts.sort((a, b) => order[a.level] - order[b.level]);
}

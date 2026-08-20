import { fetchJson } from "./http";
import { resolveCoinId } from "./market";
import { getPortfolio } from "./portfolio";
import { cached } from "./store";

type LlamaChart = {
  coins: Record<string, { symbol: string; prices: { timestamp: number; price: number }[] }>;
};

/**
 * История стоимости портфеля на любую глубину: CoinGecko отдаёт спарклайн только
 * за 7 дней, а coins.llama.fi — цены за любой период одним батч-запросом.
 */
export async function getPortfolioHistory(days: number): Promise<{ days: number; series: number[]; from: string }> {
  const span = Math.max(7, Math.min(days, 730));
  const portfolio = await getPortfolio();
  const holdings = portfolio.holdings;
  if (!holdings.length) return { days: span, series: [], from: "" };

  const ids = await Promise.all(holdings.map(async (h) => h.coinId ?? (await resolveCoinId(h.symbol))));
  const pairs = holdings
    .map((h, i) => ({ amount: h.amount, id: ids[i] }))
    .filter((p): p is { amount: number; id: string } => Boolean(p.id));
  if (!pairs.length) return { days: span, series: [], from: "" };

  // Ограничение coins.llama.fi: суммарно не больше 500 точек на запрос.
  // Поэтому шаг подбираем под число монет: год на шести токенах — это точка в 5 дней.
  const perCoin = Math.max(20, Math.min(span, Math.floor(500 / pairs.length)));
  const stepDays = Math.max(1, Math.ceil(span / perCoin));
  const points = Math.ceil(span / stepDays);

  const key = `history-${span}-${pairs.map((p) => p.id).sort().join("_").slice(0, 60)}.json`;
  const chart = await cached<LlamaChart>(key, 60 * 60_000, () => {
    const coins = pairs.map((p) => `coingecko:${p.id}`).join(",");
    const start = Math.floor(Date.now() / 1000) - span * 86_400;
    return fetchJson<LlamaChart>(
      `https://coins.llama.fi/chart/${coins}?start=${start}&span=${points}&period=${stepDays}d`,
      { timeoutMs: 30_000 },
    );
  });

  const rows = pairs
    .map((p) => ({ amount: p.amount, prices: chart.coins[`coingecko:${p.id}`]?.prices ?? [] }))
    .filter((r) => r.prices.length > 2);
  if (!rows.length) return { days: span, series: [], from: "" };

  // у монет разное число точек — выравниваем по концу массива
  const len = Math.min(...rows.map((r) => r.prices.length));
  const series = new Array<number>(len).fill(0);
  for (const r of rows) {
    const offset = r.prices.length - len;
    for (let i = 0; i < len; i++) series[i] += r.prices[offset + i].price * r.amount;
  }

  const firstTs = rows[0].prices[rows[0].prices.length - len].timestamp;
  return {
    days: span,
    series: series.map((v) => Math.round(v)),
    from: new Date(firstTs * 1000).toISOString().slice(0, 10),
  };
}

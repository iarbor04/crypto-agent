import { cgGet } from "./cgclient";
import { cached, readJson, updateJson } from "./store";
import type { MarketData } from "./types";

type SearchCoin = { id: string; symbol: string; name: string; market_cap_rank: number | null };

/**
 * symbol -> coingecko id. Тикеры не уникальны (APE = ApeCoin и десяток мемов),
 * поэтому берём точное совпадение тикера с лучшим market cap rank.
 */
export async function resolveCoinId(symbol: string): Promise<string | null> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return null;
  const map = await readJson<Record<string, string | null>>("symbol-map.json", {});
  if (sym in map) return map[sym];

  let id: string | null = null;
  try {
    const res = await cgGet<{ coins: SearchCoin[] }>("/search", { query: sym });
    const exact = res.coins.filter((c) => c.symbol.toUpperCase() === sym);
    const pool = exact.length ? exact : res.coins;
    pool.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    id = pool[0]?.id ?? null;
  } catch {
    id = null;
  }
  if (id) {
    const resolved = id;
    await updateJson<Record<string, string | null>>("symbol-map.json", {}, (cur) => ({ ...cur, [sym]: resolved }));
  }
  return id;
}

type CgMarket = {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number | null;
  total_volume: number;
  price_change_percentage_1h_in_currency: number | null;
  price_change_percentage_24h_in_currency: number | null;
  price_change_percentage_7d_in_currency: number | null;
  price_change_percentage_30d_in_currency: number | null;
  price_change_percentage_200d_in_currency: number | null;
  price_change_percentage_1y_in_currency: number | null;
  ath_change_percentage: number | null;
  ath_date: string | null;
  circulating_supply: number | null;
  total_supply: number | null;
  sparkline_in_7d?: { price: number[] };
};

/** Рыночные данные пачкой. Кэш 5 минут — CoinGecko free это 30 req/min. */
export async function getMarkets(coinIds: string[]): Promise<Record<string, MarketData>> {
  const ids = [...new Set(coinIds.filter(Boolean))].sort();
  if (!ids.length) return {};
  const key = `markets-${hash(ids.join(","))}.json`;
  const rows = await cached<CgMarket[]>(key, 5 * 60_000, () =>
    cgGet<CgMarket[]>("/coins/markets", {
      vs_currency: "usd",
      ids: ids.join(","),
      sparkline: "true",
      price_change_percentage: "1h,24h,7d,30d,200d,1y",
      per_page: "250",
    }),
  );

  const out: Record<string, MarketData> = {};
  for (const r of rows) {
    out[r.id] = {
      coinId: r.id,
      symbol: r.symbol.toUpperCase(),
      name: r.name,
      image: r.image,
      price: r.current_price,
      marketCap: r.market_cap,
      rank: r.market_cap_rank,
      volume24h: r.total_volume,
      change1h: r.price_change_percentage_1h_in_currency,
      change24h: r.price_change_percentage_24h_in_currency,
      change7d: r.price_change_percentage_7d_in_currency,
      change30d: r.price_change_percentage_30d_in_currency,
      change200d: r.price_change_percentage_200d_in_currency,
      change1y: r.price_change_percentage_1y_in_currency,
      athChangePct: r.ath_change_percentage,
      athDate: r.ath_date,
      circulatingSupply: r.circulating_supply,
      totalSupply: r.total_supply,
      sparkline7d: r.sparkline_in_7d?.price ?? [],
    };
  }
  return out;
}

export type Benchmark = { change7d: number; change30d: number; change200d: number; change1y: number };

/** Бенчмарк рынка: если токен падает, а рынок растёт — это уже про токен, а не про рынок. */
export async function getMarketBenchmark(): Promise<Benchmark> {
  const zero: Benchmark = { change7d: 0, change30d: 0, change200d: 0, change1y: 0 };
  try {
    const m = await getMarkets(["bitcoin", "ethereum"]);
    const vals = Object.values(m);
    if (!vals.length) return zero;
    const avg = (f: (v: MarketData) => number | null) =>
      vals.reduce((s, v) => s + (f(v) ?? 0), 0) / vals.length;
    return {
      change7d: avg((v) => v.change7d),
      change30d: avg((v) => v.change30d),
      change200d: avg((v) => v.change200d),
      change1y: avg((v) => v.change1y),
    };
  } catch {
    return zero;
  }
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

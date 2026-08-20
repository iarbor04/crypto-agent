import { fetchJson } from "./http";
import { cached, readJson, updateJson } from "./store";
import type { DexPair, Liquidity, OrderbookDepth } from "./types";

const BINANCE = "https://api.binance.com/api/v3";
const DEXSCREENER = "https://api.dexscreener.com/latest/dex/tokens";

/** Список спотовых пар Binance — чтобы не долбить стакан по токенам, которых там нет. */
async function getBinanceSymbols(): Promise<Set<string>> {
  const list = await cached<string[]>("binance-symbols.json", 24 * 60 * 60_000, async () => {
    const rows = await fetchJson<{ symbol: string }[]>(`${BINANCE}/ticker/price`, { timeoutMs: 25_000 });
    return rows.map((r) => r.symbol).filter((s) => s.endsWith("USDT"));
  });
  return new Set(list);
}

type RawDepth = { bids: [string, string][]; asks: [string, string][] };

/**
 * Сколько долларов можно продать в стакан, не уронив цену больше чем на X%.
 * Идём по бидам сверху вниз и складываем номинал, пока цена не ушла за порог.
 */
function walkBids(bids: [string, string][], mid: number, maxDropPct: number): number {
  const floor = mid * (1 - maxDropPct / 100);
  let usd = 0;
  for (const [priceStr, qtyStr] of bids) {
    const price = Number(priceStr);
    if (price < floor) break;
    usd += price * Number(qtyStr);
  }
  return usd;
}

export async function getOrderbookDepth(symbol: string): Promise<OrderbookDepth | null> {
  const pair = `${symbol.toUpperCase()}USDT`;
  try {
    const symbols = await getBinanceSymbols();
    if (!symbols.has(pair)) return null;

    const book = await cached<RawDepth>(`depth-${pair}.json`, 5 * 60_000, () =>
      fetchJson<RawDepth>(`${BINANCE}/depth?symbol=${pair}&limit=500`, { timeoutMs: 20_000 }),
    );
    if (!book.bids?.length || !book.asks?.length) return null;

    const bestBid = Number(book.bids[0][0]);
    const bestAsk = Number(book.asks[0][0]);
    const mid = (bestBid + bestAsk) / 2;
    if (!Number.isFinite(mid) || mid <= 0) return null;

    return {
      venue: "Binance",
      pair,
      mid,
      spreadPct: ((bestAsk - bestBid) / mid) * 100,
      usd05: walkBids(book.bids, mid, 0.5),
      usd1: walkBids(book.bids, mid, 1),
      usd2: walkBids(book.bids, mid, 2),
    };
  } catch {
    return null;
  }
}

type DsPair = {
  chainId: string;
  dexId: string;
  url: string;
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
};

/** DEX-ликвидность по контракту: пары, глубина пулов и суточный объём. */
export async function getDexLiquidity(address: string): Promise<{ totalUsd: number; pairs: DexPair[] } | null> {
  if (!address) return null;
  try {
    const res = await cached<{ pairs: DsPair[] | null }>(`dex-${address.slice(0, 12)}.json`, 15 * 60_000, () =>
      fetchJson<{ pairs: DsPair[] | null }>(`${DEXSCREENER}/${address}`, { timeoutMs: 20_000 }),
    );
    const pairs = res.pairs ?? [];
    if (!pairs.length) return null;

    const mapped: DexPair[] = pairs
      .map((p) => ({
        chain: p.chainId,
        dex: p.dexId,
        pair: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
        liquidityUsd: Math.round(p.liquidity?.usd ?? 0),
        volume24h: Math.round(p.volume?.h24 ?? 0),
        url: p.url,
      }))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

    return {
      totalUsd: mapped.reduce((s, p) => s + p.liquidityUsd, 0),
      pairs: mapped.slice(0, 4),
    };
  } catch {
    return null;
  }
}

/**
 * Сколько денег рынок съест за один раз без заметного удара по цене.
 * Для AMM берём грубую оценку: сдвинуть цену v2-пула на 1% — это примерно
 * 0.25% его TVL. Для concentrated liquidity оценка консервативная.
 */
const DEX_DEPTH_SHARE = 0.0025;

export async function getLiquidity(symbol: string, contract?: string): Promise<Liquidity | null> {
  const [book, dex] = await Promise.all([
    getOrderbookDepth(symbol),
    contract ? getDexLiquidity(contract) : Promise.resolve(null),
  ]);
  if (!book && !dex) return null;

  const dexDepth1 = dex ? dex.totalUsd * DEX_DEPTH_SHARE : 0;
  return {
    binance: book,
    dexTotalUsd: dex?.totalUsd ?? 0,
    dexPairs: dex?.pairs ?? [],
    sellCapacityUsd: Math.round((book?.usd1 ?? 0) + dexDepth1),
  };
}

type CgTicker = {
  base: string;
  target: string;
  market: { name: string; identifier: string };
  converted_volume?: { usd?: number };
  bid_ask_spread_percentage?: number | null;
  trust_score?: string | null;
  trade_url?: string | null;
};

export type Venue = {
  name: string;
  pair: string;
  volumeUsd: number;
  spreadPct: number | null;
  trust: string | null;
  url: string | null;
};

/**
 * Площадки со спредом — отвечает на «где именно продавать».
 * Живёт отдельным запросом по требованию: /coins/{id}/tickers тратит лимит CoinGecko.
 */
export async function getVenues(coinId: string, limit = 6): Promise<Venue[]> {
  if (!coinId) return [];
  const { cgGet } = await import("./cgclient");
  try {
    const res = await cached<{ tickers: CgTicker[] }>(`venues-${coinId}.json`, 30 * 60_000, () =>
      cgGet<{ tickers: CgTicker[] }>(`/coins/${encodeURIComponent(coinId)}/tickers`, { depth: "true" }),
    );
    const stable = new Set(["USDT", "USDC", "USD", "FDUSD", "BUSD", "DAI", "EUR"]);
    return (res.tickers ?? [])
      .filter((t) => stable.has(t.target.toUpperCase()))
      .map((t) => ({
        name: t.market.name,
        pair: `${t.base}/${t.target}`,
        volumeUsd: Math.round(t.converted_volume?.usd ?? 0),
        spreadPct: t.bid_ask_spread_percentage ?? null,
        trust: t.trust_score ?? null,
        url: t.trade_url ?? null,
      }))
      .sort((a, b) => b.volumeUsd - a.volumeUsd)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Отрицательный кэш: токен без контрактов и без пары на Binance незачем спрашивать повторно. */
export async function markNoLiquidity(symbol: string): Promise<void> {
  await updateJson<Record<string, number>>("no-liquidity.json", {}, (cur) => ({ ...cur, [symbol]: Date.now() }));
}

export async function isKnownNoLiquidity(symbol: string): Promise<boolean> {
  const map = await readJson<Record<string, number>>("no-liquidity.json", {});
  const at = map[symbol];
  return Boolean(at && Date.now() - at < 24 * 60 * 60_000);
}

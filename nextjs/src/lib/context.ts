import { fetchJson } from "./http";
import { cached } from "./store";
import type { MarketContext } from "./types";

/** Индекс страха и жадности — контекст для сводки: рынок в панике или в эйфории. */
async function getFearGreed(): Promise<MarketContext["fearGreed"]> {
  try {
    const res = await cached<{ data: { value: string; value_classification: string }[] }>(
      "fear-greed.json",
      60 * 60_000,
      () => fetchJson<{ data: { value: string; value_classification: string }[] }>("https://api.alternative.me/fng/?limit=1"),
    );
    const first = res.data?.[0];
    if (!first) return null;
    const LABEL: Record<string, string> = {
      "Extreme Fear": "крайний страх",
      Fear: "страх",
      Neutral: "нейтрально",
      Greed: "жадность",
      "Extreme Greed": "крайняя жадность",
    };
    return {
      value: Number(first.value),
      label: LABEL[first.value_classification] ?? first.value_classification,
    };
  } catch {
    return null;
  }
}

type RawFunding = { symbol: string; lastFundingRate: string; markPrice: string };

/**
 * Ставки фондирования по всем перпам Binance одним запросом.
 * Высокий положительный funding = в лонгах тесно, риск каскадных ликвидаций.
 */
export async function getFundingRates(): Promise<Record<string, number>> {
  try {
    const rows = await cached<RawFunding[]>("funding.json", 15 * 60_000, () =>
      fetchJson<RawFunding[]>("https://fapi.binance.com/fapi/v1/premiumIndex", { timeoutMs: 25_000 }),
    );
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (!r.symbol.endsWith("USDT")) continue;
      const rate = Number(r.lastFundingRate);
      if (Number.isFinite(rate)) out[r.symbol.replace(/USDT$/, "")] = rate;
    }
    return out;
  } catch {
    return {};
  }
}

type PeggedAsset = {
  symbol: string;
  price: number | null;
  circulating?: { peggedUSD?: number };
};

/** Цены стейблкоинов — чтобы поймать депег раньше, чем он попадёт в новости. */
export async function getStablePrices(): Promise<Record<string, number>> {
  try {
    const res = await cached<{ peggedAssets: PeggedAsset[] }>("stablecoins.json", 6 * 60 * 60_000, () =>
      fetchJson<{ peggedAssets: PeggedAsset[] }>("https://stablecoins.llama.fi/stablecoins?includePrices=true", {
        timeoutMs: 40_000,
      }),
    );
    const out: Record<string, number> = {};
    for (const a of res.peggedAssets ?? []) {
      if (a.price != null && Number.isFinite(a.price)) out[a.symbol.toUpperCase()] = a.price;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getMarketContext(): Promise<MarketContext> {
  const [fearGreed, funding, stables] = await Promise.all([getFearGreed(), getFundingRates(), getStablePrices()]);
  return { fearGreed, funding, stables };
}

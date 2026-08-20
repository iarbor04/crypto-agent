import { fetchJson } from "./http";
import { cached } from "./store";
import type { Indicators } from "./types";

const BINANCE = "https://api.binance.com/api/v3";

type Kline = [number, string, string, string, string, string, ...unknown[]];

/** Классический RSI Уайлдера со сглаживанием, не «средние за последние 14 свечей». */
function rsi(close: number[], period = 14): number | null {
  if (close.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

const sma = (values: number[], n: number): number | null =>
  values.length < n ? null : values.slice(-n).reduce((a, b) => a + b, 0) / n;

/** Средний истинный диапазон в процентах — насколько актив вообще ходит за день. */
function atrPct(high: number[], low: number[], close: number[], period = 14): number | null {
  if (close.length < period + 1) return null;
  let sum = 0;
  for (let i = close.length - period; i < close.length; i++) {
    const tr = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    sum += tr;
  }
  const atr = sum / period;
  return (atr / close[close.length - 1]) * 100;
}

/**
 * Технические индикаторы по дневным свечам Binance. Считаем сами, чтобы цифры
 * были проверяемыми и попадали в контекст для ассистента, а не выдумывались им.
 */
export async function getIndicators(symbol: string): Promise<Indicators | null> {
  const pair = `${symbol.toUpperCase()}USDT`;
  try {
    const rows = await cached<Kline[]>(`klines-${pair}.json`, 60 * 60_000, () =>
      fetchJson<Kline[]>(`${BINANCE}/klines?symbol=${pair}&interval=1d&limit=210`, { timeoutMs: 25_000 }),
    );
    if (!Array.isArray(rows) || rows.length < 30) return null;

    const high = rows.map((r) => Number(r[2]));
    const low = rows.map((r) => Number(r[3]));
    const close = rows.map((r) => Number(r[4]));
    const volume = rows.map((r) => Number(r[5]));
    const price = close[close.length - 1];

    const sma50 = sma(close, 50);
    const sma200 = sma(close, 200);
    const window = 30;
    const rangeHigh = Math.max(...high.slice(-window));
    const rangeLow = Math.min(...low.slice(-window));
    const volNow = sma(volume, 7);
    const volBase = sma(volume, 30);

    return {
      rsi14: rsi(close) ?? null,
      sma50,
      sma200,
      aboveSma50: sma50 != null ? price > sma50 : null,
      goldenCross: sma50 != null && sma200 != null ? sma50 > sma200 : null,
      atrPct: atrPct(high, low, close) ?? null,
      rangeHigh,
      rangeLow,
      // где цена внутри месячного диапазона: 0% — у минимума, 100% — у максимума
      rangePosition: rangeHigh > rangeLow ? ((price - rangeLow) / (rangeHigh - rangeLow)) * 100 : null,
      volumeTrendPct: volNow != null && volBase ? (volNow / volBase - 1) * 100 : null,
      source: pair,
    };
  } catch {
    return null;
  }
}

import { fetchJson } from "./http";

const BASE = process.env.COINGECKO_API_URL || "https://api.coingecko.com/api/v3";
const KEY = process.env.COINGECKO_API_KEY || "";

// Публичный CoinGecko без ключа реально держит ~5–15 запросов в минуту, а разбор
// портфеля дергает /markets, /search и /coins/{id} по каждому токену. Поэтому все
// запросы идут строго по одному и не чаще, чем раз в MIN_GAP.
const MIN_GAP = KEY ? 120 : 400;
const RETRY_DELAYS = [5_000, 12_000];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_GAP - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastCall = Date.now();
    }
  });
  chain = run.catch(() => {});
  return run;
}

export function cgUrl(path: string, params: Record<string, string> = {}): string {
  const qs = new URLSearchParams(params);
  if (KEY) qs.set("x_cg_demo_api_key", KEY);
  const query = qs.toString();
  return `${BASE}${path}${query ? `?${query}` : ""}`;
}

/** Запрос к CoinGecko: очередь, пауза между вызовами и повтор на 429. */
export async function cgGet<T>(path: string, params: Record<string, string> = {}, timeoutMs = 20_000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await enqueue(() => fetchJson<T>(cgUrl(path, params), { timeoutMs }));
    } catch (err) {
      lastErr = err;
      const rateLimited = /\b429\b|Too Many/i.test(String(err));
      if (!rateLimited || attempt === RETRY_DELAYS.length) throw err;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
  throw lastErr;
}

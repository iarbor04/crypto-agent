import { fetchJson } from "./http";
import { cached } from "./store";

export type PoolPoint = { date: string; apy: number; tvlUsd: number };

export type PoolHistory = {
  points: PoolPoint[];
  apyMedian90d: number | null;
  apyMin90d: number | null;
  apyMax90d: number | null;
};

type RawPoint = { timestamp: string; tvlUsd: number | null; apy: number | null };

/** История APY и TVL пула — отвечает на «эта ставка вообще держится?». */
export async function getPoolHistory(poolId: string): Promise<PoolHistory | null> {
  if (!/^[a-z0-9-]{8,}$/i.test(poolId)) return null;
  try {
    return await cached<PoolHistory>(`pool-${poolId}.json`, 6 * 60 * 60_000, async () => {
      const res = await fetchJson<{ data: RawPoint[] }>(`https://yields.llama.fi/chart/${poolId}`, {
        timeoutMs: 30_000,
      });
      const all = (res.data ?? [])
        .filter((p) => p.apy != null)
        .map((p) => ({ date: p.timestamp.slice(0, 10), apy: p.apy ?? 0, tvlUsd: Math.round(p.tvlUsd ?? 0) }));

      const points = all.slice(-180);
      const last90 = points.slice(-90).map((p) => p.apy);
      const sorted = [...last90].sort((a, b) => a - b);

      return {
        points,
        apyMedian90d: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        apyMin90d: sorted.length ? sorted[0] : null,
        apyMax90d: sorted.length ? sorted[sorted.length - 1] : null,
      };
    });
  } catch {
    return null;
  }
}

export type ProtocolEconomics = {
  name: string;
  fees24h: number | null;
  fees30d: number | null;
  fees1y: number | null;
  audits: string | null;
  category: string | null;
};

type RawFees = {
  displayName?: string;
  name?: string;
  total24h?: number | null;
  total30d?: number | null;
  total1y?: number | null;
  audits?: string | null;
  category?: string | null;
};

/**
 * Комиссии протокола: зарабатывает он на пользователях или живёт на эмиссии токена.
 * Не у всех протоколов есть данные — тогда просто ничего не показываем.
 */
export async function getProtocolEconomics(slug: string): Promise<ProtocolEconomics | null> {
  if (!slug) return null;
  try {
    return await cached<ProtocolEconomics>(`fees-${slug}.json`, 24 * 60 * 60_000, async () => {
      const f = await fetchJson<RawFees>(`https://api.llama.fi/summary/fees/${encodeURIComponent(slug)}`, {
        timeoutMs: 30_000,
      });
      return {
        name: f.displayName || f.name || slug,
        fees24h: f.total24h ?? null,
        fees30d: f.total30d ?? null,
        fees1y: f.total1y ?? null,
        audits: f.audits ?? null,
        category: f.category ?? null,
      };
    });
  } catch {
    return null;
  }
}

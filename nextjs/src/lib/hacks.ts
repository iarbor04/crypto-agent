import { fetchJson } from "./http";
import { cached } from "./store";

export type HackRecord = {
  date: string;
  name: string;
  amountUsd: number;
  technique: string;
  classification: string;
};

type RawHack = {
  date: number;
  name: string;
  classification: string;
  technique: string;
  amount: number | null;
};

/** База взломов DeFiLlama — 1200+ инцидентов. Кэш 24 часа. */
export async function getHacks(): Promise<HackRecord[]> {
  return cached<HackRecord[]>("llama-hacks.json", 24 * 60 * 60_000, async () => {
    const rows = await fetchJson<RawHack[]>("https://api.llama.fi/hacks", { timeoutMs: 40_000 });
    // amount у DeFiLlama уже в долларах: Ronin Bridge = 624 000 000
    return rows.map((r) => ({
      date: new Date(r.date * 1000).toISOString().slice(0, 10),
      name: r.name,
      amountUsd: Math.round(r.amount ?? 0),
      technique: r.technique,
      classification: r.classification,
    }));
  });
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Инциденты по названию протокола или проекта.
 *
 * Подстрока не годится: «ethereum» цепляет Ethereum Classic, Ethereum Alarm Clock
 * и Verus-Ethereum Bridge — это чужие проекты. Поэтому слова названия инцидента
 * должны быть началом названия протокола: «Aave» подходит к «Aave V3»,
 * а «Ethereum Classic» к «Ethereum» — нет.
 */
export function findHacks(all: HackRecord[], name: string): HackRecord[] {
  const target = words(name);
  if (!target.length || target[0].length < 3) return [];
  return all
    .filter((h) => {
      const hw = words(h.name);
      if (!hw.length || hw.length > target.length) return false;
      return hw.every((w, i) => w === target[i]);
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function fmtHackAmount(usd: number): string {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `$${Math.round(usd / 1e3)}K`;
  return `$${Math.round(usd)}`;
}

export function yearsSince(date: string): number {
  return (Date.now() - new Date(date).getTime()) / 31_536_000_000;
}

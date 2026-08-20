import { findHacks, fmtHackAmount, getHacks, yearsSince } from "./hacks";
import { fetchJson } from "./http";
import { cached } from "./store";
import type { Opportunity } from "./types";

type LlamaPool = {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  apyPct7D: number | null;
  pool: string;
  poolMeta: string | null;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  outlier: boolean;
  predictions?: { predictedClass?: string; predictedProbability?: number } | null;
};

type SlimPool = Omit<LlamaPool, "predictions"> & { pred: string | null };
type Protocol = { slug: string; name: string; category: string; url: string; audits: string | null };

/** ~16k пулов и 10MB json — режем до полезного и кэшируем на диск. */
async function getPools(): Promise<SlimPool[]> {
  return cached<SlimPool[]>("llama-pools.json", 30 * 60_000, async () => {
    const res = await fetchJson<{ data: LlamaPool[] }>("https://yields.llama.fi/pools", {
      timeoutMs: 45_000,
    });
    return res.data
      .filter((p) => (p.tvlUsd ?? 0) >= 100_000 && (p.apy ?? 0) > 0)
      .map((p) => ({
        chain: p.chain,
        project: p.project,
        symbol: p.symbol,
        tvlUsd: Math.round(p.tvlUsd),
        apy: p.apy,
        apyBase: p.apyBase,
        apyReward: p.apyReward,
        apyMean30d: p.apyMean30d,
        apyPct7D: p.apyPct7D,
        pool: p.pool,
        poolMeta: p.poolMeta,
        stablecoin: p.stablecoin,
        ilRisk: p.ilRisk,
        exposure: p.exposure,
        outlier: p.outlier,
        pred: p.predictions?.predictedClass ?? null,
      }));
  });
}

async function getProtocols(): Promise<Record<string, Protocol>> {
  return cached<Record<string, Protocol>>("llama-protocols.json", 24 * 60 * 60_000, async () => {
    const rows = await fetchJson<
      { slug: string; name: string; category: string; url: string; audits: string | null }[]
    >("https://api.llama.fi/protocols", { timeoutMs: 45_000 });
    const out: Record<string, Protocol> = {};
    for (const r of rows) {
      if (!r.slug) continue;
      out[r.slug] = { slug: r.slug, name: r.name, category: r.category, url: r.url, audits: r.audits };
    }
    return out;
  });
}

/** Префиксы liquid-staking / restaking производных: stETH, wstETH, mSOL, jitoSOL, ankrETH... */
const LST_PREFIXES = [
  "ST", "WST", "R", "CB", "WEE", "EZ", "RS", "OS", "M", "J", "JITO", "B", "BN", "SW",
  "ANKR", "FRX", "SFRX", "LS", "YN", "PUF", "UNI", "SUPER", "STONE", "LIQ", "H", "K",
];

function tokenMatches(poolToken: string, symbol: string): "exact" | "wrapped" | "lst" | null {
  const t = poolToken.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const s = symbol.toUpperCase();
  if (!t) return null;
  if (t === s) return "exact";
  if (t === `W${s}`) return "wrapped";
  if (t.length > s.length && t.endsWith(s)) {
    const prefix = t.slice(0, t.length - s.length);
    if (LST_PREFIXES.includes(prefix)) return "lst";
  }
  return null;
}

function splitPoolSymbol(sym: string): string[] {
  return sym.split(/[-/+_\s]+/).filter(Boolean);
}

function classify(p: SlimPool, category: string, match: string, parts: number): Opportunity["kind"] {
  const cat = (category || "").toLowerCase();
  if (parts > 1) return "lp";
  if (match === "lst" || cat.includes("liquid staking") || cat.includes("restaking")) return "liquid-staking";
  if (cat.includes("lending") || cat.includes("cdp")) return "lending";
  if (cat.includes("staking") || cat.includes("yield")) return "staking";
  if ((p.apyReward ?? 0) > 0) return "farm";
  return "staking";
}

function riskOf(
  p: SlimPool,
  category: string,
  kind: Opportunity["kind"],
  hacks: { date: string; amountUsd: number; technique: string }[],
): { risk: number; notes: string[] } {
  let risk = 2;
  const notes: string[] = [];
  const apy = p.apy ?? 0;

  if (p.tvlUsd < 1_000_000) { risk += 2; notes.push("TVL меньше $1M — тонкий пул, выход может быть дорогим"); }
  else if (p.tvlUsd < 10_000_000) { risk += 1; notes.push("TVL меньше $10M"); }
  else if (p.tvlUsd > 500_000_000) { risk -= 1; notes.push("Большой TVL — проверенный протокол"); }

  if (p.ilRisk === "yes") { risk += 1; notes.push("Impermanent loss: цена разъедется — потеряете часть тела"); }
  if (kind === "lp") notes.push("LP-позиция: нужны два актива, доход зависит от объёмов");

  const rewardShare = apy > 0 ? (p.apyReward ?? 0) / apy : 0;
  if (rewardShare > 0.7) { risk += 1; notes.push("Доходность почти вся из эмиссии токена награды — не устойчива"); }
  if (apy > 100) { risk += 1; notes.push("APY выше 100% — почти всегда временный"); }
  if (apy > 500) risk += 1;
  if (p.outlier) { risk += 1; notes.push("DeFiLlama помечает APY как выброс (outlier)"); }
  if (p.pred === "Down") notes.push("Прогноз DeFiLlama: доходность скорее упадёт");
  if ((category || "").toLowerCase().includes("cdp")) { risk += 1; notes.push("CDP/залог — есть риск ликвидации"); }

  // Штраф соразмерен инциденту: утечка на $500K в протоколе с TVL $1B — это
  // заметка, а не приговор; вынос на $50M — совсем другое дело.
  const recent = hacks.filter((h) => yearsSince(h.date) < 3);
  if (recent.length) {
    const worst = [...recent].sort((a, b) => b.amountUsd - a.amountUsd)[0];
    const fresh = yearsSince(worst.date) < 1;
    const big = worst.amountUsd >= 10_000_000;
    const medium = worst.amountUsd >= 1_000_000;
    risk += big ? (fresh ? 2 : 1) : medium && fresh ? 1 : 0;
    notes.push(`Протокол взламывали ${worst.date} на ${fmtHackAmount(worst.amountUsd)} (${worst.technique})`);
  }

  return { risk: Math.max(1, Math.min(5, risk)), notes };
}

function trendOf(p: SlimPool): Opportunity["trend"] {
  if (p.apyPct7D == null) return null;
  if (p.apyPct7D > 0.5) return "up";
  if (p.apyPct7D < -0.5) return "down";
  return "flat";
}

/** Куда можно поставить конкретный токен: стейкинг, лендинг, LP, фарм. */
export async function getOpportunities(symbol: string, valueUsd = 0, limit = 12): Promise<Opportunity[]> {
  const [pools, protocols, allHacks] = await Promise.all([getPools(), getProtocols(), getHacks().catch(() => [])]);
  const sym = symbol.toUpperCase();
  const out: Opportunity[] = [];

  for (const p of pools) {
    const parts = splitPoolSymbol(p.symbol);
    if (parts.length > 3) continue;
    let match: string | null = null;
    for (const part of parts) {
      const m = tokenMatches(part, sym);
      if (m) { match = m; break; }
    }
    if (!match) continue;

    const proto = protocols[p.project];
    const category = proto?.category ?? "";
    const kind = classify(p, category, match, parts.length);
    const protoHacks = findHacks(allHacks, proto?.name ?? p.project);
    const { risk, notes } = riskOf(p, category, kind, protoHacks);
    if (match === "lst") notes.push("Через производный токен (LST) — деньги остаются ликвидными");
    if (match === "wrapped") notes.push(`Нужен wrapped-вариант (W${sym})`);

    const apy = p.apy ?? 0;
    out.push({
      id: p.pool,
      kind,
      project: proto?.name ?? p.project,
      projectSlug: p.project,
      chain: p.chain,
      pair: p.poolMeta ? `${p.symbol} (${p.poolMeta})` : p.symbol,
      apy,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      apyMean30d: p.apyMean30d,
      tvlUsd: p.tvlUsd,
      ilRisk: p.ilRisk === "yes",
      stablecoin: p.stablecoin,
      risk,
      riskNotes: notes,
      trend: trendOf(p),
      url: `https://defillama.com/yields/pool/${p.pool}`,
      yearlyUsd: valueUsd ? (valueUsd * apy) / 100 : 0,
    });
  }

  // Ранжирование — главная логика этого файла. «Самый жирный APY» почти всегда
  // означает эмиссию мемкоина в тонком пуле, поэтому считаем устойчивую доходность:
  // спот-APY подрезаем средним за 30 дней, ограничиваем сверху и жёстко штрафуем риск.
  const quality = (o: Opportunity) => {
    const sustainable = o.apyMean30d != null && o.apyMean30d > 0 ? Math.min(o.apy, o.apyMean30d * 1.3) : o.apy * 0.7;
    const effective = Math.min(sustainable, 30);
    const riskFactor = [1, 1, 0.8, 0.5, 0.22, 0.06][o.risk] ?? 0.06;
    // глубина пула: 100K -> 0.35, 10M -> 0.7, 1B -> 1.0
    const depth = Math.max(0.25, Math.min(1, (Math.log10(Math.max(o.tvlUsd, 1)) - 4) / 5));
    // LP — другой продукт: нужен второй актив и есть IL, поэтому он не должен
    // выигрывать у обычного стейкинга на умеренной разнице в ставке.
    const shape = o.kind === "lp" ? 0.45 : o.kind === "farm" ? 0.85 : 1;
    const rewardShare = o.apy > 0 ? (o.apyReward ?? 0) / o.apy : 0;
    const emission = rewardShare > 0.6 ? 0.7 : 1;
    return effective * riskFactor * depth * shape * emission;
  };

  const seen = new Set<string>();
  return out
    .sort((a, b) => quality(b) - quality(a))
    .filter((o) => {
      // одна позиция на протокол+тип, чтобы не забивать список одним Uniswap
      const key = `${o.project}|${o.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/**
 * Вариант, который не стыдно показать как «поставь токен сюда»: один актив
 * (без impermanent loss и без покупки второй ноги), умеренный риск, глубокий пул
 * и ставка, которую вообще имеет смысл получать.
 */
export function pickSafe(opportunities: Opportunity[]): Opportunity | null {
  return (
    opportunities.find((o) => o.kind !== "lp" && o.risk <= 3 && o.tvlUsd >= 1_000_000 && o.apy >= 1) ?? null
  );
}

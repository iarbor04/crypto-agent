import type { Verdict } from "./types";

const THIN = "\u2009";

export const money = (n: number, digits = 0) =>
  `$${n.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/\u00A0/g, THIN)}`;

export const moneySmart = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1000) return money(n);
  if (abs >= 1) return money(n, 2);
  return `$${n.toPrecision(3)}`;
};

export const pct = (n: number | null | undefined, digits = 1) => {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
};

export const short = (n: number) => {
  if (!Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
};

export const amount = (n: number) =>
  (n >= 1000
    ? n.toLocaleString("ru-RU", { maximumFractionDigits: 0 })
    : n.toLocaleString("ru-RU", { maximumFractionDigits: 4 })
  ).replace(/\u00A0/g, THIN);

type Tone = "blue" | "green" | "amber" | "red" | "gray";

export const VERDICT: Record<Verdict, { label: string; tone: Tone; color: string; hint: string }> = {
  sell: { label: "Продавать", tone: "red", color: "var(--red)", hint: "Фундамент и динамика против вас — выходить" },
  reduce: { label: "Сокращать", tone: "amber", color: "var(--amber)", hint: "Срезать позицию или захеджировать" },
  watch: { label: "Наблюдать", tone: "gray", color: "var(--muted)", hint: "Слабо, но не критично — держать под контролем" },
  hold: { label: "Держать", tone: "blue", color: "var(--blue)", hint: "Позиция в порядке" },
  accumulate: { label: "Держать и стейкать", tone: "green", color: "var(--green)", hint: "Сильный актив — можно ставить в стейкинг" },
};

export const KIND: Record<string, string> = {
  staking: "Стейкинг",
  "liquid-staking": "Ликвидный стейкинг",
  lending: "Лендинг",
  lp: "LP-пул",
  farm: "Фарминг",
  cex: "Биржа",
  other: "Другое",
};

export const riskColor = (risk: number) =>
  risk <= 2 ? "var(--green)" : risk === 3 ? "var(--amber)" : "var(--red)";

export type RiskLevel = { label: string; short: string; color: string; tone: Tone; pct: number; hint: string };

/**
 * Наружу показываем риск, а не абстрактный «health»: длинная красная полоса
 * читается сразу, а число 36/100 надо расшифровывать. Само число остаётся
 * внутри — для сортировки, порогов и промпта ассистенту.
 */
export const riskOf = (score: number): RiskLevel => {
  const pct = Math.max(4, Math.min(100, 100 - score));
  if (score < 28)
    return { label: "Риск критический", short: "критический", color: "var(--red)", tone: "red", pct, hint: "Фундамент и динамика против позиции — обычно это выход" };
  if (score < 42)
    return { label: "Риск высокий", short: "высокий", color: "#e0655b", tone: "red", pct, hint: "Позицию стоит сокращать или хеджировать" };
  if (score < 56)
    return { label: "Риск повышенный", short: "повышенный", color: "var(--amber)", tone: "amber", pct, hint: "Слабо, но не критично — держать под контролем" };
  if (score < 72)
    return { label: "Риск умеренный", short: "умеренный", color: "var(--blue)", tone: "blue", pct, hint: "Позиция в порядке" };
  return { label: "Риск низкий", short: "низкий", color: "var(--green)", tone: "green", pct, hint: "Сильный актив — можно ставить в стейкинг" };
};

export const scoreColor = (score: number) =>
  score < 28 ? "var(--red)" : score < 42 ? "var(--amber)" : score < 56 ? "#9aa1af" : score < 72 ? "var(--blue)" : "var(--green)";

export const timeAgo = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
};

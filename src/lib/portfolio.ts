import { readJson, writeJson } from "./store";
import type { Holding, Portfolio } from "./types";

/** Демо-набор — только по кнопке, чтобы на свежей установке не появлялись чужие позиции. */
const DEMO: Holding[] = [
  { symbol: "ETH", amount: 1.5, coinId: "ethereum" },
  { symbol: "SOL", amount: 40, coinId: "solana" },
  { symbol: "APE", amount: 5000, coinId: "apecoin" },
  { symbol: "USDC", amount: 2500, coinId: "usd-coin" },
];

export async function getPortfolio(): Promise<Portfolio> {
  const p = await readJson<Portfolio | null>("portfolio.json", null);
  if (p && Array.isArray(p.holdings)) return p;
  // свежая установка: пустой портфель, без записи файла до первого сохранения
  return { holdings: [], updatedAt: new Date().toISOString() };
}

export async function seedDemoPortfolio(): Promise<Portfolio> {
  const portfolio: Portfolio = { holdings: DEMO, updatedAt: new Date().toISOString() };
  await writeJson("portfolio.json", portfolio);
  return portfolio;
}

export async function savePortfolio(raw: unknown): Promise<Portfolio> {
  const list = Array.isArray(raw) ? raw : [];
  const holdings: Holding[] = [];
  for (const item of list) {
    const rec = item as Record<string, unknown>;
    const symbol = String(rec.symbol ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const amount = Number(rec.amount);
    if (!symbol || !Number.isFinite(amount) || amount <= 0) continue;
    const existing = holdings.find((h) => h.symbol === symbol);
    if (existing) {
      existing.amount += amount;
      continue;
    }
    holdings.push({
      symbol,
      amount,
      ...(typeof rec.coinId === "string" && rec.coinId ? { coinId: rec.coinId } : {}),
      ...(typeof rec.note === "string" && rec.note ? { note: rec.note.slice(0, 200) } : {}),
    });
  }
  const portfolio: Portfolio = { holdings, updatedAt: new Date().toISOString() };
  await writeJson("portfolio.json", portfolio);
  return portfolio;
}

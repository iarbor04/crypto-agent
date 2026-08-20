"use client";

import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { amount as fmtAmount, moneySmart } from "@/lib/format";
import type { Holding, TokenAnalysis } from "@/lib/types";
import { TokenPicker, type PickedToken } from "./TokenPicker";
import { dropAnalysisCache } from "./useAnalysis";

type Unit = "token" | "usd";
type Row = { token: PickedToken | null; amount: string; unit: Unit; fresh?: boolean };

export function PortfolioEditor({
  onClose,
  onSaved,
  known = [],
}: {
  onClose: () => void;
  onSaved: () => void;
  /** уже посчитанные позиции — из них берём логотип и цену без лишних запросов */
  known?: TokenAnalysis[];
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // цены по coingecko-id: нужны, чтобы пересчитать введённую сумму в токены
  const [prices, setPrices] = useState<Record<string, number>>({});

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    fetch("/api/portfolio", { cache: "no-store" })
      .then((r) => r.json())
      .then((p: { holdings: Holding[] }) => {
        setRows(
          p.holdings.map((h) => {
            const hit = known.find((k) => k.symbol === h.symbol);
            return {
              token: {
                symbol: h.symbol,
                coinId: h.coinId ?? hit?.meta?.coinId ?? hit?.market?.coinId,
                name: hit?.meta?.name ?? hit?.market?.name,
                image: hit?.market?.image ?? null,
                rank: hit?.meta?.rank ?? hit?.market?.rank ?? null,
              },
              amount: String(h.amount),
              unit: "token" as Unit,
            };
          }),
        );
      })
      .catch(() => setError("Не удалось загрузить портфель"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function priceOf(row: Row): number | null {
    const hit = known.find((k) => k.symbol === row.token?.symbol);
    if (hit?.market?.price) return hit.market.price;
    const id = row.token?.coinId;
    return id && prices[id] ? prices[id] : null;
  }

  /** Цену только что выбранного токена в анализе ещё нет — спрашиваем отдельно. */
  async function ensurePrice(coinId?: string) {
    if (!coinId || prices[coinId] || known.some((k) => k.meta?.coinId === coinId || k.market?.coinId === coinId)) return;
    try {
      const res = await fetch(`/api/price?ids=${encodeURIComponent(coinId)}`);
      const json = (await res.json()) as { prices?: Record<string, number> };
      if (json.prices) setPrices((prev) => ({ ...prev, ...json.prices }));
    } catch {}
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const holdings = rows
        .filter((r) => r.token?.symbol)
        .map((r) => {
          const entered = Number(r.amount.replace(",", "."));
          const price = priceOf(r);
          // в долларовом режиме пересчитываем в количество токенов по текущей цене
          const amount = r.unit === "usd" && price ? entered / price : entered;
          return {
            symbol: r.token!.symbol.toUpperCase(),
            amount,
            ...(r.token!.coinId ? { coinId: r.token!.coinId } : {}),
          };
        })
        .filter((h) => Number.isFinite(h.amount) && h.amount > 0);
      const res = await fetch("/api/portfolio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holdings }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Ошибка сохранения");
      dropAnalysisCache();
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const filled = rows.filter((r) => r.token?.symbol && Number(r.amount.replace(",", ".")) > 0).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Мои токены</h2>
            <p>Найдите токен по тикеру или названию и укажите количество</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="holding-head">
            <span>Токен</span>
            <span>Количество</span>
            <span />
          </div>

          {rows.map((r, i) => {
            const price = priceOf(r);
            const entered = Number(r.amount.replace(",", "."));
            const valid = Number.isFinite(entered) && entered > 0;
            // в режиме «$» пользователь вводит сумму, храним всегда количество токенов
            const tokenAmount = r.unit === "usd" ? (price && valid ? entered / price : null) : valid ? entered : null;
            const usdValue = price && tokenAmount != null ? tokenAmount * price : null;

            return (
              <div className="holding-grid" key={i}>
                <TokenPicker
                  value={r.token}
                  autoOpen={r.fresh}
                  onPick={(token) => {
                    update(i, { token, fresh: false });
                    ensurePrice(token.coinId);
                  }}
                />
                <div className="amount-field">
                  <input
                    value={r.amount}
                    placeholder={r.unit === "usd" ? "500" : "0"}
                    inputMode="decimal"
                    onChange={(e) => update(i, { amount: e.target.value })}
                    style={{ paddingRight: 78 }}
                  />
                  <button
                    type="button"
                    className="unit-toggle"
                    onClick={() => update(i, { unit: r.unit === "usd" ? "token" : "usd" })}
                    title="Переключить: количество токенов или сумма в долларах"
                    disabled={!price && r.unit === "token"}
                  >
                    {r.unit === "usd" ? "$" : r.token?.symbol || "шт"}
                  </button>
                  {r.unit === "usd" ? (
                    tokenAmount != null ? (
                      <span className="amount-under mono">≈ {fmtAmount(Number(tokenAmount.toFixed(6)))} {r.token?.symbol}</span>
                    ) : valid ? (
                      <span className="amount-under mono">курс не загрузился</span>
                    ) : null
                  ) : usdValue != null ? (
                    <span className="amount-under mono">≈ {moneySmart(usdValue)}</span>
                  ) : null}
                </div>
                <button
                  className="row-delete"
                  onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
                  aria-label="Удалить"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}

          <button
            className="ghost-button"
            style={{ width: "100%", marginTop: 6 }}
            onClick={() => setRows([...rows, { token: null, amount: "", unit: "token", fresh: true }])}
          >
            ＋ Добавить токен
          </button>
          {error && <p className="form-note err">{error}</p>}
        </div>

        <div className="modal-foot">
          <span style={{ color: "#9aa1af", fontSize: 11 }}>Позиций: {filled}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ghost-button" onClick={onClose}>
              Отмена
            </button>
            <button className="primary-button" onClick={save} disabled={saving}>
              {saving ? "Сохраняю…" : "Сохранить и пересчитать"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

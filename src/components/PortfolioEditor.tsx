"use client";

import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { moneySmart } from "@/lib/format";
import type { Holding, TokenAnalysis } from "@/lib/types";
import { TokenPicker, type PickedToken } from "./TokenPicker";
import { dropAnalysisCache } from "./useAnalysis";

type Row = { token: PickedToken | null; amount: string; fresh?: boolean };

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
    return hit?.market?.price ?? null;
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const holdings = rows
        .filter((r) => r.token?.symbol)
        .map((r) => ({
          symbol: r.token!.symbol.toUpperCase(),
          amount: Number(r.amount.replace(",", ".")),
          ...(r.token!.coinId ? { coinId: r.token!.coinId } : {}),
        }))
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
            const amount = Number(r.amount.replace(",", "."));
            const value = price && Number.isFinite(amount) ? price * amount : null;
            return (
              <div className="holding-grid" key={i}>
                <TokenPicker
                  value={r.token}
                  autoOpen={r.fresh}
                  onPick={(token) => update(i, { token, fresh: false })}
                />
                <div className="amount-field">
                  <input
                    value={r.amount}
                    placeholder="0"
                    inputMode="decimal"
                    onChange={(e) => update(i, { amount: e.target.value })}
                  />
                  {value != null && <span className="amount-hint mono">≈ {moneySmart(value)}</span>}
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
            onClick={() => setRows([...rows, { token: null, amount: "", fresh: true }])}
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

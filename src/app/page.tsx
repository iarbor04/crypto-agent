"use client";

import { useState } from "react";
import { AlertTriangle, ArrowUpRight, PiggyBank, RefreshCw, TrendingUp } from "lucide-react";
import { Allocation, PortfolioChart } from "@/components/PortfolioChart";
import { PortfolioEditor } from "@/components/PortfolioEditor";
import { TokenCard } from "@/components/TokenCard";
import { TokenDrawer } from "@/components/TokenDrawer";
import { Delta, RiskMeter, Loader, Pill, RiskDots, Sparkline } from "@/components/bits";
import { dropAnalysisCache, useAnalysis } from "@/components/useAnalysis";
import { useStoredView } from "@/components/useStoredView";
import { VERDICT, amount as fmtAmount, money, moneySmart, timeAgo } from "@/lib/format";
import type { Alert, TokenAnalysis } from "@/lib/types";

export default function PortfolioPage() {
  const { data, error, loading, reload } = useAnalysis();
  const [openToken, setOpenToken] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [view, switchView] = useStoredView();

  async function loadDemo() {
    setSeeding(true);
    try {
      await fetch("/api/portfolio/demo", { method: "POST" });
      dropAnalysisCache();
      reload();
    } finally {
      setSeeding(false);
    }
  }

  const token = data?.tokens.find((t) => t.symbol === openToken) ?? null;
  const risky = data?.tokens.filter((t) => t.score < 56) ?? [];
  const riskyValue = risky.reduce((s, t) => s + t.valueUsd, 0);
  const riskyShare = data?.totalValueUsd ? (riskyValue / data.totalValueUsd) * 100 : 0;
  const needsAction = data?.tokens.filter((t) => t.verdict === "sell" || t.verdict === "reduce").length ?? 0;

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">ПОРТФЕЛЬ</span>
          <h1>Мои токены</h1>
          <p>
            {data
              ? `${data.tokens.length} позиций · данные обновлены ${timeAgo(data.generatedAt)}`
              : "Собираю цены, доходности, ликвидность и новости"}
          </p>
        </div>
        <div className="top-actions">
          <div className="view-toggle">
            <button className={view === "cards" ? "active" : ""} onClick={() => switchView("cards")}>
              Карточки
            </button>
            <button className={view === "table" ? "active" : ""} onClick={() => switchView("table")}>
              Таблица
            </button>
          </div>
          <button className="ghost-button" onClick={reload} disabled={loading}>
            <RefreshCw size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} strokeWidth={2} />
            {loading ? "Считаю…" : "Обновить"}
          </button>
          <button className="primary-button" onClick={() => setEditing(true)}>
            ＋ Мои токены
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data && loading && <Loader />}

      {data?.partial && (
        <div className="warn-banner">
          <strong>Данные неполные.</strong> Не ответили: {data.warnings.join(", ")}. Показываю то, что есть — нажмите
          «Обновить» через минуту. Если это повторяется, добавьте бесплатный ключ CoinGecko в <code>.env.local</code>{" "}
          (см. README) — он снимает лимит запросов.
        </div>
      )}

      {data && (
        <>
          <div className="hero-row">
            <PortfolioChart series={data.series} change24hUsd={data.change24hUsd} />
            <Allocation tokens={data.tokens} fearGreed={data.context?.fearGreed} />
          </div>

          <div className="metric-row" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <article className="metric-card">
              <span>Можно заработать на стейкинге</span>
              <strong className="mono" style={{ color: "var(--green)" }}>
                {money(data.potentialYearlyUsd)} в год
              </strong>
              <small>
                если разложить {money(data.idleValueUsd)} по проверенным пулам — без продажи самих токенов
              </small>
            </article>

            <article className="metric-card">
              <span>В слабых позициях</span>
              <strong className="mono" style={{ color: riskyValue ? "var(--red)" : "var(--green)" }}>
                {money(riskyValue)}
              </strong>
              <small>
                {risky.length
                  ? `${riskyShare.toFixed(0)}% портфеля · ${risky.length} из ${data.tokens.length} токенов с повышенным риском`
                  : "все позиции с умеренным или низким риском"}
              </small>
            </article>

            <article className="metric-card">
              <span>Нужно решение</span>
              <strong className="mono" style={{ color: needsAction ? "var(--red)" : "var(--green)" }}>
                {needsAction}
              </strong>
              <small className={needsAction ? "down" : "up"}>
                {needsAction ? "позиции стоит сократить или закрыть" : "срочных действий нет"}
              </small>
            </article>
          </div>

          {!!data.alerts.length && (
            <div className="alert-grid">
              {data.alerts.slice(0, 4).map((a, i) => (
                <AlertCard key={`${a.symbol}-${i}`} alert={a} onOpen={() => setOpenToken(a.symbol)} />
              ))}
            </div>
          )}

          {!data.tokens.length && (
            <div className="empty-state">
              <h3>Портфель пуст</h3>
              <p>
                Добавьте свои токены — найдите каждый по тикеру или названию и укажите количество. Цены, доходности,
                риски и новости подтянутся сами, ключи не нужны.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="primary-button" onClick={() => setEditing(true)}>
                  ＋ Добавить токены
                </button>
                <button className="ghost-button" onClick={loadDemo} disabled={seeding}>
                  {seeding ? "Загружаю…" : "Посмотреть на демо-портфеле"}
                </button>
              </div>
            </div>
          )}

          {!!data.tokens.length && view === "cards" && (
            <div className="token-grid">
              {data.tokens.map((t) => (
                <TokenCard key={t.symbol} t={t} onOpen={() => setOpenToken(t.symbol)} />
              ))}
            </div>
          )}

          {!!data.tokens.length && view === "table" && (
            <div className="card">
              <div className="table-head">
                <span>Токен</span>
                <span className="cell-right">Сколько у вас</span>
                <span className="col-spark">Цена за 7 дней</span>
                <span className="col-delta cell-right">За сутки / неделю</span>
                <span className="col-risk">Риск</span>
                <span className="col-verdict">Что делать</span>
                <span className="cell-right">Стейкинг</span>
                <span />
              </div>
              {data.tokens.map((t) => (
                <Row key={t.symbol} t={t} onOpen={() => setOpenToken(t.symbol)} />
              ))}
            </div>
          )}
        </>
      )}

      {token && <TokenDrawer token={token} onClose={() => setOpenToken(null)} />}
      {editing && <PortfolioEditor onClose={() => setEditing(false)} onSaved={reload} known={data?.tokens ?? []} />}
    </>
  );
}

const ALERT_STYLE: Record<Alert["level"], { label: string; color: string; bg: string; Icon: typeof AlertTriangle }> = {
  critical: { label: "Нужно решение", color: "#c33b42", bg: "var(--red-soft)", Icon: AlertTriangle },
  warning: { label: "Внимание", color: "#b9741a", bg: "var(--amber-soft)", Icon: AlertTriangle },
  positive: { label: "Позитив", color: "#1c8f5a", bg: "var(--green-soft)", Icon: TrendingUp },
  info: { label: "Лежит без дела", color: "#4658ea", bg: "var(--blue-soft)", Icon: PiggyBank },
};

function AlertCard({ alert, onOpen }: { alert: Alert; onOpen: () => void }) {
  const s = ALERT_STYLE[alert.level];
  return (
    <button className="alert-card" onClick={onOpen}>
      <span className="alert-icon" style={{ background: s.bg, color: s.color }}>
        <s.Icon size={18} strokeWidth={2} />
      </span>
      <div style={{ minWidth: 0 }}>
        <span className="eyebrow" style={{ color: s.color }}>
          {s.label.toUpperCase()}
        </span>
        <strong style={{ marginTop: 6 }}>{alert.title}</strong>
        {alert.body && <p>{alert.body}</p>}
        {alert.action && (
          <em style={{ color: s.color }}>
            {alert.action} <ArrowUpRight size={12} style={{ verticalAlign: "-1px" }} />
          </em>
        )}
      </div>
    </button>
  );
}

function Row({ t, onOpen }: { t: TokenAnalysis; onOpen: () => void }) {
  const v = VERDICT[t.verdict];
  return (
    <div className="table-row" onClick={onOpen} role="button" tabIndex={0}>
      <div className="asset">
        {t.market?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.market.image} alt="" width={30} height={30} />
        ) : (
          <span className="asset-blank" />
        )}
        <div>
          <strong>
            {t.symbol}
            {(t.meta?.rank ?? t.market?.rank) && (
              <span style={{ color: "#a3a9b6", fontSize: 10, fontWeight: 600, marginLeft: 6 }}>
                #{t.meta?.rank ?? t.market?.rank}
              </span>
            )}
          </strong>
          <small>{t.meta?.name ?? t.market?.name ?? t.error ?? "—"}</small>
        </div>
      </div>

      <div className="cell-right">
        <strong className="mono">{money(t.valueUsd)}</strong>
        <div className="mono" style={{ marginTop: 3, fontSize: 10, color: "#9aa1af" }}>
          {fmtAmount(t.amount)} · {t.market ? moneySmart(t.market.price) : "—"}
        </div>
      </div>

      <div className="col-spark">
        <Sparkline data={t.market?.sparkline7d ?? []} />
      </div>

      <div className="col-delta cell-right">
        <Delta value={t.market?.change24h} />
        <div style={{ marginTop: 3 }}>
          <Delta value={t.market?.change7d} />
        </div>
      </div>

      <div className="col-risk">
        <RiskMeter score={t.score} />
      </div>

      <div className="col-verdict">
        <Pill tone={v.tone}>{v.label}</Pill>
      </div>

      <div className="cell-right">
        {t.best ? (
          <>
            <strong className="mono" style={{ color: "var(--green)" }}>
              {t.best.apy.toFixed(1)}%
            </strong>
            <div style={{ marginTop: 4, display: "flex", justifyContent: "flex-end" }}>
              <RiskDots risk={t.best.risk} />
            </div>
          </>
        ) : (
          <span style={{ color: "#a3a9b6" }}>негде</span>
        )}
      </div>

      <div className="cell-right">
        <span className="link-button">
          Открыть <ArrowUpRight size={12} style={{ verticalAlign: "-1px" }} />
        </span>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { TokenDrawer } from "@/components/TokenDrawer";
import { Delta, ProsCons, RiskMeter, RiskScale, Loader, Pill } from "@/components/bits";
import { useAnalysis } from "@/components/useAnalysis";
import { VERDICT, money, riskHeadline, riskOf, short } from "@/lib/format";
import type { TokenAnalysis } from "@/lib/types";

export default function RisksPage() {
  const { data, error, loading, reload } = useAnalysis();
  const [openToken, setOpenToken] = useState<string | null>(null);
  const token = data?.tokens.find((t) => t.symbol === openToken) ?? null;

  const ranked = [...(data?.tokens ?? [])].sort((a, b) => a.score - b.score);
  const problem = ranked.filter((t) => t.score < 56);
  const fine = ranked.filter((t) => t.score >= 56);
  const atRiskValue = problem.reduce((s, t) => s + t.valueUsd, 0);
  const share = data?.totalValueUsd ? (atRiskValue / data.totalValueUsd) * 100 : 0;

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">РЕЙТИНГ РИСКА</span>
          <h1>На что обратить внимание</h1>
          <p>Самые слабые позиции сверху: что против них, что за них и что с этим делать</p>
        </div>
        <div className="top-actions">
          <button className="ghost-button" onClick={reload} disabled={loading}>
            <RefreshCw size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} strokeWidth={2} />
            {loading ? "Считаю…" : "Обновить"}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data && loading && <Loader text="Собираю новости и метрики" />}

      {data && (
        <>
          <div className="metric-row" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <article className="metric-card">
              <span>Под риском</span>
              <strong className="mono" style={{ color: atRiskValue ? "var(--red)" : "var(--green)" }}>
                {money(atRiskValue)}
              </strong>
              <small>
                {problem.length} из {ranked.length} позиций с повышенным риском
              </small>
            </article>
            <article className="metric-card">
              <span>Доля портфеля в слабых позициях</span>
              <strong className="mono">{share.toFixed(0)}%</strong>
              <small>от {money(data.totalValueUsd)} общей стоимости</small>
            </article>
            <article className="metric-card">
              <span>Стоит закрыть</span>
              <strong className="mono" style={{ color: "var(--red)" }}>
                {ranked.filter((t) => t.verdict === "sell").length}
              </strong>
              <small>критичные новости или обвал — обычно это выход</small>
            </article>
          </div>

          {problem.length === 0 ? (
            <div className="empty-state">
              <h3>Слабых позиций нет</h3>
              <p>Ни у одного токена риск не выше умеренного. Ниже — весь портфель по возрастанию риска.</p>
            </div>
          ) : (
            problem.map((t, i) => <RiskCard key={t.symbol} t={t} rank={i + 1} onOpen={() => setOpenToken(t.symbol)} />)
          )}

          {!!fine.length && (
            <>
              <h2 className="section-heading">Остальные позиции</h2>
              <div className="card">
                {fine.map((t) => (
                  <div className="fine-row" key={t.symbol} onClick={() => setOpenToken(t.symbol)}>
                    <strong>{t.symbol}</strong>
                    <div style={{ width: 130 }}>
                      <RiskMeter score={t.score} />
                    </div>
                    <span className="mono" style={{ width: 90, textAlign: "right" }}>
                      {money(t.valueUsd)}
                    </span>
                    <Delta value={t.market?.change7d} />
                    <Pill tone={VERDICT[t.verdict].tone}>{VERDICT[t.verdict].label}</Pill>
                    {t.best && (
                      <span className="mono" style={{ marginLeft: "auto", color: "var(--green)", fontWeight: 700 }}>
                        {t.best.apy.toFixed(1)}% · {t.best.project}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {token && <TokenDrawer token={token} onClose={() => setOpenToken(null)} />}
    </>
  );
}

function RiskCard({ t, rank, onOpen }: { t: TokenAnalysis; rank: number; onOpen: () => void }) {
  const v = VERDICT[t.verdict];
  const bad = t.reasons.filter((r) => r.kind === "bad").slice(0, 4);
  const good = t.reasons.filter((r) => r.kind === "good").slice(0, 3);

  return (
    <article className="risk-card">
      <header>
        <span className="risk-rank mono">{String(rank).padStart(2, "0")}</span>
        {t.market?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.market.image} alt="" width={34} height={34} style={{ borderRadius: "50%" }} />
        ) : null}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h3>{t.symbol}</h3>
            <span style={{ color: "#9aa1af", fontSize: 11 }}>{t.meta?.name ?? t.market?.name}</span>
            {(t.meta?.rank ?? t.market?.rank) && <span className="pill pill-gray">#{t.meta?.rank ?? t.market?.rank}</span>}
            <Pill tone={v.tone}>{v.label}</Pill>
            {t.meta?.categories.slice(0, 2).map((c) => (
              <span className="chain-tag" key={c} style={{ color: "#4658ea", borderColor: "#dfe3fb", background: "#f6f7ff" }}>
                {c}
              </span>
            ))}
          </div>
          <div className="risk-meta">
            <span className="mono" style={{ color: "var(--ink)", fontWeight: 700 }}>
              {money(t.valueUsd)}
            </span>
            <span>
              7д <Delta value={t.market?.change7d} />
            </span>
            <span>
              30д <Delta value={t.market?.change30d} />
            </span>
            {t.market && <span>капитализация ${short(t.market.marketCap)}</span>}
          </div>
        </div>
        <button className="ghost-button" onClick={onOpen}>
          Подробно
        </button>
      </header>

      <div className="reason-grid-wrap">
        <div className="risk-verdict" style={{ marginBottom: 14 }}>
          <div>
            <span className="label" style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.6 }}>
              ОЦЕНКА ПОЗИЦИИ
            </span>
            <h3>{riskHeadline(t.score, good.length > 0)}</h3>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <RiskScale score={t.score} />
            <span className="step">
              <b>{riskOf(t.score).step}</b> / 5
            </span>
          </div>
        </div>
        <ProsCons
          pros={[...(t.ai?.pros ?? []).slice(0, 2), ...good.map((r) => r.text)]}
          cons={[...(t.ai?.cons ?? []).slice(0, 2), ...bad.map((r) => r.text)]}
          compact
        />
      </div>

      <div className="plan-strip">
        <span className="pill pill-gray">ФАКТЫ</span>
        <span>
          {t.liquidity?.sellCapacityUsd
            ? `Рынок съедает за раз ${money(t.liquidity.sellCapacityUsd)} — позиция ${money(t.valueUsd)}`
            : `Позиция ${money(t.valueUsd)}, данных по глубине рынка нет`}
          {t.best ? ` · доступна ставка ${t.best.apy.toFixed(1)}% в год в ${t.best.project}` : " · проверенного стейкинга нет"}
          {t.funding != null ? ` · плата за плечо ${(t.funding * 3 * 365 * 100).toFixed(0)}% в год` : ""}
        </span>
        <button className="link-button" style={{ marginLeft: "auto" }} onClick={onOpen}>
          Разбор и инструменты →
        </button>
      </div>
    </article>
  );
}

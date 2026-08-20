"use client";

import { ArrowUpRight, PiggyBank } from "lucide-react";
import { VERDICT, amount as fmtAmount, money, moneySmart } from "@/lib/format";
import type { TokenAnalysis } from "@/lib/types";
import { Delta, RiskMeter, Pill, RiskDots } from "./bits";
import { readIndicators } from "@/lib/indicators-view";

const W = 300;
const H = 44;

function Spark({ data }: { data: number[] }) {
  if (!data || data.length < 4) return <div style={{ height: H }} />;
  const step = Math.max(1, Math.floor(data.length / 90));
  const pts = data.filter((_, i) => i % step === 0);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const up = pts[pts.length - 1] >= pts[0];
  const color = up ? "var(--green)" : "var(--red)";
  const id = `sp-${up ? "u" : "d"}`;
  const line = pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * W;
      const y = H - 3 - ((v - min) / span) * (H - 8);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function TokenCard({ t, onOpen }: { t: TokenAnalysis; onOpen: () => void }) {
  const v = VERDICT[t.verdict];
  const rank = t.meta?.rank ?? t.market?.rank ?? null;
  const chains = t.meta?.chains.slice(0, 3).map((c) => c.chain) ?? [];
  const categories = t.meta?.categories.slice(0, 2) ?? [];

  return (
    <button className="token-card" onClick={onOpen}>
      <header>
        {t.market?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.market.image} alt="" width={38} height={38} />
        ) : (
          <span className="asset-blank" style={{ background: "var(--soft)" }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>
            {t.symbol}
            {rank && <small>#{rank}</small>}
          </h3>
          <p>{t.meta?.name ?? t.market?.name ?? t.error ?? "неизвестный токен"}</p>
        </div>
        <Pill tone={v.tone}>{v.label}</Pill>
      </header>

      <div className="token-value">
        <div>
          <strong className="mono">{money(t.valueUsd)}</strong>
          <small className="mono">
            {fmtAmount(t.amount)} {t.symbol} · {t.market ? moneySmart(t.market.price) : "—"} · {t.share.toFixed(1)}% портфеля
          </small>
        </div>
        <div style={{ textAlign: "right" }}>
          <Delta value={t.market?.change24h} />
          <div style={{ marginTop: 3 }}>
            <span style={{ color: "#a3a9b6", fontSize: 9, marginRight: 5 }}>7Д</span>
            <Delta value={t.market?.change7d} />
          </div>
        </div>
      </div>

      <div className="token-chart">
        <Spark data={t.market?.sparkline7d ?? []} />
      </div>

      {(chains.length > 0 || categories.length > 0) && (
        <div className="token-tags">
          {categories.map((c) => (
            <span className="chain-tag" key={c} style={{ color: "#4658ea", borderColor: "#dfe3fb", background: "#f6f7ff" }}>
              {c}
            </span>
          ))}
          {chains.map((c) => (
            <span className="chain-tag" key={c}>
              {c}
            </span>
          ))}
        </div>
      )}

      <div className="token-meta-row">
        <RiskMeter score={t.score} />
      </div>

      {!!t.indicators && (
        <div className="ind-row">
          {readIndicators(t.indicators)
            .filter((i) => i.tone !== "neutral")
            .slice(0, 2)
            .map((i) => (
              <span key={i.text} className={`ind ${i.tone}`}>
                {i.text}
              </span>
            ))}
        </div>
      )}

      {!!(t.ai?.pros.length || t.ai?.cons.length) && (
        <div className="card-proscons">
          {t.ai.pros[0] && (
            <p className="p">
              <i />
              {t.ai.pros[0]}
            </p>
          )}
          {t.ai.cons[0] && (
            <p className="c">
              <i />
              {t.ai.cons[0]}
            </p>
          )}
        </div>
      )}

      {t.best ? (
        <div className="token-earn">
          <PiggyBank size={16} strokeWidth={2} />
          <b className="mono" title="Доходность в год, если поставить токен в этот пул">
            {t.best.apy.toFixed(1)}% в год
          </b>
          {t.best.project}
          <RiskDots risk={t.best.risk} />
          <span className="mono">
            +{money(t.potentialYearlyUsd)} <ArrowUpRight size={11} style={{ verticalAlign: "-1px" }} />
          </span>
        </div>
      ) : (
        <div className="token-earn empty">
          <PiggyBank size={16} strokeWidth={2} />
          Заработать на нём негде
          <span>
            что делать <ArrowUpRight size={11} style={{ verticalAlign: "-1px" }} />
          </span>
        </div>
      )}
    </button>
  );
}

"use client";

import { useEffect, useState } from "react";
import { money, pct } from "@/lib/format";

const W = 720;
const H = 150;

const RANGES: { id: string; label: string; days: number }[] = [
  { id: "7d", label: "7Д", days: 7 },
  { id: "30d", label: "30Д", days: 30 },
  { id: "90d", label: "90Д", days: 90 },
  { id: "1y", label: "1Г", days: 365 },
];

/** График стоимости портфеля: 7 дней из спарклайнов, дальше — история цен DeFiLlama. */
export function PortfolioChart({ series: week, change24hUsd }: { series: number[]; change24hUsd: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [range, setRange] = useState("7d");
  const [loaded, setLoaded] = useState<Record<string, number[]>>({});
  const [loading, setLoading] = useState(false);

  const active = RANGES.find((r) => r.id === range) ?? RANGES[0];
  const series = range === "7d" ? week : (loaded[range] ?? []);

  useEffect(() => {
    // флаг загрузки ставит обработчик переключения: setState в теле эффекта запрещён
    if (range === "7d" || loaded[range]) return;
    fetch(`/api/history?days=${active.days}`)
      .then((r) => r.json())
      .then((d: { series?: number[] }) => setLoaded((prev) => ({ ...prev, [range]: d.series ?? [] })))
      .catch(() => setLoaded((prev) => ({ ...prev, [range]: [] })))
      .finally(() => setLoading(false));
  }, [range, active.days, loaded]);

  const switcher = (
    <div className="view-toggle" style={{ padding: 2 }}>
      {RANGES.map((r) => (
        <button
          key={r.id}
          className={range === r.id ? "active" : ""}
          style={{ height: 24, padding: "0 9px", fontSize: 10 }}
          onClick={() => {
            setRange(r.id);
            if (r.id !== "7d" && !loaded[r.id]) setLoading(true);
          }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  if (series.length < 4) {
    return (
      <div className="hero-card">
        <div className="hero-head">
          <span className="label">СТОИМОСТЬ ПОРТФЕЛЯ</span>
          {switcher}
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          {loading ? "Загружаю историю…" : "Истории для этого периода нет — источник не отдал цены по вашим токенам."}
        </p>
      </div>
    );
  }

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const last = series[series.length - 1];
  const first = series[0];
  const weekPct = first > 0 ? ((last - first) / first) * 100 : 0;
  const up = last >= first;
  const color = up ? "var(--green)" : "var(--red)";

  const x = (i: number) => (i / (series.length - 1)) * W;
  const y = (v: number) => H - 8 - ((v - min) / span) * (H - 26);
  const line = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  const hoverIndex = hover == null ? null : Math.max(0, Math.min(series.length - 1, Math.round(hover * (series.length - 1))));
  const hoursAgo = hoverIndex == null ? 0 : series.length - 1 - hoverIndex;

  return (
    <div className="hero-card">
      <div className="hero-head">
        <div>
          <span className="label">СТОИМОСТЬ ПОРТФЕЛЯ</span>
          <strong className="hero-value mono">{money(last)}</strong>
          <div className="hero-sub">
            <span className={`delta mono ${change24hUsd >= 0 ? "up" : "down"}`}>
              {change24hUsd >= 0 ? "+" : "−"}
              {money(Math.abs(change24hUsd))} за сутки
            </span>
            <span>·</span>
            <span className={`delta mono ${up ? "up" : "down"}`}>
              {pct(weekPct)} за {active.label === "1Г" ? "год" : active.label.toLowerCase()}
            </span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {switcher}
          <div className="mono" style={{ marginTop: 10, fontSize: 11, color: "#8b93a4" }}>
            минимум {money(min)} · максимум {money(max)}
          </div>
        </div>
      </div>

      <div className="chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: 150 }}>
          <defs>
            <linearGradient id="pf-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" y1={y(max)} x2={W} y2={y(max)} stroke="#eef0f5" strokeWidth="1" />
          <line x1="0" y1={y(min)} x2={W} y2={y(min)} stroke="#eef0f5" strokeWidth="1" />
          <path d={area} fill="url(#pf-fill)" />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hoverIndex != null && (
            <circle cx={x(hoverIndex)} cy={y(series[hoverIndex])} r="3.5" fill="#fff" stroke={color} strokeWidth="2" />
          )}
          <rect
            x="0"
            y="0"
            width={W}
            height={H}
            fill="transparent"
            onMouseMove={(e) => {
              const box = (e.target as SVGRectElement).getBoundingClientRect();
              setHover((e.clientX - box.left) / box.width);
            }}
            onMouseLeave={() => setHover(null)}
          />
        </svg>

        {hoverIndex != null && hover != null && (
          <>
            <div className="chart-cursor" style={{ left: `${hover * 100}%` }} />
            <div className="chart-tip mono" style={{ left: `${Math.min(92, Math.max(8, hover * 100))}%` }}>
              {money(series[hoverIndex])} ·{" "}
              {hoursAgo === 0
                ? "сейчас"
                : range === "7d"
                  ? `${hoursAgo} ч назад`
                  : `${Math.round((hoursAgo * active.days) / Math.max(series.length - 1, 1))} дн назад`}
            </div>
          </>
        )}

        <div className="chart-axis">
          <span>{active.days} дней назад</span>
          {range !== "7d" && <span style={{ textTransform: "none", letterSpacing: 0 }}>текущие позиции по историческим ценам</span>}
          <span>сейчас</span>
        </div>
      </div>
    </div>
  );
}

const COLORS = ["#4d5ff6", "#2daf70", "#e9a23b", "#8c61e8", "#3ec5d8", "#e0474f", "#8b93a4"];

/** Донат по аллокации: видно перекос портфеля без чтения таблицы. */
export function Allocation({
  tokens,
  fearGreed,
}: {
  tokens: { symbol: string; share: number; valueUsd: number }[];
  fearGreed?: { value: number; label: string } | null;
}) {
  const visible = tokens.filter((t) => t.share >= 0.5).slice(0, 6);
  const restShare = tokens.reduce((s, t) => s + t.share, 0) - visible.reduce((s, t) => s + t.share, 0);
  const slices = restShare > 0.5 ? [...visible, { symbol: "Прочее", share: restShare, valueUsd: 0 }] : visible;

  const R = 54;
  const STROKE = 16;
  const C = 2 * Math.PI * R;
  // смещения считаем заранее: мутировать переменную внутри map во время рендера нельзя
  const arcs = slices.reduce<{ len: number; offset: number }[]>((acc, s) => {
    const prev = acc[acc.length - 1];
    const offset = prev ? prev.offset + prev.len : 0;
    acc.push({ len: (s.share / 100) * C, offset });
    return acc;
  }, []);

  return (
    <div className="hero-card">
      <div className="hero-head">
        <div>
          <span className="label">ЧТО В ПОРТФЕЛЕ</span>
          <p className="hint" style={{ marginTop: 6, fontSize: 11 }}>
            {slices[0] ? `${slices[0].symbol} — ${slices[0].share.toFixed(0)}% портфеля` : "нет позиций"}
          </p>
        </div>
        {fearGreed && (
          <span
            className={`pill ${fearGreed.value < 25 ? "pill-red" : fearGreed.value < 45 ? "pill-amber" : fearGreed.value < 60 ? "pill-gray" : "pill-green"}`}
            title="Индекс страха и жадности, alternative.me"
          >
            {fearGreed.label} {fearGreed.value}
          </span>
        )}
      </div>

      <div className="donut-row">
        <svg width="132" height="132" viewBox="0 0 132 132" style={{ flex: "0 0 auto" }}>
          <circle cx="66" cy="66" r={R} fill="none" stroke="#f1f3f8" strokeWidth={STROKE} />
          {slices.map((s, i) => (
            <circle
              key={s.symbol}
              cx="66"
              cy="66"
              r={R}
              fill="none"
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={STROKE}
              strokeDasharray={`${arcs[i].len} ${C - arcs[i].len}`}
              strokeDashoffset={-arcs[i].offset}
              transform="rotate(-90 66 66)"
              strokeLinecap="butt"
            />
          ))}
          <text x="66" y="63" textAnchor="middle" fontSize="11" fill="#8b93a4" fontWeight="700">
            ТОКЕНОВ
          </text>
          <text x="66" y="80" textAnchor="middle" fontSize="18" fill="#172033" fontWeight="700">
            {tokens.length}
          </text>
        </svg>

        <div className="donut-legend">
          {slices.map((s, i) => (
            <div key={s.symbol}>
              <i style={{ background: COLORS[i % COLORS.length] }} />
              {s.symbol}
              <b className="mono">{s.share.toFixed(1)}%</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

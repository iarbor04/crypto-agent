"use client";

import { pct, scoreColor } from "@/lib/format";

/** Спарклайн на чистом SVG — в дизайн-системе нет чарт-библиотеки. */
export function Sparkline({ data, width = 88, height = 26 }: { data: number[]; width?: number; height?: number }) {
  if (!data || data.length < 3) return <div style={{ width, height }} />;
  const step = Math.max(1, Math.floor(data.length / 60));
  const pts = data.filter((_, i) => i % step === 0);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const up = pts[pts.length - 1] >= pts[0];
  const color = up ? "var(--green)" : "var(--red)";
  const d = pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * (width - 2) + 1;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={`${d} L${width - 1},${height} L1,${height} Z`} fill={color} opacity={0.09} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

export function Health({ score }: { score: number }) {
  return (
    <div className="health">
      <div className="health-bar">
        <span style={{ width: `${score}%`, background: scoreColor(score) }} />
      </div>
      <strong className="mono" style={{ color: scoreColor(score) }}>
        {score}
      </strong>
    </div>
  );
}

export function Delta({ value, digits = 1 }: { value: number | null | undefined; digits?: number }) {
  const v = value ?? null;
  const cls = v == null ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat";
  return <span className={`delta mono ${cls}`}>{pct(v, digits)}</span>;
}

export function Pill({ tone, children }: { tone: "blue" | "green" | "amber" | "red" | "gray"; children: React.ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function RiskDots({ risk }: { risk: number }) {
  const color = risk <= 2 ? "var(--green)" : risk === 3 ? "var(--amber)" : "var(--red)";
  return (
    <span className="risk-dots" title={`Риск ${risk} из 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} style={i <= risk ? { background: color } : undefined} />
      ))}
    </span>
  );
}

export function Loader({ text = "Считаю портфель" }: { text?: string }) {
  return (
    <div className="loading">
      <i />
      {text}…
    </div>
  );
}

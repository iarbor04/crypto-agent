"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { KIND, VERDICT, amount as fmtAmount, money, moneySmart, pct, short } from "@/lib/format";
import type { Opportunity, TokenAnalysis } from "@/lib/types";
import type { Venue } from "@/lib/liquidity";
import { Delta, Health, Pill, RiskDots, Sparkline } from "./bits";

type Tab = "earn" | "why" | "profile" | "news" | "exit";

export function TokenDrawer({ token, onClose }: { token: TokenAnalysis; onClose: () => void }) {
  const bad = token.verdict === "sell" || token.verdict === "reduce";
  const [tab, setTab] = useState<Tab>(bad ? "exit" : "earn");
  const [stable, setStable] = useState<Opportunity | null>(null);
  const [venues, setVenues] = useState<Venue[] | null>(null);
  const v = VERDICT[token.verdict];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // «Продавать» без ответа «а куда деть деньги» — бесполезный совет.
  useEffect(() => {
    if (!bad) return;
    fetch(`/api/opportunities?symbol=USDC&value=${Math.round(token.valueUsd)}`)
      .then((r) => r.json())
      .then((d: { opportunities?: Opportunity[] }) => {
        const safe = (d.opportunities ?? []).find(
          (o) => o.kind !== "lp" && o.risk <= 3 && o.tvlUsd >= 1_000_000 && o.apy >= 1,
        );
        setStable(safe ?? null);
      })
      .catch(() => {});
  }, [bad, token.valueUsd]);

  // площадки со спредами тянем только когда открыли вкладку выхода
  useEffect(() => {
    if (tab !== "exit" || venues || !token.meta?.coinId) return;
    fetch(`/api/venues?coinId=${encodeURIComponent(token.meta.coinId)}`)
      .then((r) => r.json())
      .then((d: { venues?: Venue[] }) => setVenues(d.venues ?? []))
      .catch(() => setVenues([]));
  }, [tab, venues, token.meta?.coinId]);

  const tabs: [Tab, string][] = [
    ["earn", `Заработать · ${token.opportunities.length}`],
    ["why", "Разбор"],
    ["profile", "Профиль"],
    ["news", `Новости · ${token.news.length}`],
    ["exit", "Выход и хедж"],
  ];

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            {token.market?.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={token.market.image} alt="" width={40} height={40} style={{ borderRadius: "50%", marginTop: 2 }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2>
                {token.symbol}{" "}
                <span style={{ color: "#9aa1af", fontSize: 13, fontWeight: 400, letterSpacing: 0 }}>
                  {token.meta?.name ?? token.market?.name ?? "неизвестный токен"}
                </span>
                {(token.meta?.rank ?? token.market?.rank) && (
                  <span className="pill pill-gray" style={{ marginLeft: 8, verticalAlign: "3px" }}>
                    #{token.meta?.rank ?? token.market?.rank}
                  </span>
                )}
              </h2>
              {!!token.meta?.categories.length && (
                <div className="token-tags" style={{ marginTop: 8 }}>
                  {token.meta.categories.slice(0, 3).map((c) => (
                    <span
                      className="chain-tag"
                      key={c}
                      style={{ color: "#4658ea", borderColor: "#dfe3fb", background: "#f6f7ff" }}
                    >
                      {c}
                    </span>
                  ))}
                  {token.meta.chains.slice(0, 2).map((c) => (
                    <span className="chain-tag" key={c.chain}>
                      {c.chain}
                    </span>
                  ))}
                </div>
              )}
              <div className="price-row">
                <strong className="mono" style={{ fontSize: 15, color: "var(--ink)" }}>
                  {token.market ? moneySmart(token.market.price) : "—"}
                </strong>
                <span>
                  24ч <Delta value={token.market?.change24h} />
                </span>
                <span>
                  7д <Delta value={token.market?.change7d} />
                </span>
                <span>
                  30д <Delta value={token.market?.change30d} />
                </span>
                <Sparkline data={token.market?.sparkline7d ?? []} width={76} height={22} />
              </div>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="Закрыть">
              <X size={16} />
            </button>
          </div>

          <div className="drawer-stats">
            <div>
              <span>В портфеле</span>
              <strong className="mono">{money(token.valueUsd)}</strong>
              <small>
                {fmtAmount(token.amount)} {token.symbol}
              </small>
            </div>
            <div>
              <span>Вердикт</span>
              <strong style={{ marginTop: 6 }}>
                <Pill tone={v.tone}>{v.label}</Pill>
              </strong>
              <small>{v.hint}</small>
            </div>
            <div>
              <span>Здоровье</span>
              <strong style={{ marginTop: 9 }}>
                <Health score={token.score} />
              </strong>
              <small>{token.score} из 100 по 7 факторам</small>
            </div>
          </div>
        </div>

        <div className="tabs">
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {tab === "earn" && <EarnTab token={token} />}
          {tab === "why" && <WhyTab token={token} />}
          {tab === "profile" && <ProfileTab token={token} />}
          {tab === "news" && <NewsTab token={token} />}
          {tab === "exit" && <ExitTab token={token} stable={stable} bad={bad} venues={venues} />}
        </div>
      </aside>
    </div>
  );
}

function EarnTab({ token }: { token: TokenAnalysis }) {
  if (!token.opportunities.length) {
    return (
      <div>
        <p className="hint" style={{ marginBottom: 14 }}>
          По {token.symbol} нет пулов с TVL больше $100K — ни нативного стейкинга, ни лендинга. Такой токен не работает:
          он либо растёт в цене, либо просто лежит.
        </p>
        <div className="opp">
          <div className="opp-notes" style={{ borderTop: 0, paddingLeft: 16 }}>
            • Проверить стейкинг на бирже (Binance Simple Earn, OKX Earn) — часто есть там, где нет в DeFi.
            <br />• Собрать LP с ETH или USDC на DEX — но это уже риск impermanent loss.
            <br />• Если тезис по токену не работает — переложить в актив, который платит (вкладка «Выход и хедж»).
          </div>
        </div>
      </div>
    );
  }

  const single = token.opportunities.filter((o) => o.kind !== "lp");
  const pools = token.opportunities.filter((o) => o.kind === "lp");

  return (
    <>
      <div className="section-title">
        <h3>Куда поставить {token.symbol}</h3>
        <span>{token.best ? `потенциал: ${money(token.potentialYearlyUsd)} в год` : "надёжного варианта нет"}</span>
      </div>
      <p className="hint" style={{ marginBottom: 16 }}>
        {token.best
          ? "Сортировка не по «самому жирному APY», а по устойчивой доходности: спот-ставка подрезана средней за 30 дней, учтены глубина пула, доля наградных токенов и риск протокола."
          : `Однотокенного стейкинга или лендинга с приемлемым риском по ${token.symbol} нет — только пулы ниже, где доход держится на эмиссии или тонком TVL. Ставить туда основную позицию не стоит.`}
      </p>

      {!!single.length && (
        <>
          <div className="section-title">
            <h3>Стейкинг и лендинг</h3>
            <span>один актив, без impermanent loss</span>
          </div>
          {single.map((o) => (
            <OppCard key={o.id} o={o} />
          ))}
        </>
      )}

      {!!pools.length && (
        <>
          <div className="section-title" style={{ marginTop: 24 }}>
            <h3>LP-пулы</h3>
            <span>доход выше, но нужен второй актив и есть IL</span>
          </div>
          {pools.map((o) => (
            <OppCard key={o.id} o={o} />
          ))}
        </>
      )}

      <p className="hint" style={{ marginTop: 16, fontSize: 10.5 }}>
        Точки справа — риск протокола от 1 до 5: TVL пула, impermanent loss, доля наградных токенов в ставке и пометки
        DeFiLlama. Раскройте «Риски», чтобы увидеть, из чего он сложился.
      </p>
    </>
  );
}

type PoolExtra = {
  history: { points: { date: string; apy: number }[]; apyMedian90d: number | null; apyMin90d: number | null; apyMax90d: number | null } | null;
  economics: { name: string; fees24h: number | null; fees30d: number | null; audits: string | null } | null;
};

/** Мини-график ставки: показывает, держится APY или это разовый выброс. */
function ApySpark({ points }: { points: { apy: number }[] }) {
  if (points.length < 5) return null;
  const step = Math.max(1, Math.floor(points.length / 90));
  const vals = points.filter((_, i) => i % step === 0).map((p) => p.apy);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const d = vals
    .map((v, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * 280).toFixed(1)},${(34 - ((v - min) / span) * 30).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 280 36" preserveAspectRatio="none" style={{ width: "100%", height: 36 }}>
      <path d={`${d} L280,36 L0,36 Z`} fill="var(--green)" opacity={0.08} />
      <path d={d} fill="none" stroke="var(--green)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function OppCard({ o }: { o: Opportunity }) {
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState<PoolExtra | null>(null);

  // историю ставки и комиссии протокола тянем только когда раскрыли карточку
  useEffect(() => {
    if (!open || extra) return;
    fetch(`/api/pool?id=${encodeURIComponent(o.id)}&slug=${encodeURIComponent(o.projectSlug)}`)
      .then((r) => r.json())
      .then((d: PoolExtra) => setExtra(d))
      .catch(() => setExtra({ history: null, economics: null }));
  }, [open, extra, o.id, o.projectSlug]);

  return (
    <div className="opp">
      <div className="opp-main">
        <div>
          <strong>{o.project}</strong>{" "}
          <span className="pill pill-gray" style={{ marginLeft: 6 }}>
            {KIND[o.kind] ?? o.kind}
          </span>{" "}
          <span style={{ color: "#9aa1af", fontSize: 10 }}>{o.chain}</span>
          <small className="mono">
            {o.pair} · TVL ${short(o.tvlUsd)}
            {o.apyReward ? ` · база ${(o.apyBase ?? 0).toFixed(1)}% + награды ${o.apyReward.toFixed(1)}%` : ""}
          </small>
        </div>
        <div className="opp-apy">
          <b className="mono">{o.apy.toFixed(1)}%</b>
          <span>годовых</span>
        </div>
        <div style={{ flex: "0 0 84px", textAlign: "right" }}>
          <RiskDots risk={o.risk} />
          {!!o.yearlyUsd && (
            <div className="mono" style={{ marginTop: 5, fontSize: 10, color: "#9aa1af" }}>
              +{money(o.yearlyUsd)}/год
            </div>
          )}
        </div>
      </div>
      <div className="opp-foot">
        <button className="link-button" onClick={() => setOpen(!open)}>
          {open ? "− Риски" : "+ Риски"}
        </button>
        {o.apyMean30d != null && (
          <span className="mono">
            средний за 30д: {o.apyMean30d.toFixed(1)}%{o.trend === "down" ? " ↓" : o.trend === "up" ? " ↑" : ""}
          </span>
        )}
        <a href={o.url} target="_blank" rel="noreferrer" className="link-button" style={{ marginLeft: "auto" }}>
          Открыть пул <ArrowUpRight size={11} style={{ verticalAlign: "-1px" }} />
        </a>
      </div>
      {open && (
        <div className="opp-notes">
          {o.riskNotes.length
            ? o.riskNotes.map((n, i) => (
                <span key={i}>
                  • {n}
                  <br />
                </span>
              ))
            : "• Явных красных флагов нет"}

          {extra?.history && extra.history.points.length > 5 && (
            <div style={{ marginTop: 12, marginLeft: -18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                <span style={{ fontWeight: 700 }}>Ставка за полгода</span>
                <span className="mono">
                  медиана 90д {extra.history.apyMedian90d?.toFixed(1)}% · диапазон {extra.history.apyMin90d?.toFixed(1)}–
                  {extra.history.apyMax90d?.toFixed(1)}%
                </span>
              </div>
              <ApySpark points={extra.history.points} />
              {extra.history.apyMedian90d != null && o.apy > extra.history.apyMedian90d * 2 && (
                <div style={{ color: "#b9741a", marginTop: 4 }}>
                  Сейчас вдвое выше медианы — ставка, скорее всего, вернётся к обычной
                </div>
              )}
            </div>
          )}

          {extra?.economics?.fees30d ? (
            <div style={{ marginTop: 10 }}>
              • Протокол собрал {money(extra.economics.fees30d)} комиссий за 30 дней
              {extra.economics.audits && extra.economics.audits !== "0" ? " · аудиты есть" : " · аудитов нет"}
            </div>
          ) : null}

          {open && !extra && <div style={{ marginTop: 8, color: "#a3a9b6" }}>Загружаю историю ставки…</div>}
        </div>
      )}
    </div>
  );
}

function WhyTab({ token }: { token: TokenAnalysis }) {
  const m = token.market;
  return (
    <>
      <div className="section-title">
        <h3>Из чего собрался скор {token.score}/100</h3>
        <span>вес фактора в баллах</span>
      </div>
      {token.reasons.map((r, i) => (
        <div className="reason" key={i}>
          <b
            className="mono"
            style={{ color: r.kind === "bad" ? "var(--red)" : r.kind === "good" ? "var(--green)" : "#9aa1af" }}
          >
            {r.weight > 0 ? "+" : ""}
            {r.weight ? r.weight.toFixed(0) : "•"}
          </b>
          <span>{r.text}</span>
        </div>
      ))}
      {!token.reasons.length && <p className="hint">Нет данных для разбора.</p>}

      {m && (
        <div className="drawer-stats" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginTop: 22 }}>
          <div>
            <span>Капитализация</span>
            <strong className="mono">${short(m.marketCap)}</strong>
            <small>{m.rank ? `#${m.rank} по рынку` : "вне топа"}</small>
          </div>
          <div>
            <span>Объём 24ч</span>
            <strong className="mono">${short(m.volume24h)}</strong>
            <small>{m.marketCap ? `${((m.volume24h / m.marketCap) * 100).toFixed(1)}% капитализации` : ""}</small>
          </div>
          <div>
            <span>От максимума</span>
            <strong className="mono">{pct(m.athChangePct, 0)}</strong>
            <small>исторический хай</small>
          </div>
          <div>
            <span>В обороте</span>
            <strong className="mono">
              {m.circulatingSupply && m.totalSupply ? `${((m.circulatingSupply / m.totalSupply) * 100).toFixed(0)}%` : "—"}
            </strong>
            <small>{m.totalSupply ? `из ${short(m.totalSupply)} всего` : ""}</small>
          </div>
          <div>
            <span>Надёжный APY</span>
            <strong className="mono">{token.best ? `${token.best.apy.toFixed(1)}%` : "нет"}</strong>
            <small>{token.best ? `${token.best.project}, риск ${token.best.risk}/5` : "только высокий риск"}</small>
          </div>
          <div>
            <span>Тон новостей</span>
            <strong className="mono">{token.newsTone.toFixed(1)}</strong>
            <small>шкала от −3 до +3</small>
          </div>
          <div>
            <span>Фондирование перпа</span>
            <strong
              className="mono"
              style={{
                color:
                  token.funding == null
                    ? "var(--ink)"
                    : token.funding > 0.0004
                      ? "var(--red)"
                      : token.funding < -0.0002
                        ? "var(--green)"
                        : "var(--ink)",
              }}
            >
              {token.funding == null ? "нет перпа" : `${(token.funding * 3 * 365 * 100).toFixed(0)}%/год`}
            </strong>
            <small>
              {token.funding == null
                ? "фьючерса на Binance нет"
                : token.funding > 0.0004
                  ? "в лонгах тесно — риск каскада ликвидаций"
                  : token.funding < -0.0002
                    ? "платят шортистам — давление продавцов"
                    : "нейтрально"}
            </small>
          </div>
        </div>
      )}
    </>
  );
}

function ProfileTab({ token }: { token: TokenAnalysis }) {
  const m = token.meta;
  if (!m) {
    return (
      <p className="hint">
        CoinGecko не отдал профиль по этому токену. Проверьте тикер в «Мои токены» — возможно, подставилась не та монета.
      </p>
    );
  }
  return (
    <>
      <div className="meta-grid">
        <div className="meta-item">
          <span>Место по капитализации</span>
          <strong className="mono">{m.rank ? `#${m.rank}` : "вне рейтинга"}</strong>
        </div>
        <div className="meta-item">
          <span>В вотчлистах CoinGecko</span>
          <strong className="mono">{m.watchlistUsers ? m.watchlistUsers.toLocaleString("ru-RU") : "—"}</strong>
        </div>
        <div className="meta-item">
          <span>Категории</span>
          <strong style={{ fontSize: 12, lineHeight: 1.5 }}>{m.categories.join(" · ") || "не указаны"}</strong>
        </div>
        <div className="meta-item">
          <span>Запуск сети</span>
          <strong className="mono">
            {m.genesisDate ? new Date(m.genesisDate).toLocaleDateString("ru-RU") : m.chains.length ? "токен, не сеть" : "—"}
          </strong>
        </div>
      </div>

      {m.description && <p className="desc">{m.description}</p>}

      <div className="meta-links">
        <a href={m.cgUrl} target="_blank" rel="noreferrer">
          CoinGecko <ArrowUpRight size={11} />
        </a>
        {m.homepage && (
          <a href={m.homepage} target="_blank" rel="noreferrer">
            Сайт проекта <ArrowUpRight size={11} />
          </a>
        )}
        {m.twitter && (
          <a href={m.twitter} target="_blank" rel="noreferrer">
            X / Twitter <ArrowUpRight size={11} />
          </a>
        )}
        {m.explorer && (
          <a href={m.explorer} target="_blank" rel="noreferrer">
            Эксплорер <ArrowUpRight size={11} />
          </a>
        )}
        {m.github && (
          <a href={m.github} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={11} />
          </a>
        )}
      </div>

      {!!m.chains.length && (
        <>
          <div className="section-title">
            <h3>Контракты по сетям</h3>
            <span>{m.chains.length} сетей · проверяйте адрес перед свапом</span>
          </div>
          {m.chains.map((c) => (
            <div className="contract" key={c.chain}>
              <b>{c.chain}</b>
              <code title={c.address}>{c.address}</code>
              <button className="link-button" onClick={() => navigator.clipboard?.writeText(c.address)}>
                копировать
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function NewsTab({ token }: { token: TokenAnalysis }) {
  if (!token.news.length) return <p className="hint">Свежих новостей по токену в лентах нет.</p>;
  return (
    <>
      {token.news.map((n, i) => {
        const tone =
          n.tone <= -2
            ? { color: "#c33b42", bg: "var(--red-soft)" }
            : n.tone < 0
              ? { color: "#b9741a", bg: "var(--amber-soft)" }
              : n.tone > 0
                ? { color: "#1c8f5a", bg: "var(--green-soft)" }
                : { color: "#6f7789", bg: "var(--soft)" };
        return (
          <a key={i} href={n.url} target="_blank" rel="noreferrer" className="news-item">
            <span className="news-tone mono" style={{ color: tone.color, background: tone.bg }}>
              {n.tone > 0 ? "+" : ""}
              {n.tone}
            </span>
            <div style={{ minWidth: 0 }}>
              <strong>{n.title}</strong>
              <small>
                {n.source}
                {n.publishedAt ? ` · ${new Date(n.publishedAt).toLocaleDateString("ru-RU")}` : ""}
                {n.tags.length ? ` · ${n.tags.join(", ")}` : ""}
              </small>
            </div>
          </a>
        );
      })}
    </>
  );
}

function ExitTab({
  token,
  stable,
  bad,
  venues,
}: {
  token: TokenAnalysis;
  stable: Opportunity | null;
  bad: boolean;
  venues: Venue[] | null;
}) {
  const L = token.liquidity;
  const cover = L?.sellCapacityUsd && token.valueUsd > 0 ? L.sellCapacityUsd / token.valueUsd : null;

  return (
    <>
      <p className="hint" style={{ marginBottom: 16, color: bad ? "#a83c42" : "var(--muted)" }}>
        {bad
          ? `Позиция ${money(token.valueUsd)} с health ${token.score}/100. Ниже — как выйти, не уронив себе цену, и куда переложить деньги.`
          : `Позиция в порядке (health ${token.score}/100), продавать причин нет. Инструменты ниже — если решение всё равно нужно.`}
      </p>

      {L && (
        <div className="depth-card">
          <div className="depth-head">
            <div>
              <span className="label" style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.6 }}>
                ЁМКОСТЬ ВЫХОДА
              </span>
              <strong className="mono" style={{ display: "block", marginTop: 6 }}>
                {money(L.sellCapacityUsd)}
              </strong>
            </div>
            <span
              className={`pill ${cover == null ? "pill-gray" : cover < 1.5 ? "pill-red" : cover < 5 ? "pill-amber" : "pill-green"}`}
            >
              {cover == null
                ? "нет данных"
                : cover < 1.5
                  ? `позиция больше рынка в ${(1 / cover).toFixed(1)}×`
                  : `позиция влезает ${cover < 100 ? cover.toFixed(1) : Math.round(cover)}×`}
            </span>
          </div>

          {L.binance && (
            <>
              <p className="hint" style={{ marginBottom: 10, fontSize: 10.5 }}>
                Стакан {L.binance.venue} {L.binance.pair} · спред {L.binance.spreadPct.toFixed(3)}% · сколько уходит в
                биды при просадке цены:
              </p>
              <div className="depth-ladder">
                <div>
                  <span>до −0.5%</span>
                  <b className="mono">{money(L.binance.usd05)}</b>
                </div>
                <div>
                  <span>до −1%</span>
                  <b className="mono">{money(L.binance.usd1)}</b>
                </div>
                <div>
                  <span>до −2%</span>
                  <b className="mono">{money(L.binance.usd2)}</b>
                </div>
              </div>
            </>
          )}

          {!!L.dexPairs.length && (
            <>
              <p className="hint" style={{ margin: "14px 0 8px", fontSize: 10.5 }}>
                DEX-пулы: ликвидность {money(L.dexTotalUsd)} в {L.dexPairs.length} парах (DexScreener)
              </p>
              {L.dexPairs.map((p) => (
                <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="venue-row" style={{ borderRadius: 8 }}>
                  <b>
                    {p.dex} · {p.chain}
                  </b>
                  <span className="mono">{p.pair}</span>
                  <span className="mono" style={{ color: "#8b93a4" }}>
                    пул {money(p.liquidityUsd)} · оборот {money(p.volume24h)}
                  </span>
                  <ArrowUpRight size={12} style={{ marginLeft: "auto" }} />
                </a>
              ))}
            </>
          )}

          {!L.binance && !L.dexPairs.length && (
            <p className="hint" style={{ fontSize: 10.5 }}>
              Ни пары на Binance, ни DEX-пулов не нашлось — выход придётся искать вручную.
            </p>
          )}
        </div>
      )}

      {venues === null && token.meta?.coinId && (
        <p className="hint" style={{ marginBottom: 14, fontSize: 10.5 }}>
          Загружаю площадки со спредами…
        </p>
      )}

      {!!venues?.length && (
        <>
          <div className="section-title">
            <h3>Где продавать</h3>
            <span>по объёму, со спредом bid/ask</span>
          </div>
          <div className="venue-list">
            {venues.map((v) => (
              <div className="venue-row" key={`${v.name}-${v.pair}`}>
                <b>{v.name}</b>
                <span className="mono">{v.pair}</span>
                <span className="mono" style={{ color: "#8b93a4" }}>
                  {money(v.volumeUsd)} / сутки
                </span>
                <span
                  className="spread mono"
                  style={{
                    color: v.spreadPct == null ? "#8b93a4" : v.spreadPct < 0.2 ? "var(--green)" : v.spreadPct < 1 ? "var(--amber)" : "var(--red)",
                  }}
                >
                  {v.spreadPct == null ? "—" : `${v.spreadPct.toFixed(2)}%`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {bad && stable && (
        <div className="opp" style={{ borderColor: "#bfe6d3", marginBottom: 18 }}>
          <div className="opp-main" style={{ background: "var(--green-soft)" }}>
            <div>
              <strong>Куда переложить: {stable.project}</strong>
              <small className="mono">
                USDC · {stable.chain} · риск {stable.risk}/5 · TVL ${short(stable.tvlUsd)}
              </small>
            </div>
            <div className="opp-apy">
              <b className="mono">{stable.apy.toFixed(1)}%</b>
              <span>годовых</span>
            </div>
          </div>
          <div className="opp-foot">
            <span className="mono">
              {money((token.valueUsd * stable.apy) / 100)} в год с той же суммы, без риска цены токена
            </span>
            <a href={stable.url} target="_blank" rel="noreferrer" className="link-button" style={{ marginLeft: "auto" }}>
              Открыть <ArrowUpRight size={11} style={{ verticalAlign: "-1px" }} />
            </a>
          </div>
        </div>
      )}

      {token.exits.map((e, i) => (
        <a key={i} href={e.url} target="_blank" rel="noreferrer" className="exit-item">
          <strong>
            {e.label} <ArrowUpRight size={12} style={{ verticalAlign: "-1px" }} />
          </strong>
          <p>{e.hint}</p>
        </a>
      ))}

      <p className="hint" style={{ marginTop: 16, fontSize: 10.5 }}>
        Цифры — расчёт по публичным данным CoinGecko и DeFiLlama. Не инвестиционная рекомендация.
      </p>
    </>
  );
}

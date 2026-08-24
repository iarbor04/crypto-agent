/* Дашборд без сборки: обычный JavaScript, три страницы на хэш-роутере.
   Данные приходят из Python-сервера, разметка собирается строками. */
"use strict";

// ————— утилиты —————

const $ = (sel, root) => (root || document).querySelector(sel);
const view = () => $("#view");

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const money = (n, digits) => {
  const v = Number(n || 0);
  const fixed = v.toLocaleString("ru-RU", { minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0 });
  return "$" + fixed.replace(/ /g, " ");
};
const moneySmart = (n) => {
  const a = Math.abs(Number(n || 0));
  if (a >= 1000) return money(n);
  if (a >= 1) return money(n, 2);
  return "$" + Number(n || 0).toPrecision(3);
};
const pct = (n, digits) => (n == null || isNaN(n) ? "—" : (n > 0 ? "+" : "") + Number(n).toFixed(digits == null ? 1 : digits) + "%");
const short = (n) => {
  const a = Math.abs(Number(n || 0));
  if (a >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(Math.round(n || 0));
};
const amount = (n) =>
  Number(n || 0) >= 1000
    ? Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 0 }).replace(/ /g, " ")
    : Number(n || 0).toLocaleString("ru-RU", { maximumFractionDigits: 4 });

const timeAgo = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return m + " мин назад";
  const h = Math.round(m / 60);
  return h < 24 ? h + " ч назад" : Math.round(h / 24) + " дн назад";
};

const RISK_STEPS = ["Критический", "Высокий", "Повышенный", "Умеренный", "Низкий"];
const riskColor = (step) => ["", "var(--red)", "#e0655b", "var(--amber)", "var(--blue)", "var(--green)"][step];
const VERDICT = {
  sell: { label: "Тренд сломан", tone: "red" },
  reduce: { label: "Слабее рынка", tone: "amber" },
  watch: { label: "Смешанные сигналы", tone: "gray" },
  hold: { label: "В рамках рынка", tone: "blue" },
  accumulate: { label: "Сильнее рынка", tone: "green" },
};
const KIND = { staking: "Стейкинг", "liquid-staking": "Ликвидный стейкинг", lending: "Лендинг", lp: "LP-пул", farm: "Фарминг" };

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options || {}));
  const json = await res.json().catch(() => ({}));
  // сессия кончилась, пока страница была открыта — уводим на вход, а не показываем ошибку
  if (res.status === 401 && json && json.authRequired) {
    window.location.replace("/login");
    return {};
  }
  if (json && json.warning) console.warn(path, json.warning, json.detail || "");
  return json;
}

// ————— состояние —————

const state = { analysis: null, loading: false, error: null, view: localStorage.getItem("signal-view") || "cards", settings: null, job: null };

function riskMeter(score, withLabel) {
  const step = score < 28 ? 1 : score < 42 ? 2 : score < 56 ? 3 : score < 72 ? 4 : 5;
  const label = ["", "критический", "высокий", "повышенный", "умеренный", "низкий"][step];
  const width = Math.max(4, Math.min(100, 100 - score));
  return (
    '<div class="risk"><div class="risk-bar"><span style="width:' + width + "%;background:" + riskColor(step) + '"></span></div>' +
    (withLabel === false ? "" : '<strong style="color:' + riskColor(step) + '">' + label + "</strong>") +
    "</div>"
  );
}

function riskScale(score) {
  const step = score < 28 ? 1 : score < 42 ? 2 : score < 56 ? 3 : score < 72 ? 4 : 5;
  const track = RISK_STEPS.map((_, i) => '<span style="' + (i + 1 === step ? "background:" + riskColor(step) : "") + '"></span>').join("");
  const labels = RISK_STEPS.map((l, i) => '<span class="' + (i + 1 === step ? "on" : "") + '" style="' + (i + 1 === step ? "color:" + riskColor(step) : "") + '">' + l + "</span>").join("");
  return '<div class="risk-scale"><div class="risk-scale-track">' + track + '</div><div class="risk-scale-labels">' + labels + "</div></div>";
}

const delta = (v) => '<span class="delta mono ' + (v == null ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat") + '">' + pct(v) + "</span>";
const riskDots = (risk) => {
  const color = risk <= 2 ? "var(--green)" : risk === 3 ? "var(--amber)" : "var(--red)";
  let out = '<span class="risk-dots" title="Риск ' + risk + ' из 5">';
  for (let i = 1; i <= 5; i++) out += "<i" + (i <= risk ? ' style="background:' + color + '"' : "") + "></i>";
  return out + "</span>";
};

function sparkline(data, width, height) {
  width = width || 300;
  height = height || 44;
  if (!data || data.length < 4) return "";
  const step = Math.max(1, Math.floor(data.length / 90));
  const pts = data.filter((_, i) => i % step === 0);
  const min = Math.min.apply(null, pts);
  const max = Math.max.apply(null, pts);
  const span = max - min || 1;
  const up = pts[pts.length - 1] >= pts[0];
  const color = up ? "var(--green)" : "var(--red)";
  const path = pts
    .map((v, i) => (i ? "L" : "M") + ((i / (pts.length - 1)) * width).toFixed(1) + "," + (height - 3 - ((v - min) / span) * (height - 8)).toFixed(1))
    .join(" ");
  const id = "g" + Math.random().toString(36).slice(2, 7);
  return (
    '<svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none" style="height:' + height + 'px">' +
    '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity="0.2"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + path + " L" + width + "," + height + " L0," + height + ' Z" fill="url(#' + id + ')"/>' +
    '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>'
  );
}

// ————— загрузка данных —————

// sync=true заставляет сервер пересчитать всё и ждать ответа: это кнопка
// «Обновить». Обычная загрузка берёт готовый снимок, а если он устарел,
// сервер считает в фоне — тогда мы просто дочитываем результат.
async function loadAnalysis(force, sync) {
  if (state.loading) return;
  if (state.analysis && !force) return;
  state.loading = true;
  state.error = null;
  render();
  const data = await api("/api/analysis" + (sync ? "?fresh=1" : ""));
  state.loading = false;
  if (data && data.tokens) {
    state.analysis = data;
    if (data.stale) waitForFresh();
  }
  else state.error = (data && (data.warning || data.error)) || "Не удалось получить разбор";
  render();
}

// Разбор ASCN идёт минуту-две на токен, поэтому гоняем все параллельно
// и показываем, сколько уже готово.
let aiRunAll = { busy: false, done: 0, total: 0 };

async function runAllAnalysis() {
  if (aiRunAll.busy) return;
  const tokens = ((state.analysis && state.analysis.tokens) || []).map((t) => t.symbol);
  if (!tokens.length) return;
  aiRunAll = { busy: true, done: 0, total: tokens.length };
  render();
  await Promise.all(
    tokens.map(async (symbol) => {
      try {
        await api("/api/token/analyze", { method: "POST", body: JSON.stringify({ symbol: symbol }) });
      } finally {
        aiRunAll.done += 1;
        render();
      }
    })
  );
  aiRunAll.busy = false;
  await loadAnalysis(true, true);
}

let freshTimer = null;

function waitForFresh(tries) {
  const left = tries === undefined ? 8 : tries;
  if (freshTimer) clearTimeout(freshTimer);
  if (left <= 0) return;
  freshTimer = setTimeout(async () => {
    const data = await api("/api/analysis");
    if (data && data.tokens) {
      state.analysis = data;
      render();
      if (data.stale) waitForFresh(left - 1);
    }
  }, 5000);
}

setInterval(() => {
  const a = state.analysis;
  if (!a) return;
  const minutes = a.refreshMinutes || 30;
  // по таймеру просим мягко: сервер сам решит, отдать снимок или пересчитать
  if (Date.now() - new Date(a.generatedAt).getTime() >= minutes * 60000) loadAnalysis(true, false);
}, 60000);

// ————— страница «Портфель» —————

function portfolioPage() {
  const a = state.analysis;
  let html = pageHeader({
    eyebrow: "ПОРТФЕЛЬ",
    title: "Мои токены",
    sub: a ? a.tokens.length + " позиций · данные обновлены " + timeAgo(a.generatedAt) : "Собираю цены, доходности, ликвидность и новости",
    actions:
      '<div class="view-toggle"><button data-act="view-cards" class="' + (state.view === "cards" ? "active" : "") + '">Карточки</button>' +
      '<button data-act="view-table" class="' + (state.view === "table" ? "active" : "") + '">Таблица</button></div>' +
      '<button class="ghost-button" data-act="reload">' + (state.loading ? "Считаю…" : "Обновить") + "</button>" +
      '<button class="primary-button" data-act="edit">＋ Мои токены</button>',
  });

  if (state.error) html += '<div class="error-banner">' + esc(state.error) + "</div>";
  if (!a) return html + (state.loading ? '<div class="loading"><i></i>Считаю портфель…</div>' : "");

  if (a.partial)
    html +=
      '<div class="warn-banner"><strong>Данные неполные.</strong> Не ответили: ' + esc(a.warnings.join(", ")) +
      '. Показываю то, что есть — нажмите «Обновить» через минуту.</div>';

  html += '<div class="hero-row">' + heroChart(a) + allocationCard(a) + "</div>";

  const risky = a.tokens.filter((t) => t.score < 56);
  const riskyValue = risky.reduce((s, t) => s + t.valueUsd, 0);
  const needsAction = a.tokens.filter((t) => t.verdict === "sell" || t.verdict === "reduce").length;
  html +=
    '<div class="metric-row">' +
    metricCard(
      "Потолок доходности по пулам",
      money(a.potentialYearlyUsd) + " в год",
      "верхняя граница, если весь " + money(a.idleValueUsd) + " уйдёт в пулы: без учёта локов, риска контракта и потерь LP",
      "var(--green)"
    ) +
    metricCard("В слабых позициях", money(riskyValue), risky.length ? Math.round(a.totalValueUsd ? (riskyValue / a.totalValueUsd) * 100 : 0) + "% портфеля · " + risky.length + " из " + a.tokens.length + " токенов с повышенным риском" : "все позиции с умеренным или низким риском", riskyValue ? "var(--red)" : "var(--green)") +
    metricCard("Слабых позиций", String(needsAction), needsAction ? "позиции слабее рынка или со сломанным трендом" : "все позиции идут с рынком", needsAction ? "var(--red)" : "var(--green)") +
    "</div>";

  // Карточки сигналов с портфеля убраны: то же самое видно в самих карточках
  // токенов и в рейтинге риска. В сводку Telegram сигналы по-прежнему идут.

  if (!a.tokens.length) {
    html +=
      '<div class="empty-state"><h3>Портфель пуст</h3><p>Добавьте свои токены — найдите каждый по тикеру или названию и укажите количество. Цены, доходности, риски и новости подтянутся сами, ключи не нужны.</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="primary-button" data-act="edit">＋ Добавить токены</button>' +
      '<button class="ghost-button" data-act="demo">Посмотреть на демо-портфеле</button></div></div>';
    return html;
  }

  html += state.view === "cards" ? '<div class="token-grid">' + a.tokens.map(tokenCard).join("") + "</div>" : tokenTable(a.tokens);
  return html;
}

function pageHeader(o) {
  return (
    '<div class="page-header"><div><span class="eyebrow">' + o.eyebrow + "</span><h1>" + o.title + "</h1><p>" + esc(o.sub) + "</p></div>" +
    '<div class="top-actions">' + (o.actions || "") + "</div></div>"
  );
}

function metricCard(label, value, note, color) {
  return (
    '<article class="metric-card"><span>' + label + '</span><strong class="mono"' + (color ? ' style="color:' + color + '"' : "") + ">" + value + "</strong>" +
    "<small>" + esc(note) + "</small></article>"
  );
}

function heroChart(a) {
  const s = a.series || [];
  if (s.length < 4)
    return '<div class="hero-card"><div class="hero-head"><span class="label">Стоимость портфеля</span></div><p class="hint" style="margin-top:12px">Недостаточно истории для графика.</p></div>';
  const min = Math.min.apply(null, s);
  const max = Math.max.apply(null, s);
  const span = max - min || 1;
  const up = s[s.length - 1] >= s[0];
  const color = up ? "var(--green)" : "var(--red)";
  const W = 720;
  const H = 150;
  const path = s.map((v, i) => (i ? "L" : "M") + ((i / (s.length - 1)) * W).toFixed(1) + "," + (H - 8 - ((v - min) / span) * (H - 26)).toFixed(1)).join(" ");
  const weekPct = s[0] > 0 ? ((s[s.length - 1] - s[0]) / s[0]) * 100 : 0;
  return (
    '<div class="hero-card"><div class="hero-head"><div><span class="label">Стоимость портфеля</span>' +
    '<strong class="hero-value mono">' + money(s[s.length - 1]) + "</strong>" +
    '<div class="hero-sub"><span class="delta mono ' + (a.change24hUsd >= 0 ? "up" : "down") + '">' +
    (a.change24hUsd >= 0 ? "+" : "−") + money(Math.abs(a.change24hUsd)) + " за сутки</span><span>·</span>" +
    '<span class="delta mono ' + (up ? "up" : "down") + '">' + pct(weekPct) + " за 7 дней</span></div></div>" +
    '<div style="text-align:right"><span class="label">Минимум / максимум недели</span>' +
    '<div class="mono" style="margin-top:8px;font-size:12px;color:#4a5365">' + money(min) + " → " + money(max) + "</div></div></div>" +
    '<div class="chart-wrap"><svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" style="height:150px">' +
    '<defs><linearGradient id="pf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity="0.22"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + path + " L" + W + "," + H + " L0," + H + ' Z" fill="url(#pf)"/><path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' +
    '<div class="chart-axis"><span>7 дней назад</span><span>сейчас</span></div></div></div>'
  );
}

const DONUT_COLORS = ["#4d5ff6", "#2daf70", "#e9a23b", "#8c61e8", "#3ec5d8", "#e0474f", "#8b93a4"];

function allocationCard(a) {
  const slices = a.tokens.filter((t) => t.share >= 0.5).slice(0, 6);
  const R = 54;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = slices
    .map((t, i) => {
      const len = (t.share / 100) * C;
      const el =
        '<circle cx="66" cy="66" r="' + R + '" fill="none" stroke="' + DONUT_COLORS[i % 7] + '" stroke-width="16" stroke-dasharray="' +
        len + " " + (C - len) + '" stroke-dashoffset="' + -offset + '" transform="rotate(-90 66 66)"/>';
      offset += len;
      return el;
    })
    .join("");
  const legend = slices
    .map((t, i) => '<div><i style="background:' + DONUT_COLORS[i % 7] + '"></i>' + esc(t.symbol) + '<b class="mono">' + t.share.toFixed(1) + "%</b></div>")
    .join("");
  const fg = a.context && a.context.fearGreed;
  const fgPill = fg
    ? '<span class="pill ' + (fg.value < 25 ? "pill-red" : fg.value < 45 ? "pill-amber" : fg.value < 60 ? "pill-gray" : "pill-green") + '" title="Индекс страха и жадности">' + esc(fg.label) + " " + fg.value + "</span>"
    : "";
  return (
    '<div class="hero-card"><div class="hero-head"><div><span class="label">Что в портфеле</span>' +
    '<p class="hint" style="margin-top:6px;font-size:11px">' + (slices[0] ? esc(slices[0].symbol) + " — " + Math.round(slices[0].share) + "% портфеля" : "нет позиций") + "</p></div>" + fgPill + "</div>" +
    '<div class="donut-row"><svg width="132" height="132" viewBox="0 0 132 132" style="flex:0 0 auto">' +
    '<circle cx="66" cy="66" r="' + R + '" fill="none" stroke="#f1f3f8" stroke-width="16"/>' + arcs +
    '<text x="66" y="63" text-anchor="middle" font-size="11" fill="#8b93a4" font-weight="700">ТОКЕНОВ</text>' +
    '<text x="66" y="80" text-anchor="middle" font-size="18" fill="#172033" font-weight="700">' + a.tokens.length + "</text></svg>" +
    '<div class="donut-legend">' + legend + "</div></div></div>"
  );
}


function sidesBlock(pros, cons) {
  const rows = []
    .concat((pros || []).slice(0, 2).map((x) => '<p class="p"><i></i>' + esc(x) + "</p>"))
    .concat((cons || []).slice(0, 2).map((x) => '<p class="c"><i></i>' + esc(x) + "</p>"));
  return rows.length ? '<div class="card-proscons">' + rows.join("") + "</div>" : "";
}

function tokenCard(t) {
  const v = VERDICT[t.verdict];
  const rank = (t.meta && t.meta.rank) || (t.market && t.market.rank);
  const tags = []
    .concat(((t.meta && t.meta.categories) || []).slice(0, 2).map((c) => '<span class="chain-tag cat">' + esc(c) + "</span>"))
    .concat(((t.meta && t.meta.chains) || []).slice(0, 3).map((c) => '<span class="chain-tag">' + esc(c.chain) + "</span>"))
    .join("");
  const inds = (t.indicatorsRead || [])
    .filter((i) => i.tone !== "neutral")
    .slice(0, 2)
    .map((i) => '<span class="ind ' + i.tone + '">' + esc(i.text) + "</span>")
    .join("");
  const ai = t.ai || {};
  const prosCons =
    ai.summary
      ? '<p class="card-ai">' + esc(ai.summary) + "</p>" + sidesBlock(ai.pros, ai.cons)
      : sidesBlock(ai.pros, ai.cons);
  const earn = t.best
    ? '<div class="token-earn"><b class="mono">' + t.best.apy.toFixed(1) + "% в год</b> " + esc(t.best.project) + " " + riskDots(t.best.risk) +
      '<span class="right mono">+' + money(t.potentialYearlyUsd) + "</span></div>"
    : '<div class="token-earn empty">Заработать на нём негде<span class="right">что делать →</span></div>';
  const cex = t.cexEarn
    ? '<div class="token-cex">' + esc(t.cexEarn.venue) + " · " + esc(t.cexEarn.kind) +
      '<b class="mono right">' + t.cexEarn.apy.toFixed(1) + "% в год</b></div>"
    : "";

  return (
    '<button class="token-card" data-token="' + esc(t.symbol) + '"><header>' +
    (t.market && t.market.image ? '<img src="' + esc(t.market.image) + '" alt=""/>' : '<span class="asset-blank"></span>') +
    '<div style="flex:1;min-width:0"><h3>' + esc(t.symbol) + (rank ? "<small>#" + rank + "</small>" : "") + "</h3>" +
    "<p>" + esc((t.meta && t.meta.name) || (t.market && t.market.name) || t.error || "неизвестный токен") + "</p></div>" +
    '<span class="pill pill-' + v.tone + '">' + v.label + "</span></header>" +
    '<div class="token-value"><div><strong class="mono">' + money(t.valueUsd) + "</strong>" +
    '<small class="mono">' + amount(t.amount) + " " + esc(t.symbol) + " · " + (t.market ? moneySmart(t.market.price) : "—") + " · " + t.share.toFixed(1) + "% портфеля</small></div>" +
    '<div style="text-align:right">' + delta(t.market && t.market.change24h) + '<div style="margin-top:3px"><span style="color:#a3a9b6;font-size:9px;margin-right:5px">7Д</span>' + delta(t.market && t.market.change7d) + "</div></div></div>" +
    '<div class="token-chart">' + sparkline((t.market && t.market.sparkline7d) || []) + "</div>" +
    (tags ? '<div class="token-tags">' + tags + "</div>" : "") +
    (inds ? '<div class="ind-row">' + inds + "</div>" : "") +
    '<div class="token-meta-row">' + riskMeter(t.score) + "</div>" + prosCons + earn + cex + "</button>"
  );
}

function tokenTable(tokens) {
  const head =
    '<div class="table-head"><span>Токен</span><span class="cell-right">Сколько у вас</span><span class="col-spark">Цена за 7 дней</span>' +
    '<span class="col-delta cell-right">За сутки / неделю</span><span class="col-risk">Риск</span><span class="col-verdict">Состояние</span><span class="cell-right">Стейкинг</span></div>';
  const rows = tokens
    .map((t) => {
      const v = VERDICT[t.verdict];
      return (
        '<div class="table-row" data-token="' + esc(t.symbol) + '"><div class="asset">' +
        (t.market && t.market.image ? '<img src="' + esc(t.market.image) + '" alt=""/>' : '<span class="asset-blank"></span>') +
        "<div><strong>" + esc(t.symbol) + "</strong><small>" + esc((t.meta && t.meta.name) || (t.market && t.market.name) || "—") + "</small></div></div>" +
        '<div class="cell-right"><strong class="mono">' + money(t.valueUsd) + '</strong><div class="mono" style="margin-top:3px;font-size:10px;color:#9aa1af">' + amount(t.amount) + "</div></div>" +
        '<div class="col-spark">' + sparkline((t.market && t.market.sparkline7d) || [], 96, 26) + "</div>" +
        '<div class="col-delta cell-right">' + delta(t.market && t.market.change24h) + '<div style="margin-top:3px">' + delta(t.market && t.market.change7d) + "</div></div>" +
        '<div class="col-risk">' + riskMeter(t.score) + "</div>" +
        '<div class="col-verdict"><span class="pill pill-' + v.tone + '">' + v.label + "</span></div>" +
        '<div class="cell-right">' + (t.best ? '<strong class="mono" style="color:var(--green)">' + t.best.apy.toFixed(1) + "%</strong>" : '<span style="color:#a3a9b6">негде</span>') + "</div></div>"
      );
    })
    .join("");
  return '<div class="card table-card">' + head + rows + "</div>";
}

// ————— страница «Рейтинг риска» —————

function risksPage() {
  const a = state.analysis;
  let html = pageHeader({
    eyebrow: "РЕЙТИНГ РИСКА",
    title: "На что обратить внимание",
    sub: "Самые слабые позиции сверху: что против них, что за них и что с этим делать",
    actions:
      '<button class="ghost-button" data-act="reload">' + (state.loading ? "Считаю…" : "Обновить цены") + "</button>" +
      '<button class="primary-button" data-act="ai-run-all"' + (aiRunAll.busy ? " disabled" : "") + ">" +
      (aiRunAll.busy ? "Разбор ASCN " + aiRunAll.done + " из " + aiRunAll.total + "…" : "Обновить разбор ASCN") +
      "</button>",
  });
  if (!a) return html + (state.loading ? '<div class="loading"><i></i>Собираю метрики…</div>' : "");

  const ranked = a.tokens.slice().sort((x, y) => x.score - y.score);
  const problem = ranked.filter((t) => t.score < 56);
  const fine = ranked.filter((t) => t.score >= 56);
  const atRisk = problem.reduce((s, t) => s + t.valueUsd, 0);

  html +=
    '<div class="metric-row">' +
    metricCard("Под риском", money(atRisk), problem.length + " из " + ranked.length + " позиций с повышенным риском", atRisk ? "var(--red)" : "var(--green)") +
    metricCard("Доля портфеля в слабых позициях", (a.totalValueUsd ? Math.round((atRisk / a.totalValueUsd) * 100) : 0) + "%", "от " + money(a.totalValueUsd) + " общей стоимости") +
    metricCard("Стоит закрыть", String(ranked.filter((t) => t.verdict === "sell").length), "критичные новости или обвал", "var(--red)") +
    "</div>";

  if (!problem.length)
    html += '<div class="empty-state"><h3>Слабых позиций нет</h3><p>Ни у одного токена риск не выше умеренного.</p></div>';
  else html += problem.map((t, i) => riskCard(t, i + 1)).join("");

  if (fine.length) {
    html += '<h2 class="section-heading">Остальные позиции</h2><div class="card">';
    html += fine
      .map((t) => {
        const v = VERDICT[t.verdict];
        return (
          '<div class="fine-row" data-token="' + esc(t.symbol) + '"><strong>' + esc(t.symbol) + "</strong>" +
          '<div style="width:150px">' + riskMeter(t.score) + "</div>" +
          '<span class="mono" style="width:90px;text-align:right">' + money(t.valueUsd) + "</span>" + delta(t.market && t.market.change7d) +
          '<span class="pill pill-' + v.tone + '">' + v.label + "</span>" +
          (t.best ? '<span class="mono" style="margin-left:auto;color:var(--green);font-weight:700">' + t.best.apy.toFixed(1) + "% · " + esc(t.best.project) + "</span>" : "") +
          "</div>"
        );
      })
      .join("");
    html += "</div>";
  }
  return html;
}

function prosConsBlock(t, compact) {
  const ai = t.ai || {};
  // Разбор ассистента ASCN — основной источник. Своя модель показывается,
  // только пока разбора по токену нет, и подписана как своя.
  const fromAi = (ai.pros && ai.pros.length) || (ai.cons && ai.cons.length);
  const pros = fromAi ? ai.pros || [] : t.reasons.filter((r) => r.kind === "good").map((r) => r.text);
  const cons = fromAi ? ai.cons || [] : t.reasons.filter((r) => r.kind === "bad").map((r) => r.text);
  const list = (items, cls, empty) =>
    items.length ? items.slice(0, compact ? 4 : 6).map((x) => "<p><i></i>" + esc(x) + "</p>").join("") : '<p class="none">' + empty + "</p>";
  const source = fromAi
    ? '<p class="pc-source">утверждения ассистента ASCN' + (ai.at ? " от " + when(ai.at) : "") +
      " — даты, суммы и ссылки на людей мы не проверяли</p>"
    : '<p class="pc-source">пока своя модель — разбор ASCN появится после прогона агента</p>';
  return (
    '<div class="pros-cons"><div class="pros"><h4>Что за позицию</h4>' + list(pros, "p", "Плюсов не нашлось") + "</div>" +
    '<div class="cons"><h4>Что против</h4>' + list(cons, "c", "Явных минусов нет") + "</div></div>" + source
  );
}

// Заголовок оценки: если ассистент дал итог — показываем его, а не мою формулу
function verdictHeadline(t, hasUpside) {
  const summary = (t.ai || {}).summary;
  return summary || riskHeadline(t.score, hasUpside);
}

function riskHeadline(score, hasUpside) {
  if (score < 28) return hasUpside ? "Слабый актив, отскок не меняет картину" : "Актив против вас по всем фронтам";
  if (score < 42) return hasUpside ? "Есть плюсы, но минусы весомее" : "Минусы перевешивают, плюсов не нашлось";
  if (score < 56) return hasUpside ? "Смешанная картина, требует контроля" : "Слабо, но пока не критично";
  if (score < 72) return hasUpside ? "Позиция рабочая, риски терпимые" : "Позиция рабочая";
  return hasUpside ? "Сильная позиция, можно зарабатывать" : "Сильная позиция";
}

function riskCard(t, rank) {
  const v = VERDICT[t.verdict];
  const step = t.risk ? t.risk.step : 3;
  const hasUpside = t.reasons.some((r) => r.kind === "good") || ((t.ai || {}).pros || []).length > 0;
  const facts = [];
  const lq = t.liquidity;
  if (lq && lq.sellCapacityUsd) {
    const share = t.valueUsd > 0 ? (t.valueUsd / lq.sellCapacityUsd) * 100 : 0;
    const parts = [];
    if (lq.cexPartUsd) parts.push("стакан Binance " + money(lq.cexPartUsd));
    if (lq.dexPartUsd) parts.push("пулы DEX ~" + money(lq.dexPartUsd) + ", оценка");
    facts.push(
      "Продать без просадки больше 1%: " + money(lq.sellCapacityUsd) +
      (parts.length ? " (" + parts.join(" + ") + ")" : "") +
      " — позиция " + money(t.valueUsd) + " это " + (share < 1 ? "меньше 1" : Math.round(share)) + "% от этого объёма"
    );
  } else {
    facts.push("Позиция " + money(t.valueUsd) + ", глубину рынка измерить не удалось");
  }
  const vol = t.market && t.market.volume24h;
  if (vol && t.valueUsd > 0) {
    const pct = (t.valueUsd / vol) * 100;
    facts.push("позиция — " + (pct < 0.1 ? "меньше 0.1" : pct.toFixed(1)) + "% заявленного суточного объёма");
  }
  // Во сколько обойдётся выход всей позицией. Просадка в пуле и в стакане
  // растёт примерно линейно от объёма, поэтому берём отношение позиции
  // к глубине, которая держит один процент.
  if (lq && lq.sellCapacityUsd && t.valueUsd > 0) {
    const impact = (t.valueUsd / lq.sellCapacityUsd) * 1;
    facts.push(
      impact < 0.2
        ? "выход всей позицией — дешевле 0.2% просадки"
        : "выход всей позицией — около " + (impact < 10 ? impact.toFixed(1) : Math.round(impact)) + "% просадки"
    );
  }
  // Сколько дней среднего объёма занимает позиция: для крупной книги это
  // и есть настоящий срок выхода, а не мгновенная глубина.
  if (vol && t.valueUsd > 0) {
    const days = t.valueUsd / (vol * 0.1);
    if (days >= 0.05) {
      facts.push(
        "при 10% участия в объёме выходить " + (days < 1 ? "меньше дня" : days < 10 ? days.toFixed(1) + " дня" : Math.round(days) + " дней")
      );
    }
  }
  // Заявленный объём и измеренная глубина расходятся на порядки у токенов
  // с накрученной торговлей. Инвестору важно знать, что объём здесь ничего
  // не значит, потому что выйти по нему нельзя.
  if (vol && lq && lq.sellCapacityUsd && vol / lq.sellCapacityUsd > 200) {
    const times = Math.round(vol / lq.sellCapacityUsd);
    facts.push("заявленный объём " + money(vol) + " больше измеренной глубины в " + times.toLocaleString("ru-RU") + " раз");
  }
  facts.push(t.best ? "доступна ставка " + t.best.apy.toFixed(1) + "% в год в " + t.best.project : "проверенного стейкинга нет");
  // Это ставка фондирования перпов, а не расход держателя спота: положительная
  // означает, что за лонги платят, то есть рынок перегрет в длинную сторону.
  if (t.funding != null) {
    const annual = Math.round(t.funding * 3 * 365 * 100);
    facts.push("фондирование перпов " + (annual > 0 ? "+" : "") + annual + "% годовых — платят " + (annual > 0 ? "лонги" : "шорты"));
  }

  return (
    '<article class="risk-card"><header><span class="risk-rank mono">' + String(rank).padStart(2, "0") + "</span>" +
    (t.market && t.market.image ? '<img src="' + esc(t.market.image) + '" alt="" width="34" height="34" style="border-radius:50%"/>' : "") +
    '<div style="flex:1;min-width:180px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
    "<h3>" + esc(t.symbol) + "</h3><span style=\"color:#9aa1af;font-size:11px\">" + esc((t.meta && t.meta.name) || "") + "</span>" +
    '<span class="pill pill-' + v.tone + '">' + v.label + "</span></div>" +
    '<div class="risk-meta"><span style="width:150px">' + riskMeter(t.score) + "</span>" +
    '<span class="mono" style="color:var(--ink);font-weight:700">' + money(t.valueUsd) + "</span>" +
    "<span>7д " + delta(t.market && t.market.change7d) + "</span><span>30д " + delta(t.market && t.market.change30d) + "</span></div></div>" +
    '<button class="ghost-button" data-token="' + esc(t.symbol) + '">Подробно</button></header>' +
    '<div class="reason-grid-wrap"><div class="risk-verdict"><div><span class="label">Оценка позиции</span><h3>' + esc(verdictHeadline(t, hasUpside)) + "</h3></div>" +
    '<div style="display:flex;align-items:flex-start;gap:14px">' + riskScale(t.score) + "</div></div>" +
    prosConsBlock(t, true) + "</div>" +
    '<div class="plan-strip"><span class="pill pill-gray">ФАКТЫ</span><span>' + esc(facts.join(" · ")) + "</span></div></article>"
  );
}

// ————— страница «Агент» —————

async function agentPage() {
  let html = pageHeader({
    eyebrow: "АВТОМАТИЗАЦИЯ",
    title: "Агент",
    sub: "Разбирает портфель по расписанию и пишет в Telegram, только когда есть что сказать",
    actions:
      '<button class="ghost-button" data-act="tg-test">Тест сообщения</button>' +
      '<button class="primary-button" data-act="run">Запустить разбор</button>',
  });
  html += '<div id="agent-body"><div class="loading"><i></i>Загружаю настройки…</div></div>';
  return html;
}

async function renderAgentBody() {
  const target = $("#agent-body");
  if (!target) return;
  // историю и состояние источников страница больше не показывает,
  // поэтому и не запрашивает: история живёт на своей странице
  const [s, job] = await Promise.all([api("/api/settings"), api("/api/agent/job")]);
  state.settings = s;
  state.job = job.job;

  let html = "";
  const j = job.job;
  if (j && j.status === "running")
    html +=
      '<div class="job-banner"><span class="job-spinner"></span><div><strong>Разбор идёт: ' + esc(j.step) + "</strong>" +
      "<small>" + (j.aiTotal ? "ИИ-анализ токенов: " + j.aiDone + " из " + j.aiTotal + " · каждый занимает 3–6 минут" : "считаю цены, ликвидность и новости") + "</small></div>" +
      (j.aiTotal ? '<div class="job-progress"><span style="width:' + Math.round((j.aiDone / j.aiTotal) * 100) + '%"></span></div>' : "") + "</div>";
  if (j && j.status === "error") html += '<div class="error-banner">Разбор упал: ' + esc(j.error || "") + "</div>";

  // канал доставки
  html +=
    '<div class="alert-grid" style="align-items:start"><div class="card"><div class="card-head"><div><h2>Канал доставки</h2><p>Куда агент присылает сводку</p></div>' +
    '<span class="pill ' + (s.hasBotToken && s.chatId ? "pill-green" : "pill-amber") + '">' + (s.hasBotToken && s.chatId ? "Подключено" : "Не настроено") + "</span></div>" +
    '<div class="card-body"><label class="field">BOT TOKEN — @BotFather → /newbot<input id="tg-token" placeholder="' + esc(s.botTokenMask || "123456:AA…") + '"/></label>' +
    '<label class="field">CHAT ID ИЛИ @КАНАЛ<input id="tg-chat" value="' + esc(s.chatId || "") + '" placeholder="@my_portfolio"/></label>' +
    '<button class="ghost-button" style="width:100%;margin-bottom:12px" data-act="tg-detect">Проверить бота и найти чат</button>' +
    '<div id="tg-chats"></div>' +
    '<label class="checkbox"><input type="checkbox" id="tg-always"' + (s.sendEmptyDigest ? " checked" : "") + '/><span>Присылать сводку всегда<small>По умолчанию агент молчит, если важных изменений нет.</small></span></label>' +
    '<div style="margin-top:18px"><button class="primary-button" data-act="tg-save">Сохранить</button></div><div id="tg-note"></div></div></div>';

  // расписание
  const sch = s.schedule;
  const nx = s.next;
  html +=
    '<div class="card"><div class="card-head"><div><h2>Расписание</h2><p>' +
    (sch.enabled ? (!sch.times.length ? "Только вручную — кнопкой «Запустить разбор»" : nx ? "Следующий разбор " + (nx.today ? "сегодня" : "завтра") + " в " + nx.at + " — через " + (nx.inMinutes < 60 ? nx.inMinutes + " мин" : Math.floor(nx.inMinutes / 60) + " ч " + (nx.inMinutes % 60) + " мин") : "Время не выбрано") : "Агент выключен") +
    '</p></div><label class="switch"><input type="checkbox" id="sch-enabled"' + (sch.enabled ? " checked" : "") + '/><span></span></label></div>' +
    '<div class="card-body"><span class="label">Время запуска · ' + esc(sch.timezone) + "</span>" +
    '<div class="time-list" id="time-list">' +
    sch.times.map((t, i) => '<div class="time-chip"><input type="time" value="' + t + '" data-time-index="' + i + '"/>' + (sch.times.length > 1 ? '<button data-act="time-remove" data-index="' + i + '">✕</button>' : "") + "</div>").join("") +
    (sch.times.length < 8 ? '<button class="time-add" data-act="time-add">＋ Добавить время</button>' : "") + "</div>" +
    '<div class="preset-row"><span>Быстрый выбор:</span>' +
    [["", "Вручную"], ["09:00", "Раз в день"], ["09:00,21:00", "Два раза в день"], ["09:00,15:00,21:00", "Три раза"], ["00:00,06:00,12:00,18:00", "Каждые 6 часов"]]
      .map(([v, l]) => '<button data-act="preset" data-times="' + v + '" class="' + (sch.times.join(",") === v ? "active" : "") + '">' + l + "</button>")
      .join("") + "</div>" +
    '<label class="checkbox" style="margin-top:16px"><input type="checkbox" id="sch-catchup"' + (sch.catchUp ? " checked" : "") + '/><span>Догонять пропущенное<small>Если машина была выключена — разбор запустится сразу после старта.</small></span></label>' +
    '<div class="schedule-foot"><span>' + (s.lastScheduledRun ? "Последний запуск по расписанию: " + new Date(s.lastScheduledRun).toLocaleString("ru-RU") : "По расписанию ещё не запускался") + "</span></div>" +
    '<details class="external"><summary>Запускать внешним планировщиком</summary><pre class="code">curl -X POST "http://localhost:3500/api/agent/run?secret=$AGENT_SECRET"</pre></details></div></div></div>';

  // ИИ
  html +=
    '<div class="card" style="margin-bottom:20px"><div class="card-head"><div><h2>ИИ-разбор токенов</h2><p>Ассистент ASCN смотрит теханализ, ончейн, сантимент и ликвидации</p></div>' +
    '<div style="display:flex;align-items:center;gap:12px"><span class="pill ' + (s.ai.hasApiKey ? "pill-green" : "pill-amber") + '">' +
    (s.ai.hasApiKey ? (s.ai.fromEnv ? "ключ из .env.local" : "ключ задан") : "ключа нет") + "</span>" +
    '<label class="switch"><input type="checkbox" id="ai-enabled"' + (s.ai.enabled ? " checked" : "") + '/><span></span></label></div></div>' +
    '<div class="card-body"><label class="field">API-КЛЮЧ ASCN — b2b.ascn.ai → API keys<input id="ai-key" placeholder="' + esc(s.ai.apiKeyMask || "28kR8f…") + '"/></label>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px"><button class="primary-button" data-act="ai-save">Сохранить ключ</button>' +
    '<button class="ghost-button" data-act="ai-check">Проверить ключ</button></div>' +
    '<span class="label">Как часто обновлять данные</span><div class="preset-row" style="margin:10px 0 18px">' +
    [15, 30, 60, 120].map((n) => '<button data-act="refresh" data-min="' + n + '" class="' + (s.refreshMinutes === n ? "active" : "") + '">' + (n < 60 ? n + " мин" : n / 60 + " ч") + "</button>").join("") +
    "<span>цены, ликвидность и новости перезапрашиваются с этим интервалом</span></div>" +
    '<span class="label">Сколько токенов разбирать за прогон</span><div class="preset-row" style="margin-top:10px">' +
    [1, 2, 3, 5].map((n) => '<button data-act="ai-count" data-count="' + n + '" class="' + (s.ai.maxTokensPerRun === n ? "active" : "") + '">' + n + "</button>").join("") +
    "<span>берутся те, где что-то изменилось</span></div>" +
    '<span class="label" style="display:block;margin-top:18px">Что просить у ассистента</span><div class="preset-row" style="margin:10px 0 0">' +
    [["summary", "Только итог"], ["full", "Полный разбор"], ["custom", "Свой промпт"]]
      .map(([v, l]) => '<button data-act="ai-template" data-template="' + v + '" class="' + (s.ai.template === v ? "active" : "") + '">' + l + "</button>")
      .join("") +
    "<span>" + (s.ai.template === "summary" ? "2–4 предложения плюс по два факта за и против" : s.ai.template === "full" ? "теханализ, ончейн, сантимент, ликвидации и итог" : "текст задаёте сами") + "</span></div>" +
    (s.ai.template === "custom"
      ? '<label class="field" style="margin-top:14px">СВОЙ ПРОМПТ<textarea id="ai-prompt" rows="4" style="padding:10px 11px;border:1px solid var(--line);border-radius:9px;resize:vertical">' +
        esc(s.ai.customPrompt || "") + "</textarea></label>" +
        '<button class="primary-button" data-act="ai-prompt-save">Сохранить промпт</button>'
      : "") +
    '<span class="label" style="display:block;margin-top:18px">Смотреть X (Twitter)</span><div class="preset-row" style="margin:10px 0 0">' +
    [["off", "Не смотреть"], ["notable", "Где есть движение"], ["all", "По всем токенам"]]
      .map(([v, l]) => '<button data-act="ai-social" data-social="' + v + '" class="' + (s.ai.social === v ? "active" : "") + '">' + l + "</button>")
      .join("") +
    "<span>" + (s.x && s.x.hasToken ? "посты берутся официальным X API" : "без ключа X смотрит сам ассистент") + "</span></div>" +
    '<label class="field" style="margin-top:14px">BEARER TOKEN — developer.x.com → проект → Keys and tokens' +
    '<input id="x-token" placeholder="' + esc((s.x && s.x.mask) || "AAAAAAAAAA…") + '"/></label>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
    '<button class="primary-button" data-act="x-save">Сохранить токен</button>' +
    '<button class="ghost-button" data-act="x-check">Проверить</button>' +
    '<span class="pill ' + (s.x && s.x.hasToken ? "pill-green" : "pill-gray") + '">' +
    (s.x && s.x.hasToken ? (s.x.fromEnv ? "ключ из .env.local" : "ключ задан") : "ключа нет") + "</span></div>" +
    '<p class="hint" style="margin-top:10px">Чтение постов у X платное: на бесплатном тарифе эндпоинт отдаёт 403. Без ключа всё работает как раньше — X смотрит ассистент.</p>' +
    '<div id="x-note"></div>' +
    '<p class="hint" style="margin-top:14px">Один токен — 3–6 минут ожидания, запросы уходят параллельно. Если важных изменений нет, ИИ не вызывается.</p>' +
    '<div id="ai-note"></div></div></div>';

  // источники
  target.innerHTML = html;
}

// ————— дровер токена —————

function when(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

let drawerTab = "ai";
let aiHistory = { symbol: null, rows: [], picked: 0, busy: false };
let aiFullOpen = false;

function aiTab(t) {
  const ai = t.ai || {};
  const rows = aiHistory.symbol === t.symbol ? aiHistory.rows : [];
  const picked = rows[aiHistory.picked] || null;
  const shown = picked || (ai.summary ? ai : null);

  const left = rows.length
    ? rows
        .map((r, i) => '<button class="hist-item' + (i === aiHistory.picked ? " active" : "") +
          '" data-act="ai-pick" data-i="' + i + '"><b>' + when(r.at) + "</b><span>" +
          esc((r.summary || "").slice(0, 60)) + "…</span></button>")
        .join("")
    : '<p class="hint">Разборов пока нет</p>';

  const right = shown
    ? '<p class="ai-summary">' + esc(shown.summary || "") + "</p>" +
      (shown.pros && shown.pros.length
        ? '<div class="ai-side"><span class="eyebrow" style="color:var(--green)">ЗА</span>' +
          shown.pros.map((x) => "<p>" + esc(x) + "</p>").join("") + "</div>"
        : "") +
      (shown.cons && shown.cons.length
        ? '<div class="ai-side"><span class="eyebrow" style="color:var(--red)">ПРОТИВ</span>' +
          shown.cons.map((x) => "<p>" + esc(x) + "</p>").join("") + "</div>"
        : "") +
      '<p class="hint">' + (shown.at ? "разбор от " + when(shown.at) : "") +
      (shown.seconds ? " · ассистент отвечал " + Math.round(shown.seconds) + " с" : "") + "</p>" +
      ((shown.content || (!picked && ai.content))
        ? '<details class="ai-full"' + (aiFullOpen ? " open" : "") + '><summary data-act="ai-full">Полный ответ ассистента</summary>' +
          '<pre class="ai-raw">' + esc(shown.content || ai.content) + "</pre></details>"
        : picked
        ? '<p class="hint">Полный текст хранится только для последнего разбора — в истории остаётся итог с фактами.</p>'
        : "")
    : '<p class="hint">Итог по токену даёт ассистент ASCN. Нажмите «Обновить анализ» — ответ идёт 3–6 минут.</p>';

  return (
    '<div class="ai-head"><button class="primary" data-act="ai-run" data-symbol="' + esc(t.symbol) + '"' +
    (aiHistory.busy ? " disabled" : "") + ">" + (aiHistory.busy ? "Разбираю…" : "Обновить анализ") + "</button>" +
    '<span class="hint">' + (aiHistory.busy ? "ассистент отвечает 3–6 минут, можно закрыть окно" : "по этому токену, вне расписания") + "</span></div>" +
    '<div class="ai-grid"><div class="ai-hist">' + left + '</div><div class="ai-main">' + right + "</div></div>"
  );
}

function openDrawer(symbol) {
  const t = (state.analysis && state.analysis.tokens.find((x) => x.symbol === symbol)) || null;
  if (!t) return;
  drawerTab = "ai";
  if (aiHistory.symbol !== symbol) aiHistory = { symbol: symbol, rows: [], picked: 0, busy: false };
  renderDrawer(t);
  loadAiHistory(symbol);
}

async function loadAiHistory(symbol) {
  const res = await api("/api/token/history?symbol=" + encodeURIComponent(symbol));
  if (!res || aiHistory.symbol !== symbol) return;
  aiHistory.rows = res.history || [];
  const t = state.analysis && state.analysis.tokens.find((x) => x.symbol === symbol);
  if (t && $(".drawer")) renderDrawer(t);
}

async function runTokenAnalysis(symbol) {
  aiHistory.busy = true;
  const t = state.analysis && state.analysis.tokens.find((x) => x.symbol === symbol);
  if (t) renderDrawer(t);
  const res = await api("/api/token/analyze", { method: "POST", body: JSON.stringify({ symbol: symbol }) });
  aiHistory.busy = false;
  if (res && res.ok) {
    aiHistory.rows = res.history || [];
    aiHistory.picked = 0;
    if (t) t.ai = res.insight;          // карточки подхватят итог без полного пересчёта
  } else if (res && res.error) {
    alert("Разбор не получился: " + res.error);
  }
  if (t) renderDrawer(t);
  render();
}

function renderDrawer(t) {
  const v = VERDICT[t.verdict];
  const m = t.market || {};
  const tabs = [
    ["ai", "Итог ASCN"],
    ["earn", "Заработать · " + t.opportunities.length],
    ["why", "Разбор"],
    ["profile", "Профиль"],
    ["news", "Новости · " + t.news.length],
    ["exit", "Выход и хедж"],
  ];
  const body = { ai: aiTab, earn: earnTab, why: whyTab, profile: profileTab, news: newsTab, exit: exitTab }[drawerTab](t);

  $("#drawer-root").innerHTML =
    '<div class="overlay" data-act="drawer-close"><aside class="drawer" data-stop="1"><div class="drawer-head">' +
    '<div style="display:flex;align-items:flex-start;gap:14px">' +
    (m.image ? '<img src="' + esc(m.image) + '" alt="" width="40" height="40" style="border-radius:50%;margin-top:2px"/>' : "") +
    '<div style="flex:1;min-width:0"><h2>' + esc(t.symbol) + ' <span style="color:#9aa1af;font-size:13px;font-weight:400">' + esc((t.meta && t.meta.name) || m.name || "") + "</span>" +
    ((t.meta && t.meta.rank) || m.rank ? ' <span class="pill pill-gray">#' + ((t.meta && t.meta.rank) || m.rank) + "</span>" : "") + "</h2>" +
    '<div class="price-row"><strong class="mono" style="font-size:15px;color:var(--ink)">' + (m.price ? moneySmart(m.price) : "—") + "</strong>" +
    "<span>24ч " + delta(m.change24h) + "</span><span>7д " + delta(m.change7d) + "</span><span>30д " + delta(m.change30d) + "</span></div></div>" +
    '<button class="icon-button" data-act="drawer-close">✕</button></div>' +
    '<div class="drawer-stats"><div><span>В портфеле</span><strong class="mono">' + money(t.valueUsd) + "</strong><small>" + amount(t.amount) + " " + esc(t.symbol) + "</small></div>" +
    '<div><span>Состояние</span><strong style="margin-top:6px"><span class="pill pill-' + v.tone + '">' + v.label + "</span></strong></div>" +
    "<div><span>Риск позиции</span><strong style=\"margin-top:9px\">" + riskMeter(t.score) + "</strong><small>сложен из 8 факторов</small></div></div></div>" +
    '<div class="tabs">' + tabs.map(([id, label]) => '<button data-act="drawer-tab" data-tab="' + id + '" class="' + (drawerTab === id ? "active" : "") + '">' + label + "</button>").join("") + "</div>" +
    '<div class="drawer-body">' + body + "</div></aside></div>";
}

function oppCard(o) {
  return (
    '<div class="opp"><div class="opp-main"><div><strong>' + esc(o.project) + '</strong> <span class="pill pill-gray">' + (KIND[o.kind] || o.kind) + "</span> " +
    '<span style="color:#9aa1af;font-size:10px">' + esc(o.chain) + "</span>" +
    '<small class="mono">' + esc(o.pair) + " · в пуле $" + short(o.tvlUsd) + (o.apyReward ? " · сам доход " + (o.apyBase || 0).toFixed(1) + "% + наградные " + o.apyReward.toFixed(1) + "%" : "") + "</small></div>" +
    '<div class="opp-apy"><b class="mono">' + o.apy.toFixed(1) + "%</b><span>в год</span></div>" +
    '<div style="flex:0 0 84px;text-align:right">' + riskDots(o.risk) + (o.yearlyUsd ? '<div class="mono" style="margin-top:5px;font-size:10px;color:#9aa1af">+' + money(o.yearlyUsd) + "/год</div>" : "") + "</div></div>" +
    '<div class="opp-foot">' + (o.apyMean30d != null ? '<span class="mono">в среднем за 30 дней: ' + o.apyMean30d.toFixed(1) + "%</span>" : "") +
    '<a href="' + esc(o.url) + '" target="_blank" rel="noreferrer" class="link-button" style="margin-left:auto">Открыть пул →</a></div>' +
    (o.riskNotes.length ? '<div class="opp-notes">' + o.riskNotes.map((n) => "• " + esc(n)).join("<br/>") + "</div>" : "") + "</div>"
  );
}

function earnTab(t) {
  if (!t.opportunities.length)
    return '<p class="hint">По ' + esc(t.symbol) + " нет пулов с деньгами больше $100K — ни стейкинга, ни лендинга. Такой токен либо растёт в цене, либо просто лежит.</p>";
  const single = t.opportunities.filter((o) => o.kind !== "lp");
  const pools = t.opportunities.filter((o) => o.kind === "lp");
  let html =
    '<div class="section-title"><h3>Где заработать на ' + esc(t.symbol) + "</h3><span>" +
    (t.best ? money(t.potentialYearlyUsd) + " в год с вашей позиции" : "проверенных вариантов нет") + "</span></div>" +
    '<p class="hint" style="margin-bottom:16px">Сортируем не по самой большой ставке, а по той, которая держится: текущую доходность подрезаем средней за 30 дней и учитываем размер пула, долю наградных токенов и надёжность протокола.</p>';
  if (single.length)
    html += '<div class="section-title"><h3>Стейкинг и лендинг</h3><span>один токен, ничего докупать не нужно</span></div>' + single.map(oppCard).join("");
  if (pools.length)
    html += '<div class="section-title" style="margin-top:24px"><h3>Пулы на два токена</h3><span>доход выше, но цены могут разъехаться</span></div>' + pools.map(oppCard).join("");
  return html;
}

function whyTab(t) {
  const hasUpside = t.reasons.some((r) => r.kind === "good") || ((t.ai || {}).pros || []).length > 0;
  let html =
    '<div class="risk-verdict"><div><span class="label">Оценка позиции</span><h3>' + esc(verdictHeadline(t, hasUpside)) + "</h3></div>" +
    '<div style="display:flex;align-items:flex-start;gap:14px">' + riskScale(t.score) + "</div></div>" +
    prosConsBlock(t);
  if (t.ai) html += '<p class="hint" style="margin:12px 0 16px;font-size:10.5px">Первые пункты — из разбора ассистента ASCN от ' + new Date(t.ai.at).toLocaleString("ru-RU") + ", остальные из моей модели.</p>";
  if ((t.indicatorsRead || []).length)
    html +=
      '<div class="section-title" style="margin-top:18px"><h3>Индикаторы</h3><span>дневные свечи ' + esc((t.indicators || {}).source || "") + "</span></div>" +
      '<div class="ind-grid">' + t.indicatorsRead.map((i) => '<div class="ind-item ' + i.tone + '">' + esc(i.text) + "</div>").join("") + "</div>";
  const m = t.market;
  if (m)
    html +=
      '<div class="drawer-stats">' +
      '<div><span>Капитализация</span><strong class="mono">$' + short(m.marketCap) + "</strong><small>" + (m.rank ? "#" + m.rank + " по рынку" : "") + "</small></div>" +
      '<div><span>Наторговали за сутки</span><strong class="mono">$' + short(m.volume24h) + "</strong></div>" +
      '<div><span>Ниже максимума</span><strong class="mono">' + pct(m.athChangePct, 0) + "</strong></div>" +
      '<div><span>Выпущено в рынок</span><strong class="mono">' + (m.circulatingSupply && m.totalSupply ? Math.round((m.circulatingSupply / m.totalSupply) * 100) + "%" : "—") + "</strong></div>" +
      '<div><span>Новостной фон</span><strong class="mono">' + t.newsTone.toFixed(1) + "</strong><small>от −3 до +3</small></div>" +
      '<div><span>Плата за плечо</span><strong class="mono">' + (t.funding == null ? "фьючерса нет" : Math.round(t.funding * 3 * 365 * 100) + "% в год") + "</strong></div></div>";
  return html;
}

function profileTab(t) {
  const meta = t.meta;
  if (!meta) return '<p class="hint">CoinGecko не отдал профиль по этому токену.</p>';
  let html =
    '<div class="meta-grid">' +
    '<div class="meta-item"><span>Место по капитализации</span><strong class="mono">' + (meta.rank ? "#" + meta.rank : "вне рейтинга") + "</strong></div>" +
    '<div class="meta-item"><span>В вотчлистах CoinGecko</span><strong class="mono">' + (meta.watchlistUsers ? Number(meta.watchlistUsers).toLocaleString("ru-RU") : "—") + "</strong></div>" +
    '<div class="meta-item"><span>Категории</span><strong style="font-size:12px">' + esc(meta.categories.join(" · ") || "не указаны") + "</strong></div>" +
    '<div class="meta-item"><span>Запуск сети</span><strong class="mono">' + (meta.genesisDate || (meta.chains.length ? "токен, не сеть" : "—")) + "</strong></div></div>";
  if (meta.description) html += '<p class="desc">' + esc(meta.description) + "</p>";
  html += '<div class="meta-links">';
  [["CoinGecko", meta.cgUrl], ["Сайт проекта", meta.homepage], ["X / Twitter", meta.twitter], ["Эксплорер", meta.explorer], ["GitHub", meta.github]].forEach(([label, url]) => {
    if (url) html += '<a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + label + " →</a>";
  });
  html += "</div>";
  if (meta.chains.length) {
    html += '<div class="section-title"><h3>Контракты по сетям</h3><span>' + meta.chains.length + " сетей · проверяйте адрес</span></div>";
    html += meta.chains.map((c) => '<div class="contract"><b>' + esc(c.chain) + "</b><code>" + esc(c.address) + "</code></div>").join("");
  }
  return html;
}

function newsTab(t) {
  if (!t.news.length) {
    const ai = t.ai && t.ai.content;
    const section = ai && ai.match(/(?:\*\*)?3\)?\s*САНТИМЕНТ[\s\S]*?(?=(?:\*\*)?4\)|$)/i);
    return (
      '<p class="hint">В бесплатных новостных лентах свежих упоминаний ' + esc(t.symbol) + " нет — они пишут про топ-10." +
      (section ? " Ниже — новостной раздел из разбора ассистента." : " Запустите разбор ИИ на странице «Агент».") + "</p>" +
      (section ? '<pre class="run-summary" style="border-top:0;border-radius:12px;margin-top:14px">' + esc(section[0].replace(/\*\*/g, "").trim()) + "</pre>" : "")
    );
  }
  return t.news
    .map((n) => {
      const color = n.tone <= -2 ? ["#c33b42", "var(--red-soft)"] : n.tone < 0 ? ["#b9741a", "var(--amber-soft)"] : n.tone > 0 ? ["#1c8f5a", "var(--green-soft)"] : ["#6f7789", "var(--soft)"];
      return (
        '<a class="news-item" href="' + esc(n.url) + '" target="_blank" rel="noreferrer">' +
        '<span class="news-tone mono" style="color:' + color[0] + ";background:" + color[1] + '">' + (n.tone > 0 ? "+" : "") + n.tone + "</span>" +
        "<div style=\"min-width:0\"><strong>" + esc(n.title) + "</strong><small>" + esc(n.source) +
        (n.publishedAt ? " · " + new Date(n.publishedAt).toLocaleDateString("ru-RU") : " · дата неизвестна") +
        (n.ageDays != null && n.ageDays > 14 ? " · старая, в оценку не идёт" : "") +
        (n.tags.length ? " · " + esc(n.tags.join(", ")) : "") + "</small></div></a>"
      );
    })
    .join("");
}

function exitTab(t) {
  const L = t.liquidity;
  const level = t.risk ? t.risk.short : "";
  const bad = t.verdict === "sell" || t.verdict === "reduce";
  let html = '<p class="hint" style="margin-bottom:16px' + (bad ? ";color:#a83c42" : "") + '">' +
    (bad ? "Позиция " + money(t.valueUsd) + ", риск " + level + ". Ниже — как выйти, не уронив себе цену." : "Позиция в порядке, риск " + level + ". Инструменты ниже, если решение всё равно нужно.") + "</p>";

  if (L) {
    const cover = L.sellCapacityUsd && t.valueUsd ? L.sellCapacityUsd / t.valueUsd : null;
    html +=
      '<div class="depth-card"><div class="depth-head"><div><span class="label">Сколько можно продать сразу</span>' +
      '<strong class="mono" style="display:block;margin-top:6px">' + money(L.sellCapacityUsd) + "</strong></div>" +
      '<span class="pill ' + (cover == null ? "pill-gray" : cover < 1.5 ? "pill-red" : cover < 5 ? "pill-amber" : "pill-green") + '">' +
      (cover == null ? "нет данных" : cover < 1.5 ? "позиция больше рынка в " + (1 / cover).toFixed(1) + "×" : "позиция влезает " + (cover < 100 ? cover.toFixed(1) : Math.round(cover)) + "×") + "</span></div>";
    if (L.binance)
      html +=
        '<p class="hint" style="margin-bottom:10px;font-size:10.5px">' + esc(L.binance.venue) + ", пара " + esc(L.binance.pair) + ". Разница между покупкой и продажей " + L.binance.spreadPct.toFixed(3) + "%. Заявки на покупку в очереди:</p>" +
        '<div class="depth-ladder"><div><span>уронив цену на 0.5%</span><b class="mono">' + money(L.binance.usd05) + "</b></div>" +
        '<div><span>на 1%</span><b class="mono">' + money(L.binance.usd1) + "</b></div>" +
        '<div><span>на 2%</span><b class="mono">' + money(L.binance.usd2) + "</b></div></div>";
    if (L.dexPairs.length)
      html +=
        '<p class="hint" style="margin:14px 0 8px;font-size:10.5px">Пулы на DEX: ' + money(L.dexTotalUsd) + " в " + L.dexPairs.length + " парах</p>" +
        L.dexPairs.map((p) => '<a class="venue-row" href="' + esc(p.url) + '" target="_blank" rel="noreferrer"><b>' + esc(p.dex) + " · " + esc(p.chain) + '</b><span class="mono">' + esc(p.pair) + '</span><span class="mono" style="color:#8b93a4">в пуле ' + money(p.liquidityUsd) + "</span></a>").join("");
    html += "</div>";
  }

  html += '<div id="venues"></div>';
  html += t.exits.map((e) => '<a class="exit-item" href="' + esc(e.url) + '" target="_blank" rel="noreferrer"><strong>' + esc(e.label) + " →</strong><p>" + esc(e.hint) + "</p></a>").join("");
  html += '<p class="hint" style="margin-top:16px;font-size:10.5px">Все цифры — расчёт по публичным данным CoinGecko, DeFiLlama и биржевых стаканов. Это не инвестиционная рекомендация.</p>';

  if (t.meta && t.meta.coinId) loadVenues(t.meta.coinId);
  return html;
}

async function loadVenues(coinId) {
  const res = await api("/api/venues?coinId=" + encodeURIComponent(coinId));
  const box = $("#venues");
  if (!box || !res.venues || !res.venues.length) return;
  box.innerHTML =
    '<div class="section-title"><h3>Где продавать</h3><span>по обороту, со спредом</span></div><div class="venue-list">' +
    res.venues
      .map(
        (v) =>
          '<div class="venue-row"><b>' + esc(v.name) + '</b><span class="mono">' + esc(v.pair) + '</span><span class="mono" style="color:#8b93a4">' + money(v.volumeUsd) + " за сутки</span>" +
          '<span class="spread mono" style="color:' + (v.spreadPct == null ? "#8b93a4" : v.spreadPct < 0.2 ? "var(--green)" : v.spreadPct < 1 ? "var(--amber)" : "var(--red)") + '">' +
          (v.spreadPct == null ? "—" : v.spreadPct.toFixed(2) + "%") + "</span></div>"
      )
      .join("") + "</div>";
}

// ————— редактор портфеля —————

const editor = { rows: [], prices: {}, search: null };

async function openEditor() {
  const p = await api("/api/portfolio");
  const known = (state.analysis && state.analysis.tokens) || [];
  editor.rows = (p.holdings || []).map((h) => {
    const hit = known.find((k) => k.symbol === h.symbol) || {};
    return {
      symbol: h.symbol,
      coinId: h.coinId || (hit.meta && hit.meta.coinId) || (hit.market && hit.market.coinId),
      name: (hit.meta && hit.meta.name) || (hit.market && hit.market.name),
      image: hit.market && hit.market.image,
      rank: (hit.meta && hit.meta.rank) || (hit.market && hit.market.rank),
      amount: String(h.amount),
      unit: "token",
    };
  });
  known.forEach((k) => {
    if (k.market && k.market.coinId) editor.prices[k.market.coinId] = k.market.price;
  });
  editor.search = null;
  renderEditor();
}

function priceOfRow(row) {
  return row.coinId && editor.prices[row.coinId] ? editor.prices[row.coinId] : null;
}

function renderEditor() {
  const rows = editor.rows
    .map((r, i) => {
      const price = priceOfRow(r);
      const entered = parseFloat(String(r.amount).replace(",", "."));
      const valid = !isNaN(entered) && entered > 0;
      const tokenAmount = r.unit === "usd" ? (price && valid ? entered / price : null) : valid ? entered : null;
      const usd = price && tokenAmount != null ? tokenAmount * price : null;
      const chip =
        editor.search === i
          ? '<div class="token-search"><input id="token-search-input" placeholder="Тикер или название: ETH, Solana…" autocomplete="off"/><div class="token-dropdown" id="token-dropdown" style="display:none"></div></div>'
          : '<button class="token-chip" data-act="pick" data-index="' + i + '">' +
            (r.image ? '<img src="' + esc(r.image) + '" alt=""/>' : '<span class="token-chip-blank">' + esc((r.symbol || "?").slice(0, 2)) + "</span>") +
            "<b>" + esc(r.symbol || "Выбрать") + "</b>" + (r.name ? '<span class="token-chip-name">' + esc(r.name) + "</span>" : "") +
            (r.rank ? "<small>#" + r.rank + "</small>" : "") + "</button>";
      return (
        '<div class="holding-grid">' + chip +
        '<div class="amount-field"><input value="' + esc(r.amount) + '" data-amount="' + i + '" inputmode="decimal" placeholder="' + (r.unit === "usd" ? "500" : "0") + '"/>' +
        '<button class="unit-toggle" data-act="unit" data-index="' + i + '" title="Количество токенов или сумма в долларах">' + (r.unit === "usd" ? "$" : esc(r.symbol || "шт")) + "</button>" +
        (r.unit === "usd"
          ? tokenAmount != null
            ? '<span class="amount-under mono">≈ ' + amount(Number(tokenAmount.toFixed(6))) + " " + esc(r.symbol) + "</span>"
            : valid ? '<span class="amount-under mono">курс не загрузился</span>' : ""
          : usd != null ? '<span class="amount-under mono">≈ ' + moneySmart(usd) + "</span>" : "") +
        "</div>" +
        '<button class="row-delete" data-act="row-remove" data-index="' + i + '">🗑</button></div>'
      );
    })
    .join("");

  $("#modal-root").innerHTML =
    '<div class="modal-overlay" data-act="modal-close"><div class="modal" data-stop="1"><div class="modal-head"><div><h2>Мои токены</h2>' +
    "<p>Найдите токен по тикеру или названию и укажите количество — в токенах или сразу в долларах</p></div>" +
    '<button class="icon-button" data-act="modal-close">✕</button></div>' +
    '<div class="modal-body"><div class="holding-head"><span>Токен</span><span>Количество</span><span></span></div>' + rows +
    '<button class="ghost-button" style="width:100%;margin-top:6px" data-act="row-add">＋ Добавить токен</button><div id="editor-note"></div></div>' +
    '<div class="modal-foot"><span style="color:#9aa1af;font-size:11px">Позиций: ' + editor.rows.filter((r) => r.symbol).length + "</span>" +
    '<div style="display:flex;gap:8px"><button class="ghost-button" data-act="modal-close">Отмена</button>' +
    '<button class="primary-button" data-act="save-portfolio">Сохранить и пересчитать</button></div></div></div></div>';

  if (editor.search != null) {
    const input = $("#token-search-input");
    if (input) {
      input.focus();
      let timer = null;
      input.oninput = () => {
        clearTimeout(timer);
        const q = input.value.trim();
        const box = $("#token-dropdown");
        if (q.length < 2) {
          box.style.display = "none";
          return;
        }
        box.style.display = "block";
        box.innerHTML = '<div class="token-empty">Ищу…</div>';
        timer = setTimeout(async () => {
          const res = await api("/api/resolve?q=" + encodeURIComponent(q));
          const items = res.candidates || [];
          box.innerHTML = items.length
            ? items
                .map(
                  (c) =>
                    '<button class="token-option" data-act="choose" data-coin="' + esc(c.coinId) + '" data-symbol="' + esc(c.symbol) + '" data-name="' + esc(c.name) + '" data-image="' + esc(c.image || "") + '" data-rank="' + (c.rank || "") + '">' +
                    (c.image ? '<img src="' + esc(c.image) + '" alt=""/>' : '<span class="token-chip-blank">' + esc(c.symbol.slice(0, 2)) + "</span>") +
                    "<b>" + esc(c.symbol) + '</b><span class="token-option-name">' + esc(c.name) + "</span><small>" + (c.rank ? "#" + c.rank : "вне рейтинга") + "</small></button>"
                )
                .join("")
            : '<div class="token-empty">Ничего не нашлось</div>';
        }, 300);
      };
    }
  }
}

// ————— роутер и события —————

function currentRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  return ["/risks", "/agent", "/history"].indexOf(hash) >= 0 ? hash : "/";
}

// ————— История: запуски агента и разборы ассистента, с фильтром по токену —————

let histFilter = "";

async function historyPage() {
  const [runsRes, anRes] = await Promise.all([api("/api/agent/history"), api("/api/analyses")]);
  const runs = (runsRes && runsRes.runs) || [];
  const analyses = (anRes && anRes.analyses) || {};

  // список токенов: и те, что в портфеле, и те, что встречались в прошлых запусках
  const seen = {};
  ((state.analysis && state.analysis.tokens) || []).forEach((t) => (seen[t.symbol] = true));
  Object.keys(analyses).forEach((sym) => (seen[sym] = true));
  runs.forEach((r) => {
    (r.ai || []).forEach((a) => (seen[a.symbol] = true));
    (r.alerts || []).forEach((a) => a.symbol && (seen[a.symbol] = true));
  });
  const symbols = Object.keys(seen).sort();

  const touches = (r, sym) =>
    !sym ||
    (r.ai || []).some((a) => a.symbol === sym) ||
    (r.alerts || []).some((a) => a.symbol === sym);

  const shown = runs.filter((r) => touches(r, histFilter));
  const count = (sym) => runs.filter((r) => touches(r, sym)).length;

  const side =
    '<div class="hist-side"><button class="hist-chip' + (histFilter ? "" : " active") + '" data-act="hist-filter" data-symbol="">' +
    "Все токены<span>" + runs.length + "</span></button>" +
    symbols
      .map(
        (sym) =>
          '<button class="hist-chip' + (histFilter === sym ? " active" : "") + '" data-act="hist-filter" data-symbol="' + esc(sym) + '">' +
          esc(sym) + "<span>" + count(sym) + "</span></button>"
      )
      .join("") + "</div>";

  const rows = shown.length
    ? shown
        .map((r) => {
          const ai = (r.ai || []).filter((a) => !histFilter || a.symbol === histFilter);
          const alerts = (r.alerts || []).filter((a) => !histFilter || a.symbol === histFilter);
          const saved = histFilter ? (analyses[histFilter] || []).find((x) => (x.at || "").slice(0, 16) === (r.at || "").slice(0, 16)) : null;
          return (
            '<article class="hist-row"><header><b>' + when(r.at) + "</b>" +
            '<span class="pill pill-gray">' + (r.trigger === "cron" ? "по расписанию" : "вручную") + "</span>" +
            '<span class="mono">' + money(r.totalValueUsd) + "</span>" +
            '<span class="pill ' + (r.telegram && r.telegram.sent ? "pill-green" : "pill-gray") + '">' +
            (r.telegram && r.telegram.sent ? "отправлено" : "не отправлено") + "</span></header>" +
            (saved && saved.summary ? '<p class="hist-summary">' + esc(saved.summary) + "</p>" : "") +
            (alerts.length
              ? '<div class="hist-alerts">' +
                alerts.map((a) => '<p class="' + (a.level === "critical" ? "c" : "") + '"><b>' + esc(a.title) + "</b></p>").join("") +
                "</div>"
              : "") +
            (ai.length
              ? '<p class="hint">разбор ассистента: ' +
                ai.map((a) => esc(a.symbol) + (a.error ? " — не ответил" : a.seconds ? " (" + Math.round(a.seconds) + " с)" : "")).join(", ") +
                "</p>"
              : "") +
            "</article>"
          );
        })
        .join("")
    : '<p class="hint">По этому токену запусков пока не было.</p>';

  const saved = histFilter ? analyses[histFilter] || [] : [];
  const savedBlock = saved.length
    ? '<h2 class="section-heading">Итоги ASCN по ' + esc(histFilter) + " · " + saved.length + "</h2>" +
      '<div class="card"><div class="card-body">' +
      saved
        .map(
          (x) =>
            '<div class="hist-insight"><b>' + when(x.at) + "</b><p>" + esc(x.summary || "—") + "</p>" +
            ((x.pros || []).concat(x.cons || []).length
              ? '<div class="card-proscons">' +
                (x.pros || []).slice(0, 2).map((v) => '<p class="p"><i></i>' + esc(v) + "</p>").join("") +
                (x.cons || []).slice(0, 2).map((v) => '<p class="c"><i></i>' + esc(v) + "</p>").join("") +
                "</div>"
              : "") + "</div>"
        )
        .join("") + "</div></div>"
    : "";

  return (
    '<div class="page-head"><div><span class="eyebrow">АРХИВ</span><h1>История</h1>' +
    "<p>" + (histFilter ? "Запуски, где участвовал " + esc(histFilter) : "Все запуски агента: что нашлось и что ушло в Telegram") + "</p></div></div>" +
    '<div class="hist-layout">' + side + '<div class="hist-main">' + rows + savedBlock + "</div></div>"
  );
}

async function render() {
  const route = currentRoute();
  document.querySelectorAll(".main-nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === route));
  $("#crumb").textContent =
    { "/risks": "Рейтинг риска", "/agent": "Агент", "/history": "История" }[route] || "Портфель";

  if (route === "/agent") {
    view().innerHTML = await agentPage();
    renderAgentBody();
    return;
  }
  if (route === "/history") {
    view().innerHTML = await historyPage();
    return;
  }
  view().innerHTML = route === "/risks" ? risksPage() : portfolioPage();
  if (!state.analysis && !state.loading) loadAnalysis(false);
}

document.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-act], [data-token]");
  if (!target) return;
  const act = target.dataset.act;

  // клик по фону закрывает панель
  if ((act === "drawer-close" || act === "modal-close") && (e.target === target || target.tagName === "BUTTON")) {
    if (act === "drawer-close") $("#drawer-root").innerHTML = "";
    else $("#modal-root").innerHTML = "";
    return;
  }
  if (e.target.closest("[data-stop]") && !act) return;

  if (!act && target.dataset.token) {
    openDrawer(target.dataset.token);
    return;
  }

  switch (act) {
    case "view-cards":
    case "view-table":
      state.view = act === "view-cards" ? "cards" : "table";
      localStorage.setItem("signal-view", state.view);
      render();
      break;
    case "reload":
      loadAnalysis(true, true);
      break;
    case "edit":
      openEditor();
      break;
    case "demo":
      await api("/api/portfolio/demo", { method: "POST" });
      state.analysis = null;
      loadAnalysis(true, true);
      break;
    case "drawer-tab": {
      drawerTab = target.dataset.tab;
      const symbol = $(".drawer h2").textContent.trim().split(" ")[0];
      const t = state.analysis.tokens.find((x) => x.symbol === symbol);
      if (t) renderDrawer(t);
      break;
    }
    case "hist-filter":
      histFilter = target.dataset.symbol || "";
      render();
      break;
    case "ai-full": {
      const box = target.closest("details");
      aiFullOpen = box ? !box.open : true;
      return;
    }
    case "ai-run-all":
      runAllAnalysis();
      break;
    case "ai-run":
      runTokenAnalysis(target.dataset.symbol);
      break;
    case "ai-pick": {
      aiHistory.picked = Number(target.dataset.i);
      const sym = aiHistory.symbol;
      const tok = state.analysis.tokens.find((x) => x.symbol === sym);
      if (tok) renderDrawer(tok);
      break;
    }
    case "pick":
      editor.search = Number(target.dataset.index);
      renderEditor();
      break;
    case "choose": {
      const row = editor.rows[editor.search];
      row.symbol = target.dataset.symbol;
      row.coinId = target.dataset.coin;
      row.name = target.dataset.name;
      row.image = target.dataset.image;
      row.rank = target.dataset.rank || null;
      editor.search = null;
      renderEditor();
      if (row.coinId && !editor.prices[row.coinId]) {
        const res = await api("/api/price?ids=" + encodeURIComponent(row.coinId));
        Object.assign(editor.prices, res.prices || {});
        renderEditor();
      }
      break;
    }
    case "unit": {
      const row = editor.rows[Number(target.dataset.index)];
      row.unit = row.unit === "usd" ? "token" : "usd";
      renderEditor();
      break;
    }
    case "row-add":
      editor.rows.push({ symbol: "", amount: "", unit: "token" });
      editor.search = editor.rows.length - 1;
      renderEditor();
      break;
    case "row-remove":
      editor.rows.splice(Number(target.dataset.index), 1);
      renderEditor();
      break;
    case "save-portfolio": {
      const holdings = editor.rows
        .filter((r) => r.symbol)
        .map((r) => {
          const entered = parseFloat(String(r.amount).replace(",", "."));
          const price = priceOfRow(r);
          const value = r.unit === "usd" && price ? entered / price : entered;
          return { symbol: r.symbol.toUpperCase(), amount: value, coinId: r.coinId };
        })
        .filter((h) => !isNaN(h.amount) && h.amount > 0);
      await api("/api/portfolio", { method: "POST", body: JSON.stringify({ holdings }) });
      $("#modal-root").innerHTML = "";
      state.analysis = null;
      loadAnalysis(true, true);
      break;
    }
    case "run": {
      const res = await api("/api/agent/run", { method: "POST" });
      state.job = res.job;
      renderAgentBody();
      break;
    }
    case "tg-test": {
      const res = await api("/api/telegram/test", { method: "POST" });
      note("tg-note", res.sent ? "Сообщение ушло в Telegram" : res.error, res.sent);
      break;
    }
    case "tg-detect": {
      const token = ($("#tg-token") || {}).value || "";
      const res = await api("/api/telegram/detect", { method: "POST", body: JSON.stringify(token ? { botToken: token } : {}) });
      if (res.error) return note("tg-note", res.error, false);
      const box = $("#tg-chats");
      box.innerHTML = res.chats.length
        ? '<div class="venue-list" style="margin-bottom:12px">' +
          res.chats.map((c) => '<button class="venue-row" style="width:100%" data-act="pick-chat" data-id="' + esc(c.id) + '"><b>' + esc(c.title) + "</b><span>" + esc(c.type) + '</span><small style="margin-left:auto">' + esc(c.id) + "</small></button>").join("") +
          "</div>"
        : "";
      note("tg-note", res.chats.length ? "Бот @" + res.bot.username + " на связи. Выберите чат." : "Бот @" + res.bot.username + " на связи, но ему ещё никто не писал — напишите ему /start.", res.chats.length > 0);
      break;
    }
    case "pick-chat":
      $("#tg-chat").value = target.dataset.id;
      note("tg-note", "Подставил chat id " + target.dataset.id + ". Нажмите «Сохранить».", true);
      break;
    case "tg-save": {
      const body = {
        chatId: ($("#tg-chat") || {}).value || "",
        sendEmptyDigest: !!($("#tg-always") || {}).checked,
      };
      const token = ($("#tg-token") || {}).value || "";
      if (token) body.botToken = token;
      await api("/api/settings", { method: "POST", body: JSON.stringify(body) });
      renderAgentBody();
      break;
    }
    case "ai-save": {
      const key = ($("#ai-key") || {}).value || "";
      if (!key) return;
      await api("/api/settings", { method: "POST", body: JSON.stringify({ ai: { apiKey: key } }) });
      renderAgentBody();
      break;
    }
    case "ai-check": {
      note("ai-note", "Спрашиваю ассистента…", true);
      const key = ($("#ai-key") || {}).value || "";
      const res = await api("/api/ascn/check", { method: "POST", body: JSON.stringify(key ? { apiKey: key } : {}) });
      note("ai-note", res.ok ? "Ключ работает: ассистент " + res.model + " ответил за " + res.seconds + " с" : "Ключ не подошёл: " + res.error, res.ok);
      break;
    }
    case "x-save":
    case "x-check": {
      const box = $("#x-token");
      const note = $("#x-note");
      if (note) note.innerHTML = '<p class="hint">Проверяю ключ…</p>';
      const res = await api("/api/x/check", {
        method: "POST",
        body: JSON.stringify({ bearerToken: box && box.value ? box.value : "" }),
      });
      if (note) {
        note.innerHTML = res && res.ok
          ? '<p class="hint" style="color:var(--green)">Ключ рабочий — ' + esc(res.note || "чтение доступно") + "</p>"
          : '<p class="hint" style="color:var(--red)">' + esc((res && res.error) || "не проверился") + "</p>";
      }
      state.settings = null;
      renderAgentBody();
      break;
    }
    case "ai-template":
      await api("/api/settings", { method: "POST", body: JSON.stringify({ ai: { template: target.dataset.template } }) });
      renderAgentBody();
      break;
    case "ai-social":
      await api("/api/settings", { method: "POST", body: JSON.stringify({ ai: { social: target.dataset.social } }) });
      renderAgentBody();
      break;
    case "ai-prompt-save": {
      const box = $("#ai-prompt");
      await api("/api/settings", { method: "POST", body: JSON.stringify({ ai: { customPrompt: box ? box.value : "" } }) });
      renderAgentBody();
      break;
    }
    case "ai-count":
      await api("/api/settings", { method: "POST", body: JSON.stringify({ ai: { maxTokensPerRun: Number(target.dataset.count) } }) });
      renderAgentBody();
      break;
    case "refresh":
      await api("/api/settings", { method: "POST", body: JSON.stringify({ refreshMinutes: Number(target.dataset.min) }) });
      renderAgentBody();
      break;
    case "preset":
      await saveSchedule({ times: target.dataset.times ? target.dataset.times.split(",") : [] });
      break;
    case "time-add":
      await saveSchedule({ times: state.settings.schedule.times.concat(["12:00"]) });
      break;
    case "time-remove":
      await saveSchedule({ times: state.settings.schedule.times.filter((_, i) => i !== Number(target.dataset.index)) });
      break;
    case "run-toggle": {
      const box = document.getElementById("run-" + target.dataset.id);
      if (box) box.style.display = box.style.display === "none" ? "block" : "none";
      break;
    }
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.id === "sch-enabled") await saveSchedule({ enabled: el.checked });
  else if (el.id === "sch-catchup") await saveSchedule({ catchUp: el.checked });
  else if (el.id === "ai-enabled") {
    await api("/api/settings", { method: "POST", body: JSON.stringify({ ai: { enabled: el.checked } }) });
    renderAgentBody();
  } else if (el.dataset && el.dataset.timeIndex != null) {
    const times = state.settings.schedule.times.slice();
    times[Number(el.dataset.timeIndex)] = el.value;
    await saveSchedule({ times });
  }
});

document.addEventListener("input", (e) => {
  if (e.target.dataset && e.target.dataset.amount != null) {
    editor.rows[Number(e.target.dataset.amount)].amount = e.target.value;
    const field = e.target.parentElement.querySelector(".amount-under");
    if (field) field.remove();
  }
});

async function saveSchedule(patch) {
  const merged = Object.assign({}, state.settings.schedule, patch);
  await api("/api/settings", { method: "POST", body: JSON.stringify({ schedule: merged }) });
  renderAgentBody();
}

function note(id, text, ok) {
  const box = document.getElementById(id);
  if (box) box.innerHTML = '<p class="form-note ' + (ok ? "ok" : "err") + '">' + esc(text) + "</p>";
}

// прогресс фоновой задачи
setInterval(async () => {
  if (currentRoute() !== "/agent") return;
  const res = await api("/api/agent/job");
  const was = state.job && state.job.status;
  state.job = res.job;
  if (res.job && (res.job.status === "running" || was === "running")) renderAgentBody();
}, 5000);

window.addEventListener("hashchange", render);
render();

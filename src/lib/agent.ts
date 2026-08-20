import { analyzePortfolio } from "./analyze";
import { askAscn, buildTokenPrompt, hasAscnKey, markdownToTelegram } from "./ascn";
import { readJson, writeJson } from "./store";
import { escapeHtml, getSettings, sendTelegram } from "./telegram";
import type { Alert, AgentRun, AgentJob, Analysis, TokenAnalysis } from "./types";

type Snapshot = {
  at: string;
  totalValueUsd: number;
  tokens: Record<
    string,
    { price: number; score: number; verdict: string; bestApy: number | null; newsUrls: string[] }
  >;
};

const MONEY = (n: number) => `$${Math.round(n).toLocaleString("ru-RU")}`;
const SIGN = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

function snapshotOf(a: Analysis): Snapshot {
  const tokens: Snapshot["tokens"] = {};
  for (const t of a.tokens) {
    tokens[t.symbol] = {
      price: t.market?.price ?? 0,
      score: t.score,
      verdict: t.verdict,
      bestApy: t.bestApy,
      newsUrls: t.news.map((n) => n.url),
    };
  }
  return { at: a.generatedAt, totalValueUsd: a.totalValueUsd, tokens };
}

/**
 * Что изменилось с прошлого запуска. Именно это и есть смысл агента:
 * не пересказывать портфель, а показать дельту, из-за которой надо что-то сделать.
 */
function diffAlerts(a: Analysis, prev: Snapshot | null): Alert[] {
  if (!prev) return [];
  const out: Alert[] = [];
  for (const t of a.tokens) {
    const before = prev.tokens[t.symbol];
    if (!before) continue;

    if (before.verdict !== t.verdict) {
      const worse = ["accumulate", "hold", "watch", "reduce", "sell"].indexOf(t.verdict) >
        ["accumulate", "hold", "watch", "reduce", "sell"].indexOf(before.verdict);
      out.push({
        level: worse ? (t.verdict === "sell" ? "critical" : "warning") : "positive",
        symbol: t.symbol,
        title: `${t.symbol}: вердикт изменился ${before.verdict} → ${t.verdict}`,
        body: t.reasons.slice(0, 2).map((r) => `• ${r.text}`).join("\n"),
        action: worse ? "Пересмотреть позицию" : "Можно докупать/стейкать",
      });
    } else if (Math.abs(t.score - before.score) >= 12) {
      out.push({
        level: t.score < before.score ? "warning" : "positive",
        symbol: t.symbol,
        title: `${t.symbol}: health ${before.score} → ${t.score}`,
        body: t.reasons.slice(0, 2).map((r) => `• ${r.text}`).join("\n"),
      });
    }

    if (before.price > 0 && t.market?.price) {
      const move = ((t.market.price - before.price) / before.price) * 100;
      if (Math.abs(move) >= 12) {
        out.push({
          level: move < 0 ? "warning" : "positive",
          symbol: t.symbol,
          title: `${t.symbol}: цена ${SIGN(move)} с прошлой проверки`,
          body: `Было $${before.price.toPrecision(4)}, стало $${t.market.price.toPrecision(4)}`,
        });
      }
    }

    const seen = new Set(before.newsUrls);
    const freshCritical = t.news.find((n) => !seen.has(n.url) && n.tone <= -2);
    if (freshCritical) {
      out.push({
        level: "critical",
        symbol: t.symbol,
        title: `${t.symbol}: новая плохая новость (${freshCritical.tags.join(", ")})`,
        body: `«${freshCritical.title}»\n${freshCritical.source}`,
        action: "Проверить, не пора ли выходить",
      });
    }
    const freshGood = t.news.find((n) => !seen.has(n.url) && n.tone >= 2);
    if (freshGood) {
      out.push({
        level: "positive",
        symbol: t.symbol,
        title: `${t.symbol}: новый позитив (${freshGood.tags.join(", ")})`,
        body: `«${freshGood.title}»\n${freshGood.source}`,
      });
    }

    if (before.bestApy != null && t.bestApy != null && t.bestApy - before.bestApy >= 3) {
      out.push({
        level: "info",
        symbol: t.symbol,
        title: `${t.symbol}: доходность выросла ${before.bestApy.toFixed(1)}% → ${t.bestApy.toFixed(1)}%`,
        body: t.best ? `${t.best.project} (${t.best.chain}), риск ${t.best.risk}/5` : "",
      });
    }
  }
  return out;
}

const ICON: Record<Alert["level"], string> = { critical: "🔴", warning: "🟡", positive: "🟢", info: "💤" };

export function buildDigest(a: Analysis, alerts: Alert[], prev: Snapshot | null): string {
  const change24 = a.totalValueUsd - a.change24hUsd > 0 ? (a.change24hUsd / (a.totalValueUsd - a.change24hUsd)) * 100 : 0;
  const lines: string[] = [];
  lines.push(`<b>📊 Портфель ${MONEY(a.totalValueUsd)}</b>`);
  lines.push(`За сутки: ${a.change24hUsd >= 0 ? "+" : "−"}${MONEY(Math.abs(a.change24hUsd))} (${SIGN(change24)})`);
  if (prev) {
    const delta = a.totalValueUsd - prev.totalValueUsd;
    const pct = prev.totalValueUsd > 0 ? (delta / prev.totalValueUsd) * 100 : 0;
    lines.push(`С прошлой проверки: ${delta >= 0 ? "+" : "−"}${MONEY(Math.abs(delta))} (${SIGN(pct)})`);
  }

  const groups: Alert["level"][] = ["critical", "warning", "positive", "info"];
  const titles: Record<Alert["level"], string> = {
    critical: "Требует действий",
    warning: "Внимание",
    positive: "Позитив",
    info: "Деньги лежат без дела",
  };
  for (const g of groups) {
    const items = alerts.filter((x) => x.level === g).slice(0, 6);
    if (!items.length) continue;
    lines.push("");
    lines.push(`${ICON[g]} <b>${titles[g]}</b>`);
    for (const it of items) {
      lines.push(`<b>${escapeHtml(it.title)}</b>`);
      if (it.body) lines.push(escapeHtml(it.body));
      if (it.action) lines.push(`→ ${escapeHtml(it.action)}`);
      lines.push("");
    }
  }

  if (a.context?.fearGreed) {
    lines.push(`Рынок: ${a.context.fearGreed.label} ${a.context.fearGreed.value}/100`);
  }

  const worst = [...a.tokens].sort((x, y) => x.score - y.score).slice(0, 3);
  lines.push("");
  lines.push("<b>Худшие в портфеле</b>");
  for (const t of worst) {
    lines.push(`${t.symbol} — ${t.score}/100 · ${MONEY(t.valueUsd)} · 7д ${SIGN(t.market?.change7d ?? 0)}`);
  }
  if (a.potentialYearlyUsd >= 1) {
    lines.push("");
    lines.push(`💰 Потенциал стейкинга: ${MONEY(a.potentialYearlyUsd)} в год с текущих позиций`);
  }
  const url = process.env.APP_URL || "http://localhost:3500";
  lines.push("");
  lines.push(`<a href="${url}">Открыть дашборд</a>`);
  return lines.join("\n");
}

/**
 * Кого отдавать ИИ на разбор. Один токен стоит 3-6 минут ожидания, поэтому
 * берём только те, где действительно что-то изменилось, и сортируем по весу
 * события и размеру позиции.
 */
function pickForAi(analysis: Analysis, alerts: Alert[], limit: number): TokenAnalysis[] {
  const weight: Record<Alert["level"], number> = { critical: 3, warning: 2, positive: 1.5, info: 0 };
  const score = new Map<string, number>();

  for (const a of alerts) {
    const w = weight[a.level];
    if (!w) continue;
    score.set(a.symbol, (score.get(a.symbol) ?? 0) + w);
  }
  for (const t of analysis.tokens) {
    if (t.verdict === "sell") score.set(t.symbol, (score.get(t.symbol) ?? 0) + 2);
    else if (t.verdict === "reduce") score.set(t.symbol, (score.get(t.symbol) ?? 0) + 1);
    if (t.news.some((n) => Math.abs(n.tone) >= 2)) score.set(t.symbol, (score.get(t.symbol) ?? 0) + 1);
  }

  return analysis.tokens
    .filter((t) => (score.get(t.symbol) ?? 0) > 0 && t.valueUsd >= 20)
    .sort((x, y) => {
      const byEvent = (score.get(y.symbol) ?? 0) - (score.get(x.symbol) ?? 0);
      return byEvent !== 0 ? byEvent : y.valueUsd - x.valueUsd;
    })
    .slice(0, Math.max(0, limit));
}

async function updateJob(patch: Partial<AgentJob>): Promise<void> {
  const current = await readJson<AgentJob | null>("agent-job.json", null);
  if (!current) return;
  await writeJson("agent-job.json", { ...current, ...patch });
}

export async function getJob(): Promise<AgentJob | null> {
  return readJson<AgentJob | null>("agent-job.json", null);
}

export async function startJob(trigger: "cron" | "manual"): Promise<AgentJob> {
  const job: AgentJob = {
    id: `${Date.now()}`,
    status: "running",
    trigger,
    startedAt: new Date().toISOString(),
    step: "разбираю портфель",
    aiDone: 0,
    aiTotal: 0,
  };
  await writeJson("agent-job.json", job);
  return job;
}

export async function runAgent(trigger: "cron" | "manual"): Promise<AgentRun> {
  const analysis = await analyzePortfolio();
  const prev = await readJson<Snapshot | null>("last-snapshot.json", null);
  const alerts = [...diffAlerts(analysis, prev), ...analysis.alerts];

  // одно и то же событие могло прийти и из дельты, и из базовых правил
  const seen = new Set<string>();
  const unique = alerts.filter((a) => {
    const k = `${a.level}|${a.symbol}|${a.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const important = unique.filter((a) => a.level !== "info");
  const settings = await getSettings();
  const shouldSend = important.length > 0 || settings.sendEmptyDigest || trigger === "manual";

  // ИИ-разбор: только по важным токенам и только если есть ключ
  const aiEnabled = settings.ai.enabled && hasAscnKey() && shouldSend;
  const candidates = aiEnabled ? pickForAi(analysis, unique, settings.ai.maxTokensPerRun) : [];
  const marketNote = analysis.context.fearGreed
    ? `индекс страха и жадности ${analysis.context.fearGreed.value}/100 (${analysis.context.fearGreed.label})`
    : "";

  await updateJob({ step: candidates.length ? "ИИ разбирает токены" : "формирую сводку", aiTotal: candidates.length });

  let aiDone = 0;
  const aiResults = await Promise.all(
    candidates.map(async (t) => {
      const res = await askAscn(buildTokenPrompt(t, marketNote), t.symbol);
      aiDone += 1;
      await updateJob({ aiDone });
      return res;
    }),
  );

  await updateJob({ step: "отправляю в Telegram" });

  const digest = buildDigest(analysis, unique, prev);
  const aiMessages = aiResults
    .filter((r) => r.content)
    .map((r) => `<b>🔍 ${escapeHtml(r.symbol)} — разбор ИИ</b>\n\n${markdownToTelegram(r.content as string)}`);

  let telegram: { sent: boolean; error?: string } = {
    sent: false,
    error: "Нечего сообщать — важных изменений нет",
  };

  if (shouldSend) {
    telegram = await sendTelegram(digest);
    // разборы отправляем отдельными сообщениями: так в канале читается лучше,
    // и падение одного не тянет за собой остальные
    for (const msg of aiMessages) {
      const res = await sendTelegram(msg);
      if (!res.sent && telegram.sent) telegram = { sent: true, error: `часть разборов не ушла: ${res.error}` };
    }
  }

  await writeJson("last-snapshot.json", snapshotOf(analysis));

  const aiFailed = aiResults.filter((r) => !r.content);
  const run: AgentRun = {
    id: `${Date.now()}`,
    at: analysis.generatedAt,
    trigger,
    totalValueUsd: analysis.totalValueUsd,
    alerts: unique,
    telegram,
    summary: digest.replace(/<[^>]+>/g, ""),
    ai: aiResults.map((r) => ({
      symbol: r.symbol,
      content: r.content,
      error: r.error ?? null,
      seconds: r.seconds,
    })),
    ...(aiFailed.length ? { aiError: aiFailed.map((r) => `${r.symbol}: ${r.error}`).join("; ") } : {}),
  };

  const history = await readJson<AgentRun[]>("agent-runs.json", []);
  await writeJson("agent-runs.json", [run, ...history].slice(0, 60));
  await updateJob({ status: "done", step: "готово", finishedAt: new Date().toISOString(), runId: run.id });
  return run;
}

export async function getRuns(): Promise<AgentRun[]> {
  return readJson<AgentRun[]>("agent-runs.json", []);
}

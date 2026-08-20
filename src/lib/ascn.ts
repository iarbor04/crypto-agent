import type { TokenAnalysis } from "./types";

const BASE = process.env.ASCN_API_URL || "https://b2b.api.ascn.ai";
const MODEL = process.env.ASCN_MODEL || "ascn_v1.2";

/** Разбор одного токена идёт 3-6 минут, поэтому ждём долго и запускаем параллельно. */
const TIMEOUT_MS = Number(process.env.ASCN_TIMEOUT_MS || 8 * 60_000);

export type AscnResult = { symbol: string; content: string | null; chatId: string | null; error?: string; seconds: number };

type ApiResponse = {
  chat_id?: string;
  content?: string | null;
  hil?: unknown;
  error?: string | null;
};

export function hasAscnKey(): boolean {
  return Boolean(process.env.ASCN_API_KEY);
}

const money = (n: number) => `$${Math.round(n).toLocaleString("ru-RU")}`;
const pct = (n: number | null | undefined) => (n == null ? "н/д" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);

/**
 * Контекст за день по токену + четыре раздела из задания.
 * Всё, что дашборд уже посчитал, отдаём ассистенту, чтобы он не тратил
 * шаги на цифры, которые у нас есть, и занимался ончейном и новостями.
 */
export function buildTokenPrompt(t: TokenAnalysis, marketNote: string): string {
  const m = t.market;
  const contract = t.meta?.chains[0];
  const facts: string[] = [
    `позиция ${money(t.valueUsd)}, это ${t.share.toFixed(1)}% портфеля`,
    m ? `цена $${m.price.toPrecision(5)}, за 24ч ${pct(m.change24h)}, за 7д ${pct(m.change7d)}, за 30д ${pct(m.change30d)}, за год ${pct(m.change1y)}` : "рыночных данных нет",
    m?.athChangePct != null ? `от исторического максимума ${pct(m.athChangePct)}` : "",
    m ? `капитализация ${money(m.marketCap)}, объём ${money(m.volume24h)} в сутки` : "",
    t.liquidity?.binance ? `ёмкость выхода ${money(t.liquidity.sellCapacityUsd)} (стакан ${t.liquidity.binance.pair} до -1%), DEX-ликвидность ${money(t.liquidity.dexTotalUsd)}` : "",
    t.funding != null ? `фондирование перпа ${(t.funding * 3 * 365 * 100).toFixed(0)}% в год` : "перпа на Binance нет",
    t.best ? `доступный стейкинг: ${t.best.apy.toFixed(1)}% в ${t.best.project} (риск ${t.best.risk}/5)` : "надёжного стейкинга нет",
    t.hacks.length ? `взлом ${t.hacks[0].date} на $${Math.round(t.hacks[0].amountUsd).toLocaleString("ru-RU")} (${t.hacks[0].technique})` : "",
    `моя оценка риска: ${t.score < 42 ? "высокий" : t.score < 56 ? "повышенный" : t.score < 72 ? "умеренный" : "низкий"} (${t.score}/100 по внутренней шкале), вердикт: ${t.verdict}`,
    t.reasons.filter((r) => r.kind === "bad").slice(0, 3).map((r) => r.text).join("; "),
  ].filter(Boolean);

  return [
    `Ты аналитик крипто-портфеля. Разбери токен ${t.symbol} (${t.meta?.name ?? m?.name ?? t.symbol}${contract ? `, контракт ${contract.address} в сети ${contract.chain}` : ""}).`,
    "",
    "Контекст из моего дашборда на сейчас:",
    ...facts.map((f) => `- ${f}`),
    marketNote ? `- по рынку: ${marketNote}` : "",
    "",
    "Проанализируй строго по четырём разделам, коротко и по делу:",
    "1) ОНЧЕЙН: потоки, крупные адреса, движения на биржи за сутки",
    "2) РЫНОК: что с ценой и позиционированием относительно рынка",
    "3) НОВОСТИ: значимое за последние сутки",
    "4) ЛИКВИДАЦИИ: где сосредоточены и что это значит",
    "",
    "В конце — абзац РЕШЕНИЕ: что делать с позицией. Без воды, максимум 220 слов, без markdown-таблиц.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Один вопрос ассистенту. auto_hil, чтобы он не останавливался на уточнениях. */
export async function askAscn(message: string, symbol = ""): Promise<AscnResult> {
  const key = process.env.ASCN_API_KEY;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);

  if (!key) return { symbol, content: null, chatId: null, error: "ASCN_API_KEY не задан", seconds: 0 };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/ai-assistant/v2/invoke_assistant`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { accept: "application/json", "content-type": "application/json", "X-API-Key": key },
      body: JSON.stringify({ message, model: MODEL, auto_hil: true }),
    });

    if (res.status === 429) return { symbol, content: null, chatId: null, error: "лимит запросов ASCN (429)", seconds: seconds() };
    if (!res.ok) return { symbol, content: null, chatId: null, error: `HTTP ${res.status}`, seconds: seconds() };

    const json = (await res.json()) as ApiResponse;
    if (json.error) return { symbol, content: null, chatId: json.chat_id ?? null, error: json.error, seconds: seconds() };
    if (!json.content) {
      return {
        symbol,
        content: null,
        chatId: json.chat_id ?? null,
        error: json.hil ? "ассистент запросил уточнение" : "пустой ответ",
        seconds: seconds(),
      };
    }
    return { symbol, content: json.content, chatId: json.chat_id ?? null, seconds: seconds() };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      symbol,
      content: null,
      chatId: null,
      error: aborted ? `не ответил за ${Math.round(TIMEOUT_MS / 60_000)} мин` : err instanceof Error ? err.message : String(err),
      seconds: seconds(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Markdown ассистента → HTML, который принимает Telegram.
 * Telegram знает только b/i/u/s/code/pre/a, поэтому заголовки и списки
 * переводим в жирный текст и точки.
 */
export function markdownToTelegram(md: string): string {
  const escaped = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/^#{1,6}\s*(.+)$/gm, (_, title: string) => `<b>${title.trim()}</b>`)
    .replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|\n)\s*[*-]\s+/g, "$1• ")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

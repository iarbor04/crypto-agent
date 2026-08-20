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
  const ind = t.indicators;
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
    ind
      ? `индикаторы: RSI ${ind.rsi14?.toFixed(0) ?? "н/д"}, цена ${ind.aboveSma50 ? "выше" : "ниже"} средней за 50 дней, средняя за 50 ${ind.goldenCross ? "выше" : "ниже"} годовой, дневной размах ${ind.atrPct?.toFixed(1) ?? "?"}%, в месячном коридоре ${ind.rangePosition?.toFixed(0) ?? "?"}% пути от минимума`
      : "",
    `моя оценка риска: ${t.score < 42 ? "высокий" : t.score < 56 ? "повышенный" : t.score < 72 ? "умеренный" : "низкий"} (${t.score}/100 по внутренней шкале), вердикт: ${t.verdict}`,
    t.reasons.filter((r) => r.kind === "bad").slice(0, 3).map((r) => r.text).join("; "),
  ].filter(Boolean);

  return [
    `Разбери токен ${t.symbol} (${t.meta?.name ?? m?.name ?? t.symbol}${contract ? `, контракт ${contract.address} в сети ${contract.chain}` : ""}).`,
    "Читатель — опытный трейдер: ему нужны цифры, адреса, уровни и даты, а не общие слова.",
    "",
    "Что уже посчитано у меня — не пересказывай, а опирайся:",
    ...facts.map((f) => `- ${f}`),
    marketNote ? `- по рынку: ${marketNote}` : "",
    "",
    "Дай четыре раздела. В каждом — только конкретика с числами и единицами:",
    "",
    "1) ТЕХНИЧЕСКИЙ АНАЛИЗ",
    "- что говорят индикаторы выше и что к ним добавить: дивергенции, сжатие волатильности, объёмный профиль",
    "- ближайшие уровни поддержки и сопротивления с ценами и тем, сколько раз их тестировали",
    "- структура тренда: выше или ниже предыдущих минимумов и максимумов",
    "",
    "2) ОНЧЕЙН",
    "- чистый поток на биржи и с бирж за 24ч и 7д, в долларах и во сколько раз это выше или ниже обычного",
    "- что делали крупные адреса и смарт-мани: покупали, продавали, сидели; суммы и адреса или метки",
    "- доля свежих кошельков в покупках — это спрос или раздача с одних рук",
    "- изменение концентрации у топ-холдеров, движения из вестинга и в стейкинг, если есть",
    "- где вообще живёт ликвидность: CEX против DEX",
    "",
    "3) САНТИМЕНТ",
    "- настроение в соцсетях и у трейдеров: растёт или гаснет внимание, есть ли перекос",
    "- сила или слабость против BTC, ETH и своего сектора за 24ч, 7д, 30д",
    "- открытый интерес и его изменение, базис спот-фьючерс, перекос в лонги или шорты",
    "- новости последних 24-48 часов с датами и источниками",
    "- разлоки и вестинг впереди: даты и объёмы в процентах от оборота",
    "- решения по управлению, листинги и делистинги, действия команды и инсайдеров",
    "- если значимого не было — так и напиши, без домыслов",
    "",
    "4) ЛИКВИДАЦИИ",
    "- сколько ликвидировано за 24ч, отдельно лонги и шорты",
    "- кластеры ликвидаций: конкретные цены и объёмы, насколько они далеко от текущей цены",
    "- ставка фондирования и что она говорит о перегреве",
    "- какой уровень запускает каскад",
    "",
    "В конце — два списка фактов. Каждый пункт с новой строки, начинается с дефиса,",
    "содержит конкретное число и не длиннее 15 слов. Ровно в таком виде:",
    "ЧТО ЗА ПОЗИЦИЮ:",
    "- факт с числом",
    "- факт с числом",
    "- факт с числом",
    "ЧТО ПРОТИВ:",
    "- факт с числом",
    "- факт с числом",
    "- факт с числом",
    "",
    "Важно: не давай рекомендаций и не советуй покупать, продавать, сокращать или держать.",
    "Никаких «стоит закрыть» и «целесообразно продать» — только факты и их следствия,",
    "решение читатель примет сам. Если каких-то данных нет — напиши «данных нет»,",
    "не заполняй пробел предположениями. Максимум 300 слов, без markdown-таблиц.",
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
 * Вытаскиваем из ответа два списка фактов. Ассистент пишет их в конце
 * блоками «ЧТО ЗА ПОЗИЦИЮ» и «ЧТО ПРОТИВ» — по ним карточки показывают плюсы и минусы.
 */
export function parseProsCons(content: string): { pros: string[]; cons: string[] } {
  const grab = (heading: RegExp): string[] => {
    const m = content.match(heading);
    if (!m) return [];
    const tail = content.slice((m.index ?? 0) + m[0].length);
    const stop = tail.search(/\n\s*(?:\*\*)?(?:ЧТО ПРОТИВ|ЧТО ЗА|РЕШЕНИЕ|ИТОГ|ВЫВОД)/i);
    const block = stop > 0 ? tail.slice(0, stop) : tail;
    const lines = block
      .split("\n")
      .map((l) => l.replace(/^[\s>]*[-*•·]\s*/, "").replace(/\*\*/g, "").trim())
      .filter((l) => l.length > 8 && l.length < 260);

    // модель иногда пишет все факты одной строкой: «1) ... 2) ... 3) ...»
    const flat = lines.flatMap((l) =>
      /\d\)\s/.test(l.slice(2))
        ? l
            .split(/\s*\d\)\s*/)
            .map((x) => x.trim())
            .filter((x) => x.length > 8)
        : [l],
    );
    return flat.map((l) => l.replace(/^[-*•·\s]+/, "").trim()).filter(Boolean).slice(0, 4);
  };
  return {
    pros: grab(/(?:\*\*)?ЧТО ЗА ПОЗИЦИЮ(?:\*\*)?\s*:?/i),
    cons: grab(/(?:\*\*)?ЧТО ПРОТИВ(?:\*\*)?\s*:?/i),
  };
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

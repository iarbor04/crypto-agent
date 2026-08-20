import { fetchText } from "./http";
import { cached } from "./store";
import type { NewsItem } from "./types";

// Публичные RSS: чем больше лент, тем выше шанс поймать новость по конкретному
// токену, а не только по биткоину. Все проверены и отдают от 10 до 96 записей.
const FEEDS = [
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://decrypt.co/feed", source: "Decrypt" },
  { url: "https://cryptoslate.com/feed/", source: "CryptoSlate" },
  { url: "https://www.theblock.co/rss.xml", source: "The Block" },
  { url: "https://u.today/rss", source: "U.Today" },
  { url: "https://ambcrypto.com/feed/", source: "AMBCrypto" },
  { url: "https://beincrypto.com/feed/", source: "BeInCrypto" },
  { url: "https://www.newsbtc.com/feed/", source: "NewsBTC" },
  { url: "https://cryptobriefing.com/feed/", source: "Crypto Briefing" },
  { url: "https://blockworks.co/feed", source: "Blockworks" },
  { url: "https://www.dlnews.com/arc/outboundfeeds/rss/", source: "DL News" },
  { url: "https://protos.com/feed/", source: "Protos" },
  { url: "https://bitcoinmagazine.com/feed", source: "Bitcoin Magazine" },
];

/** Слова, из которых собирается тон новости. Вес = насколько это меняет решение. */
const NEGATIVE: [RegExp, number, string][] = [
  [/\b(hack|hacked|exploit|exploited|drain(ed)?|stolen)\b/i, 3, "взлом"],
  [/\b(rug ?pull|scam|fraud|ponzi)\b/i, 3, "скам"],
  [/\b(shut(ting)? down|shuts down|wind(ing)? down|ceases? operations|bankrupt|insolvent|liquidation)\b/i, 3, "проект закрывается"],
  [/\b(delist(ed|ing)?|removed from)\b/i, 3, "делистинг"],
  [/\b(sec (sues|charges|probe)|lawsuit|sued|indicted|investigation|subpoena)\b/i, 2, "юридические риски"],
  [/\b(unlock|vesting|cliff|token unlock)\b/i, 2, "разлок токенов"],
  [/\b(exit scam|team sold|insider(s)? sold|dump(ed|ing)?)\b/i, 2, "продажи команды"],
  [/\b(depeg|depegged|bad debt|insolvency)\b/i, 3, "депег/плохой долг"],
  [/\b(plunge|plummet|crash|tank(s|ed)?|slump|sell-?off|bleed)\b/i, 1, "падение"],
  [/\b(layoff|lay ?offs|resign(ed|s|ation)|steps? down|departure)\b/i, 1, "уход команды"],
  [/\b(halt(ed|s)?|paused withdrawals|freeze)\b/i, 2, "остановка выводов"],
];

const POSITIVE: [RegExp, number, string][] = [
  [/\b(listing|listed on|lists)\b/i, 2, "листинг"],
  [/\b(partnership|partners with|integrat(es|ion)|collaborat)\b/i, 1, "партнёрство"],
  [/\b(mainnet|upgrade|launch(es|ed)?|v[23] launch)\b/i, 1, "релиз/апгрейд"],
  [/\b(buyback|burn(s|ed|ing)?|deflationary)\b/i, 2, "байбэк/сжигание"],
  [/\b(etf|institutional|treasury (buy|adds)|acquires?)\b/i, 2, "институционалы"],
  [/\b(raise[sd]?|funding round|series [ab]|invest(s|ment) of)\b/i, 1, "раунд/инвестиции"],
  [/\b(record|all-?time high|ath|surge|rally|soar|jump(s|ed)?)\b/i, 1, "рост"],
  [/\b(staking (live|launch)|rewards? (live|program)|airdrop)\b/i, 1, "стейкинг/награды"],
];

export function scoreHeadline(title: string): { tone: number; tags: string[] } {
  let tone = 0;
  const tags: string[] = [];
  for (const [re, w, tag] of NEGATIVE) if (re.test(title)) { tone -= w; tags.push(tag); }
  for (const [re, w, tag] of POSITIVE) if (re.test(title)) { tone += w; tags.push(tag); }
  return { tone: Math.max(-3, Math.min(3, tone)), tags: [...new Set(tags)] };
}

type RawNews = { title: string; url: string; source: string; publishedAt: string | null; body: string };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "’")
    .trim();
}

function parseRss(xml: string, source: string): RawNews[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  return items.slice(0, 80).map((item) => {
    const pick = (tag: string) => {
      const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? decode(m[1]) : "";
    };
    const date = pick("pubDate") || pick("dc:date");
    return {
      title: pick("title"),
      url: pick("link") || pick("guid"),
      source,
      publishedAt: date ? new Date(date).toISOString() : null,
      // анонс тоже ищем: токен часто упомянут в тексте, а в заголовке — «альткоины растут»
      body: (pick("description") || pick("content:encoded") || "").slice(0, 400),
    };
  }).filter((i) => i.title);
}

/** Общая лента крипто-новостей (публичные RSS). Кэш 20 минут. */
async function getFeed(): Promise<RawNews[]> {
  return cached<RawNews[]>("news-feed.json", 20 * 60_000, async () => {
    const chunks = await Promise.all(
      FEEDS.map(async (f) => {
        try {
          return parseRss(await fetchText(f.url, 15_000), f.source);
        } catch {
          return [];
        }
      }),
    );
    return chunks.flat();
  });
}

function mentions(text: string, symbol: string, name?: string): boolean {
  const title = text;
  // проверяем и заголовок, и анонс: токен часто назван только в тексте
  if (name && name.length > 3 && new RegExp(`\\b${escape(name)}\\b`, "i").test(title)) return true;
  // тикер ловим только в «сильной» форме: APE, $APE, (APE) — иначе слишком много ложных срабатываний
  if (symbol.length >= 3 && new RegExp(`(^|[\\s(\\[$"'])\\$?${escape(symbol)}($|[\\s)\\],.:;!?"'])`).test(title)) {
    return true;
  }
  return false;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Новости по токену: фильтр общей RSS-ленты по имени и тикеру. */
export async function getNews(symbol: string, name?: string, limit = 6): Promise<NewsItem[]> {
  const feed = await getFeed();
  const relevant = feed.filter((n) => mentions(n.title, symbol, name) || mentions(n.body, symbol, name));
  const seen = new Set<string>();
  return relevant
    .filter((n) => {
      const k = n.title.toLowerCase().slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((n) => ({ ...n, ...scoreHeadline(n.title) }))
    .sort((a, b) => {
      // сначала то, что меняет решение, потом свежее
      const impact = Math.abs(b.tone) - Math.abs(a.tone);
      if (impact !== 0) return impact;
      return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    })
    .slice(0, limit);
}

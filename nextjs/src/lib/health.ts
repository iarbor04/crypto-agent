import { promises as fs } from "fs";
import path from "path";

export type SourceHealth = {
  name: string;
  what: string;
  /** файл кэша: есть ли данные и насколько свежие */
  cache: string | null;
  ageMinutes: number | null;
  ttlMinutes: number;
  fresh: boolean | null;
  keyRequired: boolean;
  keyPresent: boolean | null;
};

export type Health = {
  ok: boolean;
  node: string;
  dataDir: boolean;
  telegramReady: boolean;
  agentSecretSet: boolean;
  coingeckoKey: boolean;
  sources: SourceHealth[];
};

const DATA_DIR = path.join(process.cwd(), "data");

const SOURCES: { name: string; what: string; cache: string | null; ttlMinutes: number }[] = [
  { name: "CoinGecko · цены", what: "цены, объёмы, спарклайны", cache: null, ttlMinutes: 5 },
  { name: "CoinGecko · профили", what: "ранг, категории, контракты", cache: null, ttlMinutes: 1440 },
  { name: "DeFiLlama · пулы", what: "стейкинг, лендинг, LP и APY", cache: "llama-pools.json", ttlMinutes: 30 },
  { name: "DeFiLlama · протоколы", what: "категории и TVL протоколов", cache: "llama-protocols.json", ttlMinutes: 1440 },
  { name: "DeFiLlama · взломы", what: "история инцидентов", cache: "llama-hacks.json", ttlMinutes: 1440 },
  { name: "DeFiLlama · стейблкоины", what: "контроль депега", cache: "stablecoins.json", ttlMinutes: 360 },
  { name: "Binance · пары", what: "список спотовых пар", cache: "binance-symbols.json", ttlMinutes: 1440 },
  { name: "Binance · фондирование", what: "ставки перпов", cache: "funding.json", ttlMinutes: 15 },
  { name: "Новости RSS", what: "заголовки по токенам", cache: "news-feed.json", ttlMinutes: 20 },
  { name: "Fear & Greed", what: "настроение рынка", cache: "fear-greed.json", ttlMinutes: 60 },
];

async function ageOf(file: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    const box = JSON.parse(raw) as { at?: number };
    if (typeof box.at !== "number") return null;
    return Math.round((Date.now() - box.at) / 60_000);
  } catch {
    return null;
  }
}

/** Что подтянулось, что просрочено, чего не хватает в конфиге — для страницы «Агент». */
export async function getHealth(): Promise<Health> {
  let dataDir = true;
  try {
    await fs.access(DATA_DIR);
  } catch {
    dataDir = false;
  }

  const sources: SourceHealth[] = [];

  for (const s of SOURCES) {
    // у цен и профилей имя файла зависит от набора монет — ищем самый свежий подходящий
    let cacheFile = s.cache;
    if (!cacheFile) {
      const prefix = s.name.includes("цены") ? "markets-" : "coin-";
      try {
        const files = (await fs.readdir(DATA_DIR)).filter((f) => f.startsWith(prefix));
        const ages = await Promise.all(files.map(ageOf));
        const valid = ages.filter((a): a is number => a != null);
        const age = valid.length ? Math.min(...valid) : null;
        sources.push({
          name: s.name,
          what: s.what,
          cache: files.length ? `${files.length} файлов` : null,
          ageMinutes: age,
          ttlMinutes: s.ttlMinutes,
          fresh: age == null ? null : age <= s.ttlMinutes,
          keyRequired: false,
          keyPresent: null,
        });
        continue;
      } catch {
        cacheFile = null;
      }
    }

    const age = cacheFile ? await ageOf(cacheFile) : null;
    sources.push({
      name: s.name,
      what: s.what,
      cache: cacheFile,
      ageMinutes: age,
      ttlMinutes: s.ttlMinutes,
      fresh: age == null ? null : age <= s.ttlMinutes,
      keyRequired: false,
      keyPresent: null,
    });
  }

  const { getSettings } = await import("./telegram");
  const settings = await getSettings();

  return {
    ok: dataDir,
    node: process.version,
    dataDir,
    telegramReady: Boolean(settings.botToken && settings.chatId),
    agentSecretSet: Boolean(process.env.AGENT_SECRET && process.env.AGENT_SECRET !== "change-me"),
    coingeckoKey: Boolean(process.env.COINGECKO_API_KEY),
    sources,
  };
}

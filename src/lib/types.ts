export type Holding = {
  symbol: string;
  amount: number;
  coinId?: string;
  note?: string;
};

export type Portfolio = {
  holdings: Holding[];
  updatedAt: string;
};

export type MarketData = {
  coinId: string;
  symbol: string;
  name: string;
  image: string;
  price: number;
  marketCap: number;
  rank: number | null;
  volume24h: number;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  change200d: number | null;
  change1y: number | null;
  athChangePct: number | null;
  athDate: string | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  sparkline7d: number[];
};

export type NewsItem = {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  /** -3..+3 */
  tone: number;
  tags: string[];
};

export type CoinMeta = {
  coinId: string;
  name: string;
  symbol: string;
  rank: number | null;
  categories: string[];
  description: string;
  homepage: string | null;
  explorer: string | null;
  twitter: string | null;
  github: string | null;
  chains: { chain: string; address: string }[];
  genesisDate: string | null;
  watchlistUsers: number | null;
  cgUrl: string;
};

export type CoinCandidate = {
  coinId: string;
  symbol: string;
  name: string;
  rank: number | null;
  image: string | null;
};

export type OrderbookDepth = {
  venue: string;
  pair: string;
  mid: number;
  spreadPct: number;
  /** сколько $ уходит в стакан при просадке цены до 0.5% / 1% / 2% */
  usd05: number;
  usd1: number;
  usd2: number;
};

export type DexPair = {
  chain: string;
  dex: string;
  pair: string;
  liquidityUsd: number;
  volume24h: number;
  url: string;
};

export type Liquidity = {
  binance: OrderbookDepth | null;
  dexTotalUsd: number;
  dexPairs: DexPair[];
  /** оценка суммы, которую рынок съест за раз без удара по цене больше 1% */
  sellCapacityUsd: number;
};

export type MarketContext = {
  fearGreed: { value: number; label: string } | null;
  /** тикер -> ставка фондирования за 8 часов */
  funding: Record<string, number>;
  /** тикер стейбла -> цена */
  stables: Record<string, number>;
};

export type Indicators = {
  rsi14: number | null;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  goldenCross: boolean | null;
  atrPct: number | null;
  rangeHigh: number;
  rangeLow: number;
  rangePosition: number | null;
  volumeTrendPct: number | null;
  source: string;
};

/** Разбор ассистента, сохранённый по токену: живёт между прогонами и виден в карточке. */
export type AiInsight = {
  at: string;
  pros: string[];
  cons: string[];
  content: string;
};

export type Opportunity = {
  id: string;
  kind: "staking" | "liquid-staking" | "lending" | "lp" | "farm" | "cex" | "other";
  project: string;
  projectSlug: string;
  chain: string;
  pair: string;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  tvlUsd: number;
  ilRisk: boolean;
  stablecoin: boolean;
  /** 1 = низкий риск, 5 = очень высокий */
  risk: number;
  riskNotes: string[];
  trend: "up" | "flat" | "down" | null;
  url: string;
  /** сколько принесёт позиция пользователя за год, $ */
  yearlyUsd?: number;
};

export type Verdict = "accumulate" | "hold" | "watch" | "reduce" | "sell";

export type TokenAnalysis = {
  symbol: string;
  amount: number;
  market: MarketData | null;
  meta: CoinMeta | null;
  liquidity: Liquidity | null;
  indicators: Indicators | null;
  ai: AiInsight | null;
  /** ставка фондирования перпа за 8 часов, если он есть */
  funding: number | null;
  hacks: { date: string; amountUsd: number; technique: string }[];
  valueUsd: number;
  share: number;
  score: number;
  verdict: Verdict;
  reasons: { text: string; weight: number; kind: "good" | "bad" | "neutral" }[];
  news: NewsItem[];
  newsTone: number;
  opportunities: Opportunity[];
  /** лучший вариант с приемлемым риском — на него опираются KPI и советы */
  best: Opportunity | null;
  bestApy: number | null;
  potentialYearlyUsd: number;
  exits: { label: string; url: string; hint: string }[];
  error?: string;
};

export type Analysis = {
  generatedAt: string;
  totalValueUsd: number;
  change24hUsd: number;
  potentialYearlyUsd: number;
  idleValueUsd: number;
  /** стоимость портфеля по часам за 7 дней — сложенные спарклайны позиций */
  series: number[];
  context: MarketContext;
  /** источники, которые не ответили — данные неполные, но страница работает */
  warnings: string[];
  partial: boolean;
  tokens: TokenAnalysis[];
  alerts: Alert[];
};

export type Alert = {
  level: "critical" | "warning" | "positive" | "info";
  symbol: string;
  title: string;
  body: string;
  action?: string;
};

export type AgentJob = {
  id: string;
  status: "running" | "done" | "error";
  trigger: "cron" | "manual";
  startedAt: string;
  finishedAt?: string;
  step: string;
  aiDone: number;
  aiTotal: number;
  runId?: string;
  error?: string;
};

export type AiTokenAnalysis = {
  symbol: string;
  content: string | null;
  error: string | null;
  seconds: number;
};

export type AgentRun = {
  id: string;
  at: string;
  trigger: "cron" | "manual";
  totalValueUsd: number;
  alerts: Alert[];
  telegram: { sent: boolean; error?: string };
  summary: string;
  /** разборы от ИИ-ассистента ASCN по важным токенам */
  ai?: AiTokenAnalysis[];
  aiError?: string;
};

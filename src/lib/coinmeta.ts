import { cgGet } from "./cgclient";
import { cached } from "./store";
import type { CoinMeta, CoinCandidate } from "./types";

type CgCoin = {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
  categories: (string | null)[];
  platforms: Record<string, string>;
  genesis_date: string | null;
  watchlist_portfolio_users: number | null;
  description: Record<string, string>;
  image?: { large?: string; small?: string };
  links: {
    homepage: string[];
    blockchain_site: string[];
    twitter_screen_name: string | null;
    subreddit_url: string | null;
    repos_url?: { github?: string[] };
  };
};

/** Категории CoinGecko зашумлены «X Ecosystem» — для карточки полезнее суть проекта. */
function pickCategories(raw: (string | null)[]): string[] {
  const clean = raw.filter((c): c is string => Boolean(c));
  const meaningful = clean.filter((c) => !/ecosystem|portfolio|index$/i.test(c));
  return (meaningful.length ? meaningful : clean).slice(0, 4);
}

function plainText(html: string, limit = 320): string {
  const text = html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastDot = cut.lastIndexOf(". ");
  return (lastDot > limit * 0.5 ? cut.slice(0, lastDot + 1) : `${cut.trimEnd()}…`);
}

const CHAIN_LABEL: Record<string, string> = {
  ethereum: "Ethereum",
  "binance-smart-chain": "BNB Chain",
  "polygon-pos": "Polygon",
  "arbitrum-one": "Arbitrum",
  "optimistic-ethereum": "Optimism",
  solana: "Solana",
  base: "Base",
  avalanche: "Avalanche",
  hyperevm: "HyperEVM",
  monad: "Monad",
  sui: "Sui",
  tron: "Tron",
  ton: "TON",
};

/** Профиль токена: категории, сети и контракты, ссылки, описание. Кэш 24 часа. */
export async function getCoinMeta(coinId: string): Promise<CoinMeta | null> {
  if (!coinId) return null;
  try {
    return await cached<CoinMeta>(`coin-${coinId}.json`, 24 * 60 * 60_000, async () => {
      const c = await cgGet<CgCoin>(`/coins/${encodeURIComponent(coinId)}`, {
        localization: "false",
        tickers: "false",
        market_data: "false",
        community_data: "false",
        developer_data: "false",
        sparkline: "false",
      });

      const chains = Object.entries(c.platforms ?? {})
        .filter(([chain, address]) => chain && address)
        .slice(0, 6)
        .map(([chain, address]) => ({ chain: CHAIN_LABEL[chain] ?? chain, address }));

      return {
        coinId: c.id,
        name: c.name,
        symbol: c.symbol.toUpperCase(),
        rank: c.market_cap_rank,
        categories: pickCategories(c.categories ?? []),
        description: plainText(c.description?.ru || c.description?.en || ""),
        homepage: c.links?.homepage?.find(Boolean) ?? null,
        explorer: c.links?.blockchain_site?.find(Boolean) ?? null,
        twitter: c.links?.twitter_screen_name ? `https://x.com/${c.links.twitter_screen_name}` : null,
        github: c.links?.repos_url?.github?.find(Boolean) ?? null,
        chains,
        genesisDate: c.genesis_date,
        watchlistUsers: c.watchlist_portfolio_users,
        cgUrl: `https://www.coingecko.com/en/coins/${c.id}`,
      };
    });
  } catch {
    return null;
  }
}

type SearchCoin = { id: string; symbol: string; name: string; market_cap_rank: number | null; thumb?: string; large?: string };

/**
 * Кандидаты по тикеру. Тикеры не уникальны (APE — это и ApeCoin, и десяток мемов),
 * поэтому в редакторе портфеля нужно показать, какой именно токен подставился.
 */
export async function searchCoins(query: string, limit = 6): Promise<CoinCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await cgGet<{ coins: SearchCoin[] }>("/search", { query: q });
    const byRank = (a: SearchCoin, b: SearchCoin) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9);
    // точное совпадение тикера всегда выше: по запросу APE первым должен идти ApeCoin, а не мем с рангом выше
    const exact = res.coins.filter((c) => c.symbol.toUpperCase() === q.toUpperCase()).sort(byRank);
    const rest = res.coins.filter((c) => c.symbol.toUpperCase() !== q.toUpperCase()).sort(byRank);
    return [...exact, ...rest]
      .slice(0, limit)
      .map((c) => ({
        coinId: c.id,
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        rank: c.market_cap_rank,
        image: c.large || c.thumb || null,
      }));
  } catch {
    return [];
  }
}

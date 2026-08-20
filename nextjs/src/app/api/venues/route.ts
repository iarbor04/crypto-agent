import { getVenues } from "@/lib/liquidity";

export const dynamic = "force-dynamic";

/** Площадки со спредами по требованию: /coins/{id}/tickers тратит лимит CoinGecko. */
export async function GET(req: Request) {
  const coinId = new URL(req.url).searchParams.get("coinId") ?? "";
  if (!coinId) return Response.json({ venues: [] });
  return Response.json({ venues: await getVenues(coinId) });
}

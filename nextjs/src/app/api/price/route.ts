import { getMarkets } from "@/lib/market";

export const dynamic = "force-dynamic";

/** Текущие цены по coingecko-id: нужны, чтобы вводить количество в долларах. */
export async function GET(req: Request) {
  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25);
  if (!ids.length) return Response.json({ prices: {} });
  try {
    const markets = await getMarkets(ids);
    const prices: Record<string, number> = {};
    for (const [id, m] of Object.entries(markets)) prices[id] = m.price;
    return Response.json({ prices });
  } catch (err) {
    return Response.json({ prices: {}, error: err instanceof Error ? err.message : String(err) });
  }
}

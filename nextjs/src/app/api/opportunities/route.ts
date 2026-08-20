import { getOpportunities } from "@/lib/yields";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const value = Number(url.searchParams.get("value") || 0);
  if (!symbol) return Response.json({ error: "symbol обязателен" }, { status: 400 });
  try {
    return Response.json({ symbol, opportunities: await getOpportunities(symbol, value, 20) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

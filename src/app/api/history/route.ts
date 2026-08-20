import { getPortfolioHistory } from "@/lib/history";

export const dynamic = "force-dynamic";

/** История стоимости портфеля: /api/history?days=90 */
export async function GET(req: Request) {
  const days = Number(new URL(req.url).searchParams.get("days") ?? 90);
  try {
    return Response.json(await getPortfolioHistory(Number.isFinite(days) ? days : 90));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

import { searchCoins } from "@/lib/coinmeta";

export const dynamic = "force-dynamic";

/** Кандидаты по тикеру для редактора портфеля: показать, какой именно токен подставился. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return Response.json({ candidates: [] });
  return Response.json({ candidates: await searchCoins(q) });
}

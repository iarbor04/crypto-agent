import { getPoolHistory, getProtocolEconomics } from "@/lib/pool";

export const dynamic = "force-dynamic";

/** История ставки пула и экономика протокола: /api/pool?id=<poolId>&slug=<project> */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const slug = url.searchParams.get("slug") ?? "";
  const [history, economics] = await Promise.all([
    id ? getPoolHistory(id) : Promise.resolve(null),
    slug ? getProtocolEconomics(slug) : Promise.resolve(null),
  ]);
  return Response.json({ history, economics });
}

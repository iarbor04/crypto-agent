import { getPortfolio, savePortfolio } from "@/lib/portfolio";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getPortfolio());
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { holdings?: unknown };
    const portfolio = await savePortfolio(body.holdings);
    return Response.json(portfolio);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

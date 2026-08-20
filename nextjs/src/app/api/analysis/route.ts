import { analyzePortfolio } from "@/lib/analyze";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  try {
    const analysis = await analyzePortfolio();
    return Response.json(analysis);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

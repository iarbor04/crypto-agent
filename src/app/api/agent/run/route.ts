import { runAgent } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** Ручной запуск из UI и запуск по cron (?secret=AGENT_SECRET). */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  const expected = process.env.AGENT_SECRET;
  const isCron = Boolean(secret);

  if (isCron && (!expected || secret !== expected)) {
    return Response.json({ error: "Неверный secret" }, { status: 401 });
  }
  try {
    const run = await runAgent(isCron ? "cron" : "manual");
    return Response.json(run);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

import { getHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/** Диагностика установки: свежесть кэшей, конфиг, готовность Telegram. */
export async function GET() {
  const health = await getHealth();
  return Response.json(health, { status: health.ok ? 200 : 503 });
}

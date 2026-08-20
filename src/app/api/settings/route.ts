import { nextRun } from "@/lib/scheduler";
import { getSettings, saveSettings } from "@/lib/telegram";
import { readJson } from "@/lib/store";

export const dynamic = "force-dynamic";

function mask(s: string) {
  if (!s) return "";
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : "…";
}

export async function GET() {
  const s = await getSettings();
  const state = await readJson<{ lastRunAt: string | null }>("schedule-state.json", { lastRunAt: null });
  return Response.json({
    chatId: s.chatId,
    sendEmptyDigest: s.sendEmptyDigest,
    botTokenMask: mask(s.botToken),
    hasBotToken: Boolean(s.botToken),
    schedule: s.schedule,
    ai: s.ai,
    next: s.schedule.enabled ? nextRun(s.schedule.times, s.schedule.timezone) : null,
    lastScheduledRun: state.lastRunAt,
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;
  const s = await saveSettings({
    ...(typeof body.botToken === "string" && body.botToken ? { botToken: body.botToken } : {}),
    ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}),
    ...(typeof body.sendEmptyDigest === "boolean" ? { sendEmptyDigest: body.sendEmptyDigest } : {}),
    ...(body.schedule && typeof body.schedule === "object" ? { schedule: body.schedule as never } : {}),
    ...(body.ai && typeof body.ai === "object" ? { ai: body.ai as never } : {}),
  });
  return Response.json({
    ok: true,
    chatId: s.chatId,
    hasBotToken: Boolean(s.botToken),
    sendEmptyDigest: s.sendEmptyDigest,
    schedule: s.schedule,
    next: s.schedule.enabled ? nextRun(s.schedule.times, s.schedule.timezone) : null,
  });
}

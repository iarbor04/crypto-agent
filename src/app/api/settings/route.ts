import { getSettings, saveSettings } from "@/lib/telegram";

export const dynamic = "force-dynamic";

function mask(s: string) {
  if (!s) return "";
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : "…";
}

export async function GET() {
  const s = await getSettings();
  return Response.json({
    chatId: s.chatId,
    sendEmptyDigest: s.sendEmptyDigest,
    botTokenMask: mask(s.botToken),
    hasBotToken: Boolean(s.botToken),
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;
  const s = await saveSettings({
    ...(typeof body.botToken === "string" && body.botToken ? { botToken: body.botToken } : {}),
    ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}),
    ...(typeof body.sendEmptyDigest === "boolean" ? { sendEmptyDigest: body.sendEmptyDigest } : {}),
  });
  return Response.json({ ok: true, chatId: s.chatId, hasBotToken: Boolean(s.botToken), sendEmptyDigest: s.sendEmptyDigest });
}

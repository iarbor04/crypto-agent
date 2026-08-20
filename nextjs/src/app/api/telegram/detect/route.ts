import { detectChats, getBotInfo } from "@/lib/telegram";

export const dynamic = "force-dynamic";

/**
 * Проверяет токен и ищет чаты, которые писали боту.
 * Токен можно передать в теле — тогда проверяем ещё не сохранённый.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { botToken?: string };
  const token = typeof body.botToken === "string" && body.botToken ? body.botToken : undefined;

  const info = await getBotInfo(token);
  if (!info.bot) return Response.json({ error: info.error ?? "Бот не отвечает" }, { status: 400 });

  const { chats, error } = await detectChats(token);
  return Response.json({ bot: info.bot, chats, ...(error ? { chatsError: error } : {}) });
}

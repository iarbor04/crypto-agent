import { sendTelegram } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = await sendTelegram(
    "<b>✅ Связь есть</b>\nЭто тестовое сообщение из дашборда портфеля. Сводки будут приходить сюда 2 раза в день.",
  );
  return Response.json(res, { status: res.sent ? 200 : 400 });
}

import { askAscn, getAscnCredentials } from "@/lib/ascn";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Проверка ключа ASCN: один короткий вопрос ассистенту.
 * Ключ можно передать в теле, чтобы проверить ещё не сохранённый.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { apiKey?: string; model?: string };
  const saved = await getAscnCredentials();
  const apiKey = typeof body.apiKey === "string" && body.apiKey ? body.apiKey.trim() : saved.apiKey;
  const model = typeof body.model === "string" && body.model ? body.model.trim() : saved.model;

  if (!apiKey) return Response.json({ ok: false, error: "Ключ не задан" }, { status: 400 });

  const res = await askAscn("Проверка связи: ответь одним словом OK", "", { apiKey, model });
  return Response.json(
    res.content ? { ok: true, model, seconds: res.seconds, answer: res.content.slice(0, 40) } : { ok: false, error: res.error },
    { status: res.content ? 200 : 400 },
  );
}

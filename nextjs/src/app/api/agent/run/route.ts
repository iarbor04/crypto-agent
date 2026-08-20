import { getJob, runAgent, startJob } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

/**
 * Ставит разбор в работу и сразу отвечает: ИИ-анализ одного токена идёт 3-6 минут,
 * держать HTTP-запрос всё это время нельзя. Прогресс — в GET /api/agent/job.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  const expected = process.env.AGENT_SECRET;
  const isCron = Boolean(secret);
  const wait = url.searchParams.get("wait") === "1";

  if (isCron && (!expected || secret !== expected)) {
    return Response.json({ error: "Неверный secret" }, { status: 401 });
  }

  const running = await getJob();
  if (running?.status === "running") {
    return Response.json({ job: running, alreadyRunning: true }, { status: 202 });
  }

  const job = await startJob(isCron ? "cron" : "manual");
  const work = runAgent(isCron ? "cron" : "manual");

  if (wait) {
    try {
      return Response.json(await work);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  // работа продолжается в живом процессе сервера, ответ уходит сразу
  work.catch(async (err) => {
    const { writeJson } = await import("@/lib/store");
    await writeJson("agent-job.json", {
      ...job,
      status: "error",
      step: "ошибка",
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return Response.json({ job }, { status: 202 });
}

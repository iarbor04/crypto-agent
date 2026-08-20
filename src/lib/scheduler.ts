import { runAgent } from "./agent";
import { readJson, writeJson } from "./store";
import { getSettings } from "./telegram";

type ScheduleState = {
  /** "09:00" -> "2026-08-20", чтобы не запускать слот дважды за день */
  fired: Record<string, string>;
  lastRunAt: string | null;
};

const TICK_MS = 30_000;
let started = false;

/** Время и дата в часовом поясе пользователя, а не сервера. */
export function nowIn(timeZone: string): { hhmm: string; date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    hhmm: `${hour}:${get("minute")}`,
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(hour) * 60 + Number(get("minute")),
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Следующий запуск и сколько до него — для панели расписания. */
export function nextRun(times: string[], timeZone: string): { at: string; inMinutes: number; today: boolean } | null {
  if (!times.length) return null;
  const now = nowIn(timeZone);
  const sorted = [...times].sort();
  const upcoming = sorted.find((t) => toMinutes(t) > now.minutes);
  if (upcoming) return { at: upcoming, inMinutes: toMinutes(upcoming) - now.minutes, today: true };
  return { at: sorted[0], inMinutes: 1440 - now.minutes + toMinutes(sorted[0]), today: false };
}

async function tick(): Promise<void> {
  const settings = await getSettings();
  const { schedule } = settings;
  if (!schedule.enabled || !schedule.times.length) return;

  const now = nowIn(schedule.timezone);
  const state = await readJson<ScheduleState>("schedule-state.json", { fired: {}, lastRunAt: null });

  for (const time of schedule.times) {
    if (state.fired[time] === now.date) continue;

    const due = schedule.catchUp ? toMinutes(time) <= now.minutes : time === now.hhmm;
    if (!due) continue;

    // помечаем слот до запуска: разбор длится десятки секунд, а тик идёт каждые 30
    state.fired[time] = now.date;
    state.lastRunAt = new Date().toISOString();
    await writeJson("schedule-state.json", state);

    try {
      const run = await runAgent("cron");
      console.log(
        `[scheduler] ${time} ${schedule.timezone}: портфель $${Math.round(run.totalValueUsd)}, сигналов ${run.alerts.length}, telegram: ${
          run.telegram.sent ? "отправлено" : run.telegram.error
        }`,
      );
    } catch (err) {
      console.error(`[scheduler] ${time}: разбор упал —`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Планировщик внутри приложения: пользователь выбирает время в интерфейсе,
 * crontab не нужен. Пропущенные из-за выключенной машины запуски догоняются.
 */
export function startScheduler(): void {
  if (started) return;
  started = true;
  console.log("[scheduler] запущен, проверка каждые 30 секунд");
  setInterval(() => {
    tick().catch((err) => console.error("[scheduler] tick error:", err));
  }, TICK_MS).unref?.();
  // первый тик сразу — чтобы догнать пропущенное после перезапуска
  setTimeout(() => tick().catch(() => {}), 5_000);
}

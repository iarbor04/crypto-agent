"use client";

import { useCallback, useEffect, useState } from "react";
import { Play, Plus, Send, X } from "lucide-react";
import { Loader } from "@/components/bits";
import { money, timeAgo } from "@/lib/format";
import type { AgentRun } from "@/lib/types";

type SettingsView = {
  chatId: string;
  sendEmptyDigest: boolean;
  botTokenMask: string;
  hasBotToken: boolean;
  schedule: Schedule;
  next: NextRun;
  lastScheduledRun: string | null;
};
type Detected = { bot: { username: string; name: string }; chats: { id: string; title: string; type: string }[] };
type Schedule = { enabled: boolean; times: string[]; timezone: string; catchUp: boolean };
type NextRun = { at: string; inMinutes: number; today: boolean } | null;

const CURL = `curl -X POST "http://localhost:3500/api/agent/run?secret=$AGENT_SECRET"`;

const PRESETS: { label: string; times: string[] }[] = [
  { label: "Утро и вечер", times: ["09:00", "21:00"] },
  { label: "Три раза", times: ["09:00", "15:00", "21:00"] },
  { label: "Каждые 6 часов", times: ["00:00", "06:00", "12:00", "18:00"] },
];

function humanIn(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export default function AgentPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [next, setNext] = useState<NextRun>(null);

  const loadAll = useCallback(async () => {
    const [s, h] = await Promise.all([
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/agent/history", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setSettings(s);
    setChatId(s.chatId ?? "");
    setEmpty(Boolean(s.sendEmptyDigest));
    setRuns(h.runs ?? []);
    setSchedule(s.schedule ?? null);
    setNext(s.next ?? null);
  }, []);

  useEffect(() => {
    // загрузка при монтировании: setState срабатывает уже после await, не в теле эффекта
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, [loadAll]);

  async function saveSettings() {
    setBusy("save");
    setMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(token ? { botToken: token } : {}), chatId, sendEmptyDigest: empty }),
      });
      if (!res.ok) throw new Error("Не удалось сохранить настройки");
      setToken("");
      setMsg({ text: "Настройки сохранены", ok: true });
      await loadAll();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function saveSchedule(patch: Partial<Schedule>) {
    if (!schedule) return;
    const nextSchedule = { ...schedule, ...patch, times: [...(patch.times ?? schedule.times)].sort() };
    setSchedule(nextSchedule);
    setBusy("schedule");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schedule: nextSchedule }),
      });
      const json = (await res.json()) as { schedule?: Schedule; next?: NextRun };
      if (json.schedule) setSchedule(json.schedule);
      setNext(json.next ?? null);
    } catch {
      setMsg({ text: "Не удалось сохранить расписание", ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function detectBot() {
    setBusy("detect");
    setMsg(null);
    setDetected(null);
    try {
      const res = await fetch("/api/telegram/detect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(token ? { botToken: token } : {}),
      });
      const json = (await res.json()) as Detected & { error?: string; chatsError?: string };
      if (json.error) throw new Error(json.error);
      setDetected(json);
      if (!json.chats.length) {
        setMsg({
          text: `Бот @${json.bot.username} на связи, но ему ещё никто не писал. Напишите ему /start в личку (или добавьте админом в канал и отправьте туда сообщение) и нажмите ещё раз.`,
          ok: false,
        });
      } else {
        setMsg({ text: `Бот @${json.bot.username} на связи. Выберите чат ниже.`, ok: true });
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function testTelegram() {
    setBusy("test");
    setMsg(null);
    const res = await fetch("/api/telegram/test", { method: "POST" });
    const json = (await res.json()) as { sent?: boolean; error?: string };
    setMsg(json.sent ? { text: "Сообщение ушло в Telegram", ok: true } : { text: json.error ?? "Ошибка", ok: false });
    setBusy(null);
  }

  async function runNow() {
    setBusy("run");
    setMsg(null);
    try {
      const res = await fetch("/api/agent/run", { method: "POST" });
      const json = (await res.json()) as AgentRun & { error?: string };
      if (json.error) throw new Error(json.error);
      setMsg(
        json.telegram.sent
          ? { text: `Разбор готов, сводка отправлена в Telegram (${json.alerts.length} сигналов)`, ok: true }
          : { text: `Разбор готов, но в Telegram не ушло: ${json.telegram.error}`, ok: false },
      );
      await loadAll();
      setExpanded(json.id);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(null);
    }
  }

  const ready = Boolean(settings?.hasBotToken && settings?.chatId);

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">АВТОМАТИЗАЦИЯ</span>
          <h1>Агент</h1>
          <p>Разбирает портфель дважды в день и пишет в Telegram, только когда есть что сказать</p>
        </div>
        <div className="top-actions">
          <button className="ghost-button" onClick={testTelegram} disabled={busy === "test"}>
            <Send size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} strokeWidth={2} />
            {busy === "test" ? "Отправляю…" : "Тест сообщения"}
          </button>
          <button className="primary-button" onClick={runNow} disabled={busy === "run"}>
            <Play size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} strokeWidth={2} />
            {busy === "run" ? "Разбираю портфель…" : "Запустить разбор"}
          </button>
        </div>
      </div>

      <div className="alert-grid" style={{ alignItems: "start" }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Канал доставки</h2>
              <p>Куда агент присылает сводку по портфелю</p>
            </div>
            <span className={`pill ${ready ? "pill-green" : "pill-amber"}`}>
              <i className="status-dot" style={{ background: ready ? "var(--green)" : "var(--amber)" }} />
              {ready ? "Подключено" : "Не настроено"}
            </span>
          </div>
          <div className="card-body">
            <label className="field">
              BOT TOKEN — @BotFather → /newbot
              <input
                value={token}
                placeholder={settings?.hasBotToken ? settings.botTokenMask : "123456:AA…"}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <label className="field">
              CHAT ID ИЛИ @КАНАЛ — можно определить кнопкой ниже
              <input value={chatId} placeholder="@my_portfolio или 123456789" onChange={(e) => setChatId(e.target.value)} />
            </label>

            <button className="ghost-button" style={{ width: "100%", marginBottom: 12 }} onClick={detectBot} disabled={busy === "detect"}>
              {busy === "detect" ? "Спрашиваю Telegram…" : "Проверить бота и найти чат"}
            </button>

            {!!detected?.chats.length && (
              <div className="candidate-list" style={{ marginBottom: 12 }}>
                {detected.chats.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setChatId(c.id);
                      setMsg({ text: `Подставил chat id ${c.id}. Нажмите «Сохранить», потом «Тест сообщения».`, ok: true });
                    }}
                  >
                    <b style={{ fontWeight: 600 }}>{c.title}</b>
                    <span style={{ color: "#9aa1af" }}>{c.type}</span>
                    <small style={{ marginLeft: "auto" }}>{c.id}</small>
                  </button>
                ))}
              </div>
            )}
            <label className="checkbox">
              <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} />
              <span>
                Присылать сводку всегда
                <small>По умолчанию агент молчит, если важных изменений нет — чтобы канал не превращался в шум.</small>
              </span>
            </label>
            <div style={{ marginTop: 18 }}>
              <button className="primary-button" onClick={saveSettings} disabled={busy === "save"}>
                {busy === "save" ? "Сохраняю…" : "Сохранить"}
              </button>
            </div>
            {msg && <p className={`form-note ${msg.ok ? "ok" : "err"}`}>{msg.text}</p>}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Расписание</h2>
              <p>
                {schedule?.enabled
                  ? next
                    ? `Следующий разбор ${next.today ? "сегодня" : "завтра"} в ${next.at} — через ${humanIn(next.inMinutes)}`
                    : "Время не выбрано"
                  : "Агент выключен — сводки приходить не будут"}
              </p>
            </div>
            <label className="switch" title="Включить или выключить агента">
              <input
                type="checkbox"
                checked={Boolean(schedule?.enabled)}
                onChange={(e) => saveSchedule({ enabled: e.target.checked })}
                disabled={!schedule || busy === "schedule"}
              />
              <span />
            </label>
          </div>

          <div className="card-body">
            {!schedule && <p className="hint">Загружаю расписание…</p>}

            {schedule && (
              <>
                <span className="label" style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.6 }}>
                  ВРЕМЯ ЗАПУСКА · {schedule.timezone}
                </span>

                <div className="time-list">
                  {schedule.times.map((t, i) => (
                    <div className="time-chip" key={`${t}-${i}`}>
                      <input
                        type="time"
                        value={t}
                        onChange={(e) => {
                          const times = [...schedule.times];
                          times[i] = e.target.value;
                          saveSchedule({ times });
                        }}
                      />
                      {schedule.times.length > 1 && (
                        <button
                          onClick={() => saveSchedule({ times: schedule.times.filter((_, idx) => idx !== i) })}
                          aria-label="Убрать время"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                  {schedule.times.length < 8 && (
                    <button
                      className="time-add"
                      onClick={() => saveSchedule({ times: [...schedule.times, "12:00"] })}
                    >
                      <Plus size={14} /> Добавить время
                    </button>
                  )}
                </div>

                <div className="preset-row">
                  <span>Быстрый выбор:</span>
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      className={schedule.times.join() === p.times.join() ? "active" : ""}
                      onClick={() => saveSchedule({ times: p.times })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <label className="checkbox" style={{ marginTop: 16 }}>
                  <input
                    type="checkbox"
                    checked={schedule.catchUp}
                    onChange={(e) => saveSchedule({ catchUp: e.target.checked })}
                  />
                  <span>
                    Догонять пропущенное
                    <small>
                      Если в назначенное время машина была выключена или дашборд не работал — разбор запустится сразу
                      после запуска, а не пропадёт до следующего раза.
                    </small>
                  </span>
                </label>

                <div className="schedule-foot">
                  <span>
                    {settings?.lastScheduledRun
                      ? `Последний запуск по расписанию: ${new Date(settings.lastScheduledRun).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
                      : "По расписанию ещё не запускался"}
                  </span>
                  {busy === "schedule" && <span style={{ color: "var(--blue)" }}>сохраняю…</span>}
                </div>

                <details className="external">
                  <summary>Запускать внешним планировщиком</summary>
                  <p className="hint" style={{ marginTop: 10 }}>
                    Расписание выше держит сам дашборд, пока он запущен. Если хочется дёргать разбор извне — например
                    из cron на сервере или из чужого планировщика:
                  </p>
                  <pre className="code">{CURL}</pre>
                  <p className="hint" style={{ marginTop: 8, fontSize: 10.5 }}>
                    Секрет берётся из <code>AGENT_SECRET</code> в <code>.env.local</code>. Готовый скрипт для cron —{" "}
                    <code>node scripts/run-agent.mjs</code>.
                  </p>
                </details>
              </>
            )}
          </div>
        </div>
      </div>

      <h2 className="section-heading">История запусков</h2>
      {!runs && <Loader text="Загружаю историю" />}
      {runs && !runs.length && (
        <div className="empty-state">
          <h3>Запусков ещё не было</h3>
          <p>
            Нажмите «Запустить разбор» — придёт первая сводка, и агент запомнит состояние портфеля, чтобы в следующий
            раз показать именно изменения.
          </p>
        </div>
      )}
      {runs && !!runs.length && (
        <div className="card">
          {runs.map((r) => {
            const open = expanded === r.id;
            const critical = r.alerts.filter((a) => a.level === "critical").length;
            const warning = r.alerts.filter((a) => a.level === "warning").length;
            const positive = r.alerts.filter((a) => a.level === "positive").length;
            return (
              <div key={r.id}>
                <button className="run-row" onClick={() => setExpanded(open ? null : r.id)}>
                  <span className="mono" style={{ width: 130, color: "#333c4e", fontWeight: 600 }}>
                    {new Date(r.at).toLocaleString("ru-RU", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span style={{ width: 76 }}>{r.trigger === "cron" ? "по крону" : "вручную"}</span>
                  <span className="mono" style={{ width: 96, color: "#333c4e", fontWeight: 600 }}>
                    {money(r.totalValueUsd)}
                  </span>
                  <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {critical > 0 && <span className="pill pill-red">{critical} критич</span>}
                    {warning > 0 && <span className="pill pill-amber">{warning} внимание</span>}
                    {positive > 0 && <span className="pill pill-green">{positive} позитив</span>}
                    {!r.alerts.length && <span className="pill pill-gray">без сигналов</span>}
                  </span>
                  <span style={{ marginLeft: "auto", color: r.telegram.sent ? "var(--green)" : "#9aa1af" }}>
                    {r.telegram.sent ? "отправлено" : "не отправлено"} · {timeAgo(r.at)}
                  </span>
                </button>
                {open && (
                  <pre className="run-summary">
                    {r.summary}
                    {!r.telegram.sent && r.telegram.error ? `\n\n[telegram] ${r.telegram.error}` : ""}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

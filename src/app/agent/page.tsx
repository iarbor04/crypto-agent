"use client";

import { useCallback, useEffect, useState } from "react";
import { Play, Send } from "lucide-react";
import { Loader } from "@/components/bits";
import { money, timeAgo } from "@/lib/format";
import type { AgentRun } from "@/lib/types";
import type { Health } from "@/lib/health";

type SettingsView = { chatId: string; sendEmptyDigest: boolean; botTokenMask: string; hasBotToken: boolean };
type Detected = { bot: { username: string; name: string }; chats: { id: string; title: string; type: string }[] };

const CRON = `0 9 * * *  cd /path/to/crypto-agent && node scripts/run-agent.mjs
0 21 * * * cd /path/to/crypto-agent && node scripts/run-agent.mjs`;

const CURL = `curl -X POST "http://localhost:3500/api/agent/run?secret=$AGENT_SECRET"`;

export default function AgentPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null);

  const loadAll = useCallback(async () => {
    const [s, h, hl] = await Promise.all([
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/agent/history", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/health", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => null),
    ]);
    setSettings(s);
    setChatId(s.chatId ?? "");
    setEmpty(Boolean(s.sendEmptyDigest));
    setRuns(h.runs ?? []);
    setHealth(hl);
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
              <p>Два запуска в день: утром и вечером</p>
            </div>
            <span className="pill pill-blue">2 РАЗА В ДЕНЬ</span>
          </div>
          <div className="card-body">
            <p className="hint">
              Добавьте две строки в crontab на машине, где живёт дашборд (<code>crontab -e</code>):
            </p>
            <pre className="code">{CRON}</pre>
            <p className="hint" style={{ marginTop: 14 }}>
              Или дёргайте эндпоинт из любого планировщика:
            </p>
            <pre className="code">{CURL}</pre>
            <p className="hint" style={{ marginTop: 14 }}>
              Что делает разбор: тянет цены и объёмы, ищет новости по каждому токену, пересчитывает health, сравнивает с
              прошлым запуском и отправляет только дельту — новые плохие и хорошие новости, смену вердикта, движения
              цены больше 12%, выросшие ставки стейкинга.
            </p>
          </div>
        </div>
      </div>

      {health && (
        <>
          <h2 className="section-heading">Состояние установки</h2>
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Конфигурация</h2>
                <p>Node {health.node} · всё, что не задано, работает на публичных лимитах</p>
              </div>
            </div>
            <div className="config-grid">
              <div className="config-item">
                <i className="status-dot" style={{ background: health.dataDir ? "var(--green)" : "var(--red)" }} />
                Каталог данных <small>{health.dataDir ? "data/ на месте" : "нет доступа к data/"}</small>
              </div>
              <div className="config-item">
                <i className="status-dot" style={{ background: health.coingeckoKey ? "var(--green)" : "var(--amber)" }} />
                Ключ CoinGecko <small>{health.coingeckoKey ? "задан" : "нет — лимит 5–15 запросов/мин"}</small>
              </div>
              <div className="config-item">
                <i className="status-dot" style={{ background: health.telegramReady ? "var(--green)" : "var(--amber)" }} />
                Telegram <small>{health.telegramReady ? "подключён" : "сводки не уйдут"}</small>
              </div>
              <div className="config-item">
                <i className="status-dot" style={{ background: health.agentSecretSet ? "var(--green)" : "var(--amber)" }} />
                AGENT_SECRET <small>{health.agentSecretSet ? "задан" : "запуск по cron не пройдёт"}</small>
              </div>
            </div>

            <div style={{ padding: "14px 20px 4px" }}>
              <span className="label" style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.6 }}>
                ИСТОЧНИКИ ДАННЫХ
              </span>
            </div>
            {health.sources.map((s) => (
              <div className="source-row" key={s.name}>
                <i
                  className="status-dot"
                  style={{ background: s.fresh === null ? "#cfd5e6" : s.fresh ? "var(--green)" : "var(--amber)" }}
                />
                <b>{s.name}</b>
                <span className="what">{s.what}</span>
                <span className="age">
                  {s.ageMinutes == null
                    ? "ещё не загружалось"
                    : s.ageMinutes < 60
                      ? `${s.ageMinutes} мин назад`
                      : `${Math.round(s.ageMinutes / 60)} ч назад`}
                </span>
              </div>
            ))}
            <div style={{ padding: "12px 20px 18px" }}>
              <p className="hint" style={{ fontSize: 10.5 }}>
                Жёлтый — кэш просрочен, обновится при следующем разборе. «Ещё не загружалось» — источник не понадобился
                или не ответил; страница при этом работает на остальных данных.
              </p>
            </div>
          </div>
        </>
      )}

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

#!/usr/bin/env node
// Запуск разбора по расписанию: node scripts/run-agent.mjs
// Читает .env.local и дёргает /api/agent/run на локальном инстансе.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const file of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(resolve(root, file), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // файла может не быть — тогда берём переменные окружения как есть
  }
}

const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 3500}`;
const secret = process.env.AGENT_SECRET;

if (!secret) {
  console.error("AGENT_SECRET не задан в .env.local — эндпоинт откажет в запуске по крону");
  process.exit(1);
}

const res = await fetch(`${base}/api/agent/run?secret=${encodeURIComponent(secret)}`, { method: "POST" });
const json = await res.json();

if (!res.ok) {
  console.error(`[${new Date().toISOString()}] ошибка: ${json.error ?? res.status}`);
  process.exit(1);
}

console.log(
  `[${new Date().toISOString()}] портфель $${Math.round(json.totalValueUsd)}, ` +
    `сигналов ${json.alerts.length}, telegram: ${json.telegram.sent ? "отправлено" : json.telegram.error}`,
);

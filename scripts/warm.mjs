#!/usr/bin/env node
// Прогрев кэшей после клонирования: тянет цены, пулы, взломы, новости и контекст,
// чтобы первое открытие дашборда не ждало внешние API.
// Запуск: npm run warm (сервер должен быть поднят)
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
    // .env может не быть — работаем на публичных лимитах
  }
}

const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 3500}`;
const started = Date.now();

process.stdout.write(`Прогреваю кэши через ${base} …\n`);
const res = await fetch(`${base}/api/analysis`, { signal: AbortSignal.timeout(180_000) }).catch((e) => {
  console.error(`Не смог обратиться к ${base}: ${e.message}\nПоднимите сервер: npm run dev`);
  process.exit(1);
});

const json = await res.json();
if (json.error) {
  console.error(`Ошибка разбора: ${json.error}`);
  process.exit(1);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`Готово за ${secs} с: позиций ${json.tokens.length}, стоимость $${Math.round(json.totalValueUsd)}`);
if (json.partial) console.log(`Неполные данные: ${json.warnings.join(", ")} — запустите ещё раз через минуту.`);

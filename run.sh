#!/bin/sh
# Запуск дашборда одной командой. Нужен только Python 3.
cd "$(dirname "$0")" || exit 1

PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3 не найден. Установите python3 и запустите снова." >&2
  exit 1
fi

if [ ! -f .env.local ] && [ -f .env.example ]; then
  cp .env.example .env.local
  echo "Создан .env.local — ключи не обязательны, всё настраивается в интерфейсе."
fi

exec "$PY" server.py

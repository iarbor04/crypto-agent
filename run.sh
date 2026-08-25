#!/bin/sh
# Запуск дашборда. Нужен только Python 3.
#
#   ./run.sh              запуск на переднем плане (для человека, Ctrl+C останавливает)
#   ./run.sh --background запуск фоном: пишет server.log, ждёт готовности и выходит
#   ./run.sh --stop       остановить фоновый процесс
#
# Агенту нужен именно --background: команда переднего плана не завершается,
# и вызывающая сторона видит это как зависание запуска.
cd "$(dirname "$0")" || exit 1

PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3 не найден. Установите python3 и запустите снова." >&2
  exit 1
fi

PORT="${PORT:-3500}"
PIDFILE="data/server.pid"
LOGFILE="server.log"

if [ ! -f .env.local ] && [ -f .env.example ]; then
  cp .env.example .env.local
  echo "Создан .env.local — ключи не обязательны, всё настраивается в интерфейсе."
fi

case "$1" in
  --stop|-s)
    if [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; then
      rm -f "$PIDFILE"
      echo "Остановлен."
    else
      rm -f "$PIDFILE"
      echo "Работающий процесс не найден." >&2
      exit 1
    fi
    ;;
  --background|-b)
    mkdir -p data
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Уже запущен, pid $(cat "$PIDFILE"). Остановить: ./run.sh --stop" >&2
      exit 1
    fi
    # Порт мог остаться занят копией из другого каталога — её pid-файл лежит
    # там, и проверка выше его не видит. Тогда наш процесс не забиндится и
    # умрёт, а проба готовности ниже достучится до чужого сервера и объявит
    # запуск удачным. Снаружи это выглядит как «поднялась старая версия».
    if "$PY" - "$PORT" <<'BUSY' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
BUSY
    then
      echo "Порт $PORT уже занят — на нём отвечает другой процесс." >&2
      "$PY" - "$PORT" >&2 2>/dev/null <<'WHO'
import json, sys, urllib.request
try:
    with urllib.request.urlopen("http://127.0.0.1:%s/api/health" % sys.argv[1], timeout=3) as r:
        data = json.load(r)
    print("Там уже работает этот же дашборд, версия %s." % (data.get("version") or "неизвестна"))
except Exception:
    print("Что это за процесс — определить не удалось, на /api/health он не отвечает.")
WHO
      echo "Останови его (./run.sh --stop в его каталоге) или задай другой PORT." >&2
      exit 1
    fi
    PORT="$PORT" nohup "$PY" server.py >"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    # ждём, пока порт начнёт отвечать: до 20 секунд по половине секунды
    i=0
    while [ "$i" -lt 40 ]; do
      if "$PY" - "$PORT" <<'PROBE' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PROBE
      then
        VERSION=$("$PY" - "$PORT" 2>/dev/null <<'VER'
import json, sys, urllib.request
try:
    with urllib.request.urlopen("http://127.0.0.1:%s/api/health" % sys.argv[1], timeout=3) as r:
        print(json.load(r).get("version") or "")
except Exception:
    pass
VER
)
        echo "Запущен, pid $(cat "$PIDFILE"), порт $PORT, версия ${VERSION:-неизвестна}. Лог: $LOGFILE"
        if command -v git >/dev/null 2>&1 && [ -d .git ]; then
          REMOTE=$(git ls-remote origin -h refs/heads/main 2>/dev/null | cut -c1-7)
          LOCAL=$(git rev-parse --short=7 HEAD 2>/dev/null)
          if [ -n "$REMOTE" ] && [ -n "$LOCAL" ] && [ "$REMOTE" != "$LOCAL" ]; then
            echo "ВНИМАНИЕ: копия отстала от main ($LOCAL против $REMOTE)." >&2
            echo "Обнови: ./run.sh --stop && git pull --ff-only && ./run.sh --background" >&2
          fi
        fi
        echo "Проверка: curl -s localhost:$PORT/api/health"
        echo "Опубликуй порт $PORT наружу — это и есть ссылка на дашборд."
        exit 0
      fi
      if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Процесс упал при старте. Лог:" >&2
        tail -20 "$LOGFILE" >&2
        rm -f "$PIDFILE"
        exit 1
      fi
      i=$((i + 1))
      sleep 0.5
    done
    echo "Порт $PORT не ответил за 20 секунд. Лог:" >&2
    tail -20 "$LOGFILE" >&2
    exit 1
    ;;
  *)
    exec "$PY" server.py
    ;;
esac

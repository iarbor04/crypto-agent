"""Планировщик внутри сервера: время выбирается в интерфейсе, cron не нужен.

Пропущенные из-за выключенной машины запуски догоняются, а сработавшие слоты
помечаются в data/schedule-state.json, чтобы не запускаться дважды за день.
"""

from __future__ import annotations

import datetime
import threading
import time
from typing import Any, Dict, Optional

from . import store
from .settings import get_settings

TICK_SECONDS = 30
_started = False


def _zone(name: str):
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:
        return datetime.timezone.utc


def now_in(timezone: str) -> Dict[str, Any]:
    now = datetime.datetime.now(_zone(timezone))
    return {"hhmm": now.strftime("%H:%M"), "date": now.strftime("%Y-%m-%d"), "minutes": now.hour * 60 + now.minute}


def _to_minutes(hhmm: str) -> int:
    try:
        hours, minutes = hhmm.split(":")
        return int(hours) * 60 + int(minutes)
    except Exception:
        return 0


def next_run(times, timezone: str) -> Optional[Dict[str, Any]]:
    if not times:
        return None
    now = now_in(timezone)
    ordered = sorted(times)
    upcoming = next((t for t in ordered if _to_minutes(t) > now["minutes"]), None)
    if upcoming:
        return {"at": upcoming, "inMinutes": _to_minutes(upcoming) - now["minutes"], "today": True}
    return {"at": ordered[0], "inMinutes": 1440 - now["minutes"] + _to_minutes(ordered[0]), "today": False}


def _tick() -> None:
    from .agent import run_agent

    schedule = get_settings()["schedule"]
    if not schedule["enabled"] or not schedule["times"]:
        return

    now = now_in(schedule["timezone"])
    state = store.read_json("schedule-state.json", {"fired": {}, "lastRunAt": None}) or {"fired": {}, "lastRunAt": None}
    fired = state.get("fired") or {}

    for slot in schedule["times"]:
        if fired.get(slot) == now["date"]:
            continue
        due = _to_minutes(slot) <= now["minutes"] if schedule["catchUp"] else slot == now["hhmm"]
        if not due:
            continue

        # помечаем слот до запуска: разбор длится минутами, а тик идёт каждые 30 секунд
        fired[slot] = now["date"]
        state["fired"] = fired
        state["lastRunAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        store.write_json("schedule-state.json", state)

        try:
            run = run_agent("cron")
            print(
                "[планировщик] %s %s: портфель $%d, сигналов %d, telegram: %s"
                % (
                    slot,
                    schedule["timezone"],
                    round(run["totalValueUsd"]),
                    len(run["alerts"]),
                    "отправлено" if run["telegram"]["sent"] else run["telegram"].get("error"),
                ),
                flush=True,
            )
        except Exception as e:
            print("[планировщик] %s: разбор упал — %s" % (slot, e), flush=True)


def start_scheduler() -> None:
    global _started
    if _started:
        return
    _started = True

    def loop():
        time.sleep(5)  # первый тик сразу, чтобы догнать пропущенное после перезапуска
        while True:
            try:
                _tick()
            except Exception as e:
                print("[планировщик] ошибка тика: %s" % e, flush=True)
            time.sleep(TICK_SECONDS)

    threading.Thread(target=loop, daemon=True).start()
    print("[планировщик] запущен, проверка каждые %d секунд" % TICK_SECONDS, flush=True)

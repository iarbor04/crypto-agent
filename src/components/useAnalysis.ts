"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Analysis } from "@/lib/types";

// Разбор портфеля стоит несколько секунд и десяток запросов к внешним API, поэтому
// состояние живёт в модуле: переходы между страницами мгновенные, а загрузка одна на всё
// приложение. Компоненты подписываются через useSyncExternalStore — это внешнее состояние,
// а не состояние React.
type State = { data: Analysis | null; error: string | null; loading: boolean };

let state: State = { data: null, error: null, loading: false };
const SERVER_STATE: State = { data: null, error: null, loading: true };

const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): State {
  return state;
}

function getServerSnapshot(): State {
  return SERVER_STATE;
}

export function loadAnalysis(force: boolean): Promise<void> {
  if (!force && (state.data || inflight)) return inflight ?? Promise.resolve();
  setState({ loading: true, error: null });
  inflight = fetch("/api/analysis", { cache: "no-store" })
    .then(async (res) => {
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Не удалось получить анализ");
      setState({ data: json as Analysis, loading: false });
    })
    .catch((err: Error) => {
      setState({ error: err.message, loading: false });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function dropAnalysisCache() {
  state = { ...state, data: null };
}

export function useAnalysis() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    loadAnalysis(false);
  }, []);

  return {
    data: snapshot.data,
    error: snapshot.error,
    loading: snapshot.loading,
    reload: () => loadAnalysis(true),
  };
}

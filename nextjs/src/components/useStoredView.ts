"use client";

import { useSyncExternalStore } from "react";

export type View = "cards" | "table";

const KEY = "signal-view";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): View {
  try {
    return localStorage.getItem(KEY) === "table" ? "table" : "cards";
  } catch {
    return "cards";
  }
}

function getServerSnapshot(): View {
  return "cards";
}

/** Выбранный режим списка живёт в localStorage — это внешнее состояние, не React. */
export function useStoredView(): [View, (next: View) => void] {
  const view = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [
    view,
    (next: View) => {
      try {
        localStorage.setItem(KEY, next);
      } catch {}
      listeners.forEach((l) => l());
    },
  ];
}

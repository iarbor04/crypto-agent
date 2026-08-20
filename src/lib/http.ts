export async function fetchJson<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = 20_000, ...rest } = init ?? {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "crypto-agent/0.1", ...(rest.headers ?? {}) },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url.split("?")[0]}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "crypto-agent/0.1" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${res.status} @ ${url.split("?")[0]}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Ограничитель параллелизма — CoinGecko/Llama не любят пачки запросов. */
export function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

// Разбор портфеля пишет несколько файлов параллельно, поэтому запись
// сериализуется по имени файла: иначе два .tmp дерутся за один rename.
const locks = new Map<string, Promise<unknown>>();
let tmpSeq = 0;

function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    file,
    next.catch(() => {}),
  );
  return next;
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  return withLock(file, async () => {
    await ensureDir();
    const target = path.join(DATA_DIR, file);
    const tmp = `${target}.${process.pid}.${tmpSeq++}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tmp, target);
  });
}

/** Атомарное чтение-изменение-запись: без этого параллельные апдейты теряют записи. */
export async function updateJson<T>(file: string, fallback: T, mutate: (current: T) => T): Promise<T> {
  return withLock(file, async () => {
    const current = await readJson<T>(file, fallback);
    const next = mutate(current);
    await ensureDir();
    const target = path.join(DATA_DIR, file);
    const tmp = `${target}.${process.pid}.${tmpSeq++}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(tmp, target);
    return next;
  });
}

/** Кэш на диске: живёт ttlMs, потом обновляется. Отдаёт старое, если источник упал. */
export async function cached<T>(file: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const box = await readJson<{ at: number; value: T } | null>(file, null);
  if (box && Date.now() - box.at < ttlMs) return box.value;
  try {
    const value = await loader();
    await writeJson(file, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (box) return box.value;
    throw err;
  }
}

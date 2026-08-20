import { readJson, writeJson } from "./store";

export type Settings = {
  botToken: string;
  chatId: string;
  /** присылать сводку даже когда важного ничего нет */
  sendEmptyDigest: boolean;
};

const DEFAULTS: Settings = { botToken: "", chatId: "", sendEmptyDigest: false };

export async function getSettings(): Promise<Settings> {
  const saved = await readJson<Partial<Settings>>("settings.json", {});
  return {
    botToken: saved.botToken || process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: saved.chatId || process.env.TELEGRAM_CHAT_ID || "",
    sendEmptyDigest: saved.sendEmptyDigest ?? DEFAULTS.sendEmptyDigest,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await readJson<Partial<Settings>>("settings.json", {});
  const next = {
    botToken: typeof patch.botToken === "string" ? patch.botToken.trim() : current.botToken ?? "",
    chatId: typeof patch.chatId === "string" ? patch.chatId.trim() : current.chatId ?? "",
    sendEmptyDigest:
      typeof patch.sendEmptyDigest === "boolean" ? patch.sendEmptyDigest : current.sendEmptyDigest ?? false,
  };
  await writeJson("settings.json", next);
  return getSettings();
}

/** Telegram режет сообщения на 4096 символов — бьём по строкам. */
function chunk(text: string, size = 3800): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > size) {
      parts.push(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) parts.push(buf);
  return parts;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type TgChat = { id: number; title?: string; username?: string; first_name?: string; type?: string };

export type BotInfo = { username: string; name: string };
export type ChatCandidate = { id: string; title: string; type: string };

/** Проверка токена без побочных эффектов: если бот жив — вернёт своё имя. */
export async function getBotInfo(token?: string): Promise<{ bot: BotInfo | null; error?: string }> {
  const botToken = token || (await getSettings()).botToken;
  if (!botToken) return { bot: null, error: "Токен бота не задан" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const json = (await res.json()) as { ok?: boolean; description?: string; result?: { username?: string; first_name?: string } };
    if (!json.ok) return { bot: null, error: json.description || `HTTP ${res.status}` };
    return { bot: { username: json.result?.username ?? "", name: json.result?.first_name ?? "" } };
  } catch (err) {
    return { bot: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ищет chat id по последним сообщениям бота — самый частый камень при установке:
 * пользователь не знает, где взять chat id. Достаточно написать боту /start.
 */
export async function detectChats(token?: string): Promise<{ chats: ChatCandidate[]; error?: string }> {
  const botToken = token || (await getSettings()).botToken;
  if (!botToken) return { chats: [], error: "Токен бота не задан" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?limit=100`);
    const json = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: {
        message?: { chat?: TgChat };
        channel_post?: { chat?: TgChat };
      }[];
    };
    if (!json.ok) return { chats: [], error: json.description || `HTTP ${res.status}` };

    const seen = new Map<string, ChatCandidate>();
    for (const u of json.result ?? []) {
      const chat = u.message?.chat ?? u.channel_post?.chat;
      if (!chat) continue;
      const id = String(chat.id);
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        title: chat.title || chat.username || chat.first_name || id,
        type: chat.type === "private" ? "личка" : chat.type === "channel" ? "канал" : chat.type === "group" || chat.type === "supergroup" ? "группа" : (chat.type ?? "чат"),
      });
    }
    return { chats: [...seen.values()].reverse() };
  } catch (err) {
    return { chats: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTelegram(text: string): Promise<{ sent: boolean; error?: string }> {
  const { botToken, chatId } = await getSettings();
  if (!botToken || !chatId) {
    return { sent: false, error: "Не заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (или настройки на странице «Агент»)" };
  }
  try {
    for (const part of chunk(text)) {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: part,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
      });
      const json = (await res.json()) as { ok?: boolean; description?: string };
      if (!json.ok) return { sent: false, error: json.description || `HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

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

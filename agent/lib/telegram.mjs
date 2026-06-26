// Minimal Telegram Bot API helpers (send + long-poll). No dependencies — uses
// global fetch. Both the inbound bot and the dispatcher's notifications use this.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : "";

export function telegramEnabled() {
  return Boolean(TOKEN);
}

/** Send a plain-text message to a chat. No-ops (resolves false) if unconfigured. */
export async function sendMessage(chatId, text) {
  if (!TOKEN || !chatId) return false;
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Register the bot's command menu (the `/`-autocomplete list). `commands` is an
 * array of `{ command, description }`. Pass a `scope` (e.g.
 * `{ type: "all_private_chats" }`) to target a command scope — Telegram resolves
 * a chat's menu most-specific-first (chat > all_private_chats > default), so a
 * populated narrower scope is required or an empty one there shadows `default`.
 * No-ops (resolves false) if unconfigured.
 */
export async function setMyCommands(commands, scope) {
  if (!TOKEN) return false;
  try {
    const res = await fetch(`${API}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scope ? { commands, scope } : { commands }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Long-poll for updates since `offset`. Returns the raw updates array. */
export async function getUpdates(offset, timeout = 25) {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`${API}/getUpdates?timeout=${timeout}&offset=${offset}`, {
    // Telegram holds the request open up to `timeout` seconds; give fetch slack.
    signal: AbortSignal.timeout((timeout + 10) * 1000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`getUpdates failed: ${JSON.stringify(data)}`);
  return data.result;
}

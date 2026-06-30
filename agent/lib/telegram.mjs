// Minimal Telegram Bot API helpers (send + long-poll). No dependencies — uses
// global fetch. Both the inbound bot and the dispatcher's notifications use this.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : "";

export function telegramEnabled() {
  return Boolean(TOKEN);
}

/**
 * Send a message to a chat. `opts.replyMarkup` attaches an inline keyboard (the
 * scout's Yes/No buttons). Returns the sent message object on success (truthy,
 * so existing `if (await sendMessage(...))` callers still work) or false on
 * failure / when unconfigured.
 */
export async function sendMessage(chatId, text, opts = {}) {
  if (!TOKEN || !chatId) return false;
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }),
    });
    const data = await res.json().catch(() => null);
    return res.ok && data && data.ok ? data.result : false;
  } catch {
    return false;
  }
}

/**
 * Acknowledge a tapped inline button — clears its spinner and (optionally) shows
 * a brief toast. Telegram requires this within a few seconds of the callback.
 */
export async function answerCallbackQuery(id, text = "") {
  if (!TOKEN || !id) return false;
  try {
    const res = await fetch(`${API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Replace a message's text (and drop its inline keyboard, since none is sent) —
 * used to stamp a proposal with its outcome (✅ Queued / ❌ Skipped / ⏱ Expired).
 */
export async function editMessageText(chatId, messageId, text) {
  if (!TOKEN || !chatId || !messageId) return false;
  try {
    const res = await fetch(`${API}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
      }),
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

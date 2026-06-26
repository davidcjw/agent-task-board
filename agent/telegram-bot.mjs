#!/usr/bin/env node
// Telegram bot (inbound) — your control surface. Message the bot and it turns
// what you say into a queued task on the board. The dispatcher then claims it,
// reports "picked up by X", and reports the result back to your chat.
//
// Message format:
//   "Refactor the auth module and add tests"      → queued, default agent
//   "[Claude Code] fix the flaky avatar test #bug" → agent "Claude Code", tag "bug"
//   "[commit-push] add a favicon #repo:my-app"     → runs in <AGENT_REPO_BASE>/my-app
//   /id    → replies with this chat's id (set it as TELEGRAM_CHAT_ID for dispatcher notifications)
//
// Requires: TELEGRAM_BOT_TOKEN. Run the board (npm run dev) first.
// Auth: only chats in ALLOWED_CHAT_IDS (comma-separated) — or TELEGRAM_CHAT_ID
// if that's unset — may queue tasks. Set neither only on a trusted network.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addTask } from "./lib/api.mjs";
import { parseMessage } from "./lib/message.mjs";
import { repoFromTags } from "./lib/routes.mjs";
import { getUpdates, sendMessage, telegramEnabled } from "./lib/telegram.mjs";

if (!telegramEnabled()) {
  console.error("Set TELEGRAM_BOT_TOKEN to run the Telegram bot.");
  process.exit(1);
}

const OFFSET_FILE = path.join(process.cwd(), ".data", "tg-offset");

// Sender allowlist. Anyone can find a bot by its username, so the inbound side
// only queues tasks from chats we trust: ALLOWED_CHAT_IDS (comma-separated)
// falling back to TELEGRAM_CHAT_ID (the chat the dispatcher already notifies).
// When neither is set we stay open — documented local/trusted-network mode, the
// same posture as the worker endpoints' AGENT_TOKEN — but warn loudly so an
// exposed bot doesn't silently accept the world.
const ALLOWED_CHATS = new Set(
  (process.env.ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (ALLOWED_CHATS.size === 0) {
  console.warn(
    "⚠️  No ALLOWED_CHAT_IDS / TELEGRAM_CHAT_ID set — the bot will queue tasks from ANY chat. Set one to lock it down.",
  );
}
const isAllowed = (chatId) => ALLOWED_CHATS.size === 0 || ALLOWED_CHATS.has(String(chatId));

function loadOffset() {
  try {
    return Number(readFileSync(OFFSET_FILE, "utf8")) || 0;
  } catch {
    return 0;
  }
}
function saveOffset(o) {
  try {
    mkdirSync(path.dirname(OFFSET_FILE), { recursive: true });
    writeFileSync(OFFSET_FILE, String(o));
  } catch {
    /* ignore */
  }
}

async function handle(message) {
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId || !text) return;

  if (text === "/start" || text === "/help") {
    await sendMessage(
      chatId,
      "Agent Task Board bot.\n\nSend me a task and I'll queue it:\n• \"Refactor auth and add tests\"\n• \"[Claude Code] fix flaky test #bug\"\n• \"[commit-push] add a favicon #repo:my-app\"\n\n#repo:<name> picks which repo a code task runs in.\n/id — show this chat id (set as TELEGRAM_CHAT_ID for dispatch + completion notifications)",
    );
    return;
  }
  if (text === "/id") {
    // Always answerable so a trusted user can discover the id to allowlist.
    await sendMessage(chatId, `This chat id: ${chatId}`);
    return;
  }

  if (!isAllowed(chatId)) {
    await sendMessage(chatId, "🚫 Not authorized to queue tasks on this board.");
    console.warn(`rejected message from chat ${chatId}`);
    return;
  }

  try {
    const input = parseMessage(text);
    const task = await addTask(input);
    const repo = repoFromTags(input.tags);
    const to = input.agent ? ` → ${input.agent}` : "";
    const where = repo ? ` · repo ${repo}` : "";
    await sendMessage(chatId, `📋 Queued "${task.title}"${to}${where}\nid ${task.id.slice(0, 8)}`);
    console.log(`queued "${task.title}" (${task.id})`);
  } catch (e) {
    await sendMessage(chatId, `⚠️ Couldn't queue that: ${e.message}`);
    console.error(e.message);
  }
}

async function main() {
  console.log("telegram bot up · send the bot a message to queue a task");
  let offset = loadOffset();
  for (;;) {
    try {
      const updates = await getUpdates(offset);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) await handle(u.message);
      }
      if (updates.length) saveOffset(offset);
    } catch (e) {
      console.error("poll error:", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

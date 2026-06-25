#!/usr/bin/env node
// Telegram bot (inbound) — your control surface. Message the bot and it turns
// what you say into a queued task on the board. The dispatcher then claims it,
// reports "picked up by X", and reports the result back to your chat.
//
// Message format:
//   "Refactor the auth module and add tests"      → queued, default agent
//   "[Claude Code] fix the flaky avatar test #bug" → agent "Claude Code", tag "bug"
//   /id    → replies with this chat's id (set it as TELEGRAM_CHAT_ID for dispatcher notifications)
//
// Requires: TELEGRAM_BOT_TOKEN. Run the board (npm run dev) first.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addTask } from "./lib/api.mjs";
import { getUpdates, sendMessage, telegramEnabled } from "./lib/telegram.mjs";

if (!telegramEnabled()) {
  console.error("Set TELEGRAM_BOT_TOKEN to run the Telegram bot.");
  process.exit(1);
}

const OFFSET_FILE = path.join(process.cwd(), ".data", "tg-offset");

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

function parseMessage(text) {
  let agent = "";
  let body = text.trim();
  const bracket = body.match(/^\[([^\]]+)\]\s*/);
  if (bracket) {
    agent = bracket[1].trim();
    body = body.slice(bracket[0].length).trim();
  }
  const tags = [...body.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
  const title = (body.split("\n")[0] || "task").replace(/\s+/g, " ").slice(0, 80);
  return { title, prompt: body, agent, tags, status: "queued" };
}

async function handle(message) {
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId || !text) return;

  if (text === "/start" || text === "/help") {
    await sendMessage(
      chatId,
      "Agent Task Board bot.\n\nSend me a task and I'll queue it:\n• \"Refactor auth and add tests\"\n• \"[Claude Code] fix flaky test #bug\"\n\n/id — show this chat id (set as TELEGRAM_CHAT_ID for dispatch + completion notifications)",
    );
    return;
  }
  if (text === "/id") {
    await sendMessage(chatId, `This chat id: ${chatId}`);
    return;
  }

  try {
    const input = parseMessage(text);
    const task = await addTask(input);
    const to = input.agent ? ` → ${input.agent}` : "";
    await sendMessage(chatId, `📋 Queued "${task.title}"${to}\nid ${task.id.slice(0, 8)}`);
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

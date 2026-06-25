#!/usr/bin/env node
// merge-watcher — moves Review tasks to Done once their PR is merged.
//
// For each task in Review whose result contains a GitHub PR URL, it asks `gh`
// whether that PR is merged; if so it moves the task to Done and pings Telegram.
// It only calls `gh` when a Review task actually carries a PR URL, so it stays
// quiet (no auth prompts, no API calls) until there's something to watch.
//
// Interval: 30s by default. Configure it in .env (WATCHER_INTERVAL, ms) or with
// --interval. See .env.example.
//
//   node agent/merge-watcher.mjs               # poll forever
//   node agent/merge-watcher.mjs --once        # one sweep and exit
//   node agent/merge-watcher.mjs --interval 60000

import { getBoard, moveTask } from "./lib/api.mjs";
import { extractPrUrl, isMerged, prState } from "./lib/prs.mjs";
import { sendMessage, telegramEnabled } from "./lib/telegram.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const ONCE = has("--once");
const INTERVAL = Number(val("--interval", process.env.WATCHER_INTERVAL || "30000"));
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function notify(text) {
  if (telegramEnabled() && CHAT_ID) await sendMessage(CHAT_ID, text);
}

async function sweep() {
  const board = await getBoard();
  for (const id of board.columns.review || []) {
    const task = board.tasks[id];
    if (!task) continue;
    const url = extractPrUrl(task.result);
    if (!url) continue; // no PR on this card → nothing to watch
    const info = await prState(url);
    if (info.error) {
      console.error(`gh check failed for ${url}: ${info.error}`);
      continue;
    }
    if (isMerged(info)) {
      await moveTask(id, "done");
      console.log(`✓ merged → Done: "${task.title}" (${url})`);
      await notify(`🎉 Merged → Done "${task.title}"\n${url}`);
    }
  }
}

async function main() {
  console.log(
    `merge-watcher up · every ${INTERVAL}ms${telegramEnabled() && CHAT_ID ? " · telegram on" : ""}`,
  );
  for (;;) {
    try {
      await sweep();
    } catch (e) {
      console.error("sweep error:", e.message);
    }
    if (ONCE) break;
    await sleep(INTERVAL);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

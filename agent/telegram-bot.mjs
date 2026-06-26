#!/usr/bin/env node
// Telegram bot (inbound) — your control surface. Message the bot and it turns
// what you say into a queued task on the board. The dispatcher then claims it,
// reports "picked up by X", and reports the result back to your chat.
//
// Message format:
//   "Refactor the auth module and add tests"       → queued, default agent
//   "[Claude Code] fix the flaky avatar test #bug" → agent "Claude Code", tag "bug"
//   "/democratizing_claude add a favicon"          → runs in <AGENT_REPO_BASE>/democratizing-claude
//   "/use democratizing_claude"                    → make that repo this chat's default
//   "/id"                                          → replies with this chat's id
//
// A leading `/slug` (hyphens optional — `/democratizing_claude` matches the dir
// `democratizing-claude`) picks the repo for one task; `/use <repo>` makes it
// sticky so plain messages inherit it. Repos are matched against AGENT_REPO_BASE
// (~/code), and registered as `/`-menu commands on startup.
//
// Requires: TELEGRAM_BOT_TOKEN. Run the board (npm run dev) first.
// Auth: only chats in ALLOWED_CHAT_IDS (comma-separated) — or TELEGRAM_CHAT_ID
// if that's unset — may queue tasks. Set neither only on a trusted network.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addTask } from "./lib/api.mjs";
import { parseMessage } from "./lib/message.mjs";
import { listRepos } from "./lib/repos.mjs";
import { matchRepoSlug, repoCommandName, repoFromTags } from "./lib/routes.mjs";
import { getUpdates, sendMessage, setMyCommands, telegramEnabled } from "./lib/telegram.mjs";

if (!telegramEnabled()) {
  console.error("Set TELEGRAM_BOT_TOKEN to run the Telegram bot.");
  process.exit(1);
}

const OFFSET_FILE = path.join(process.cwd(), ".data", "tg-offset");
const REPOS_FILE = path.join(process.cwd(), ".data", "tg-repos.json");

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

// Per-chat sticky repo (the `/use` default): chatId → resolved repo name.
function loadDefaults() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(REPOS_FILE, "utf8"))));
  } catch {
    return new Map();
  }
}
const defaults = loadDefaults();
const getDefault = (chatId) => defaults.get(String(chatId)) || "";
function setDefault(chatId, repo) {
  if (repo) defaults.set(String(chatId), repo);
  else defaults.delete(String(chatId));
  try {
    mkdirSync(path.dirname(REPOS_FILE), { recursive: true });
    writeFileSync(REPOS_FILE, JSON.stringify(Object.fromEntries(defaults), null, 2));
  } catch {
    /* ignore */
  }
}

// A friendly reply when a typed slug doesn't resolve to exactly one repo.
function noRepoMatchMsg(slug, candidates) {
  if (candidates && candidates.length > 1) {
    return `🤔 "${slug}" matches several repos: ${candidates.join(", ")}. Use the exact name.`;
  }
  const all = listRepos();
  const list = all.length ? all.slice(0, 20).join(", ") : "(none found under the repo base)";
  return `❓ No repo matches "${slug}" under the repo base.\nAvailable: ${list}`;
}

const HELP =
  "Agent Task Board bot.\n\n" +
  "Send a task and I'll queue it:\n" +
  '• "Refactor auth and add tests"\n' +
  '• "[Claude Code] fix flaky test #bug"\n\n' +
  "Pick the repo a code task runs in:\n" +
  "• /democratizing_claude fix login  (one-off — type / for the menu)\n" +
  "• /use democratizing_claude  → make it the default, then just send tasks\n" +
  "• /use  → show it · /use off  → clear it\n\n" +
  "/id — show this chat id (set as TELEGRAM_CHAT_ID for notifications)";

async function handle(message) {
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId || !text) return;

  if (text === "/start" || text === "/help") {
    await sendMessage(chatId, HELP);
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

  // /use — manage this chat's sticky default repo.
  if (text === "/use" || text.startsWith("/use ")) {
    const arg = text.slice(4).trim();
    if (!arg) {
      const cur = getDefault(chatId);
      await sendMessage(
        chatId,
        cur
          ? `📌 Active repo: ${cur}\n/use <repo> to switch · /use off to clear`
          : "No active repo set.\n/use <repo> to set one, then plain messages run there.",
      );
      return;
    }
    if (["off", "none", "clear", "-"].includes(arg.toLowerCase())) {
      setDefault(chatId, "");
      await sendMessage(chatId, "🧹 Active repo cleared. Tag a repo with /<repo> or #repo:<name>.");
      return;
    }
    const { match, candidates } = matchRepoSlug(arg, listRepos());
    if (!match) {
      await sendMessage(chatId, noRepoMatchMsg(arg, candidates));
      return;
    }
    setDefault(chatId, match);
    await sendMessage(chatId, `📌 Active repo set to ${match}. Plain messages now run there.`);
    return;
  }

  try {
    const input = parseMessage(text);

    // Which repo this task targets: a leading /slug wins (resolved against the
    // repo base), else an explicit #repo: tag, else the chat's sticky default.
    let repo = "";
    if (input.repoSlug) {
      const { match, candidates } = matchRepoSlug(input.repoSlug, listRepos());
      if (!match) {
        await sendMessage(chatId, noRepoMatchMsg(input.repoSlug, candidates));
        return;
      }
      repo = match;
      // A bare /slug with no task = "switch my active repo" (tap-to-switch from
      // the command menu), not an empty task.
      if (!input.prompt.trim()) {
        setDefault(chatId, repo);
        await sendMessage(chatId, `📌 Active repo set to ${repo}. Plain messages now run there.`);
        return;
      }
    } else {
      repo = repoFromTags(input.tags) || getDefault(chatId);
    }

    // Rebuild tags with a single authoritative repo: tag.
    const tags = input.tags.filter((t) => !t.startsWith("repo:"));
    if (repo) tags.push(`repo:${repo}`);

    const task = await addTask({
      title: input.title,
      prompt: input.prompt,
      agent: input.agent,
      tags,
      status: "queued",
    });
    const to = input.agent ? ` → ${input.agent}` : "";
    const where = repo ? ` · repo ${repo}` : "";
    await sendMessage(chatId, `📋 Queued "${task.title}"${to}${where}\nid ${task.id.slice(0, 8)}`);
    console.log(`queued "${task.title}" (${task.id})`);
  } catch (e) {
    await sendMessage(chatId, `⚠️ Couldn't queue that: ${e.message}`);
    console.error(e.message);
  }
}

// Register the `/`-autocomplete menu: reserved commands + one per repo under the
// repo base (hyphens → underscores; Telegram caps names at 32 chars, list at 100).
async function syncCommands() {
  const reserved = [
    { command: "use", description: "Set / show the active repo (/use <repo>, /use off)" },
    { command: "id", description: "Show this chat id" },
    { command: "help", description: "How to use this bot" },
  ];
  const seen = new Set(reserved.map((c) => c.command));
  const repoCmds = [];
  for (const name of listRepos()) {
    const command = repoCommandName(name);
    if (!command || seen.has(command)) continue; // skip empties + reserved collisions
    seen.add(command);
    repoCmds.push({ command, description: `repo · ${name}`.slice(0, 256) });
  }
  const commands = [...reserved, ...repoCmds].slice(0, 100);
  // Write both the default scope and all_private_chats. The bot lives in DMs,
  // where all_private_chats out-ranks default — if it's left empty (e.g. by a
  // prior run of a shared bot) the menu shows nothing despite default being set.
  const ok = await setMyCommands(commands);
  const okDm = await setMyCommands(commands, { type: "all_private_chats" });
  console.log(
    ok && okDm
      ? `registered ${commands.length} commands (${repoCmds.length} repos) — type / in Telegram to pick one`
      : "could not register bot commands (continuing)",
  );
}

async function main() {
  console.log("telegram bot up · send the bot a message to queue a task");
  await syncCommands();
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

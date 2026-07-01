#!/usr/bin/env node
// Telegram bot (inbound) — your control surface. Message the bot and it turns
// what you say into a queued task on the board. The dispatcher then claims it,
// reports "picked up by X", and reports the result back to your chat. It also
// fields the Improvement Scout's Yes/No buttons (handleCallback): ✅ queues the
// parked proposal, ❌ discards it (see lib/pending.mjs + agent/scout.mjs).
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

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addTask, cancelTask, getBoard } from "./lib/api.mjs";
import {
  cancelKeyboard,
  cancelPickerText,
  matchRunningTask,
  parseCancelCallback,
} from "./lib/cancel.mjs";
import { parseMessage } from "./lib/message.mjs";
import { clearPending, readPending } from "./lib/pending.mjs";
import { listRepos } from "./lib/repos.mjs";
import { matchRepoSlug, repoCommandName, repoFromTags } from "./lib/routes.mjs";
import { readMemory, recordAccepted, writeMemory } from "./lib/scout-memory.mjs";
import { parseCallback, proposalActive } from "./lib/scout.mjs";
import {
  answerCallbackQuery,
  editMessageText,
  getUpdates,
  sendMessage,
  setMyCommands,
  telegramEnabled,
} from "./lib/telegram.mjs";

if (!telegramEnabled()) {
  console.error("Set TELEGRAM_BOT_TOKEN to run the Telegram bot.");
  process.exit(1);
}

const OFFSET_FILE = path.join(process.cwd(), ".data", "tg-offset");
const REPOS_FILE = path.join(process.cwd(), ".data", "tg-repos.json");
const SCOUT_SCRIPT = fileURLToPath(new URL("./scout.mjs", import.meta.url));

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
  "Stop work in flight:\n" +
  "• /cancel  → cancel the running task (or pick one if several)\n" +
  "• /cancel <id>  → cancel by id · /cancel all  → cancel everything\n\n" +
  "Hunt for improvements now:\n" +
  "• /scout  → scan ~/code and propose the top idea (/scout full for a full sweep)\n\n" +
  "/id — show this chat id (set as TELEGRAM_CHAT_ID for notifications)";

// The board's currently-running tasks (the cancel candidates).
async function runningTasks() {
  const board = await getBoard();
  return (board.columns?.running || []).map((id) => board.tasks[id]).filter(Boolean);
}

// Fire a cancel request for one task and confirm. The dispatcher does the actual
// kill on its next poll, then moves the card to Done.
async function doCancel(chatId, task) {
  try {
    await cancelTask(task.id);
    await sendMessage(chatId, `🛑 Cancelling "${task.title}" (id ${task.id.slice(0, 8)})… it'll move to Done shortly.`);
  } catch (e) {
    await sendMessage(chatId, `⚠️ Couldn't cancel "${task.title}": ${e.message}`);
  }
}

// /cancel dispatch: bare (one → cancel, many → picker), <id-prefix>, or `all`.
async function handleCancel(chatId, arg) {
  let running;
  try {
    running = await runningTasks();
  } catch (e) {
    await sendMessage(chatId, `⚠️ Couldn't reach the board: ${e.message}`);
    return;
  }
  if (!running.length) {
    await sendMessage(chatId, "Nothing is running right now.");
    return;
  }
  if (arg.toLowerCase() === "all") {
    let ok = 0;
    for (const t of running) {
      try {
        await cancelTask(t.id);
        ok++;
      } catch {
        /* skip one that already finished */
      }
    }
    await sendMessage(chatId, `🛑 Cancelling ${ok}/${running.length} running task(s)… they'll move to Done.`);
    return;
  }
  if (arg) {
    const { match, candidates } = matchRunningTask(running, arg);
    if (!match) {
      await sendMessage(
        chatId,
        candidates.length > 1
          ? `🤔 "${arg}" matches ${candidates.length} running tasks — use more of the id.`
          : `❓ No running task id starts with "${arg}".`,
      );
      return;
    }
    await doCancel(chatId, match);
    return;
  }
  if (running.length === 1) {
    await doCancel(chatId, running[0]);
    return;
  }
  await sendMessage(chatId, cancelPickerText(running), { replyMarkup: cancelKeyboard(running) });
}

// One in-flight on-demand scout at a time (the scheduled launchd run is separate;
// the pending-proposal file keeps the two from stepping on each other).
let scoutChild = null;

// /scout — run the Improvement Scout on demand. It scans ~/code, ranks ideas, and
// (if it finds one) sends its OWN Yes/No proposal — handleCallback fields the tap,
// exactly like the scheduled launchd run. We only launch it and report what came
// of it: either a proposal message lands, or it comes back empty.
async function handleScout(chatId, arg) {
  if (scoutChild) {
    await sendMessage(chatId, "🔭 Scout is already running — hang tight.");
    return;
  }
  const before = readPending();
  if (proposalActive(before, Date.now())) {
    await sendMessage(chatId, "🔭 A scout idea is already waiting for your Yes/No — answer that one first.");
    return;
  }
  const full = arg.trim().toLowerCase() === "full";
  await sendMessage(
    chatId,
    `🔭 Scanning ~/code for improvements${full ? " (full sweep)" : ""}… I'll send the top idea when it's ready.`,
  );
  // Plain /scout stays cheap: --incremental suppresses the 24h auto-full-sweep so
  // an on-demand tap never blows up into a ~30-min all-repo scan (the scheduler and
  // /scout full own full sweeps). /scout full opts into one explicitly.
  const scriptArgs = [SCOUT_SCRIPT, full ? "--full" : "--incremental"];
  let child;
  try {
    child = spawn(process.execPath, scriptArgs, { cwd: process.cwd(), env: process.env });
  } catch (e) {
    await sendMessage(chatId, `⚠️ Couldn't start the scout: ${e.message}`);
    return;
  }
  scoutChild = child;
  child.stdout.on("data", (d) => process.stdout.write(`[scout] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[scout] ${d}`));
  child.on("error", async (e) => {
    scoutChild = null;
    await sendMessage(chatId, `⚠️ Scout failed to start: ${e.message}`);
  });
  child.on("close", async (code) => {
    scoutChild = null;
    // If the scout parked a fresh proposal, its own message already reached you —
    // stay quiet. Otherwise it either found nothing or errored.
    const after = readPending();
    if (proposalActive(after, Date.now()) && (!before || after.id !== before.id)) return;
    await sendMessage(
      chatId,
      code === 0
        ? "🔭 Scout finished — nothing new worth proposing right now."
        : `⚠️ Scout exited with an error (code ${code}). Check the logs.`,
    );
  });
}

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

  // /cancel — stop a running task. Bare: one running → cancel it, many → a picker.
  // /cancel <id-prefix> targets one; /cancel all stops every running task.
  if (text === "/cancel" || text.startsWith("/cancel ")) {
    await handleCancel(chatId, text.slice(7).trim());
    return;
  }

  // /scout — kick off the Improvement Scout now (/scout full for a full sweep).
  if (text === "/scout" || text.startsWith("/scout ")) {
    await handleScout(chatId, text.slice(6).trim());
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

// A tapped scout Yes/No button. We park exactly one proposal at a time, so a tap
// is honored only when its id matches the current pending offer; a stale tap (the
// proposal expired, was already answered, or superseded) gets a gentle "no longer
// active". ✅ queues the parked task; ❌ discards it. Either way the message is
// stamped with the outcome and its buttons drop away.
async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const base = cb.message?.text || "🔭 Scout proposal";

  // A tap on a /cancel picker button.
  const cancelHit = parseCancelCallback(cb.data);
  if (cancelHit) {
    if (!isAllowed(chatId)) {
      await answerCallbackQuery(cb.id, "🚫 Not authorized.");
      return;
    }
    try {
      const task = await cancelTask(cancelHit.id);
      await answerCallbackQuery(cb.id, "Cancelling…");
      await editMessageText(chatId, messageId, `${base}\n\n🛑 Cancelling "${task.title}" — moving to Done.`);
    } catch (e) {
      await answerCallbackQuery(cb.id, "Couldn't cancel.");
      await editMessageText(chatId, messageId, `${base}\n\n⚠️ ${e.message} (already finished?)`);
    }
    return;
  }

  const parsed = parseCallback(cb.data);
  if (!parsed) {
    await answerCallbackQuery(cb.id);
    return;
  }
  if (!isAllowed(chatId)) {
    await answerCallbackQuery(cb.id, "🚫 Not authorized.");
    return;
  }
  const pending = readPending();
  if (!pending || pending.id !== parsed.id) {
    await answerCallbackQuery(cb.id, "This proposal is no longer active.");
    await editMessageText(chatId, messageId, `${base}\n\n⏱ No longer active.`);
    return;
  }
  if (parsed.action === "no") {
    clearPending();
    await answerCallbackQuery(cb.id, "Skipped — nothing queued.");
    await editMessageText(chatId, messageId, `${base}\n\n❌ Skipped — nothing queued.`);
    console.log(`scout proposal ${pending.id} skipped`);
    return;
  }
  try {
    const task = await addTask(pending.task);
    clearPending();
    // ✅ accept is the only thing that permanently retires a scout idea — record
    // it so it's never re-proposed (best-effort; a memory hiccup must not fail the
    // queue). A ❌/ignore records nothing, leaving the idea free to resurface.
    if (pending.ideaKey) {
      try {
        const repo = repoFromTags(pending.task?.tags || []);
        writeMemory(
          recordAccepted(readMemory(), pending.ideaKey, { repo, title: pending.task?.title || "", now: Date.now() }),
        );
      } catch {
        /* memory is advisory */
      }
    }
    await answerCallbackQuery(cb.id, "Queued ✅");
    await editMessageText(chatId, messageId, `${base}\n\n✅ Queued to the board (id ${task.id.slice(0, 8)}).`);
    console.log(`scout proposal ${pending.id} → queued ${task.id}`);
  } catch (e) {
    await answerCallbackQuery(cb.id, "Couldn't queue.");
    await editMessageText(chatId, messageId, `${base}\n\n⚠️ Couldn't queue: ${e.message}`);
    console.error(`scout proposal queue failed: ${e.message}`);
  }
}

// Register the `/`-autocomplete menu: reserved commands + one per repo under the
// repo base (hyphens → underscores; Telegram caps names at 32 chars, list at 100).
async function syncCommands() {
  const reserved = [
    { command: "use", description: "Set / show the active repo (/use <repo>, /use off)" },
    { command: "cancel", description: "Cancel a running task (/cancel, /cancel <id>, /cancel all)" },
    { command: "scout", description: "Scan ~/code for improvements now (/scout, /scout full)" },
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
        else if (u.callback_query) await handleCallback(u.callback_query);
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

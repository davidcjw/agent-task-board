#!/usr/bin/env node
// launch.mjs — bring up the whole agent control plane with one command:
//   board server (api mode) → dispatcher → (Telegram bot, if a token is set).
//
// It waits for the board to be ready before starting the workers, streams
// colour-prefixed output from every process, and shuts them all down cleanly on
// Ctrl-C (or if any one of them dies). This is what `npm run agents` runs.
//
// The built-in Telegram bot is OFF by default — use an external front door (e.g.
// hans / telegram-claude-agent) for inbound, and the dispatcher still posts
// results to your chat. Pass --telegram to also run the built-in bot.
//
// Usage:
//   npm run agents                  # board + dispatcher (dry-run); no built-in bot
//   npm run agents -- --execute     # let the dispatcher actually run runners
//   npm run agents -- --telegram    # also run the built-in inbound bot (needs a token)
//   npm run agents -- --prod        # serve a production build (run `npm run build` first)
//   npm run agents -- --no-board    # attach to an already-running board (BOARD_URL)

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const EXECUTE = has("--execute") || process.env.AGENT_EXECUTE === "1";
const PROD = has("--prod");
const WITH_TELEGRAM = has("--telegram"); // built-in inbound bot is opt-in
const NO_BOARD = has("--no-board");
const HAS_TELEGRAM = WITH_TELEGRAM && Boolean(process.env.TELEGRAM_BOT_TOKEN);

const BOARD_URL = (process.env.BOARD_URL || "http://localhost:3000").replace(/\/$/, "");
const READY_URL = `${BOARD_URL}/api/board`;

// --- pretty, labelled output ----------------------------------------------
const COLORS = { board: 36, dispatch: 33, telegram: 35, sys: 32 };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const tag = (name) => paint(COLORS[name] || 37, name.padEnd(8));
const emit = (name, line) => process.stdout.write(`${tag(name)} │ ${line}\n`);
const sys = (line) => emit("sys", line);

function pipeLines(name, stream) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) if (l.length) emit(name, l);
  });
  stream.on("end", () => {
    if (buf.trim()) emit(name, buf);
  });
}

// --- child process registry ------------------------------------------------
const children = [];
let shuttingDown = false;

function start(name, command, cmdArgs, env = process.env) {
  const child = spawn(command, cmdArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push({ name, child });
  pipeLines(name, child.stdout);
  pipeLines(name, child.stderr);
  child.on("error", (e) => {
    sys(`"${name}" failed to start: ${e.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    sys(`"${name}" exited (${signal || code}) — shutting everything down.`);
    shutdown(code || 0);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  sys("stopping…");
  const alive = children.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  if (alive.length === 0) process.exit(code);
  let remaining = alive.length;
  for (const { child } of alive) {
    child.once("exit", () => {
      if (--remaining <= 0) process.exit(code);
    });
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    for (const { child } of alive) if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 5000);
  force.unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForBoard(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (shuttingDown) return false;
    try {
      const res = await fetch(READY_URL);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  sys(`agent control plane · ${EXECUTE ? "EXECUTE" : "dry-run"}${HAS_TELEGRAM ? " · telegram" : ""}`);

  if (!NO_BOARD) {
    const nextBin = path.join(process.cwd(), "node_modules", ".bin", "next");
    sys(`starting board (next ${PROD ? "start" : "dev"}, api mode) → ${BOARD_URL}`);
    start("board", nextBin, [PROD ? "start" : "dev"], { ...process.env, NEXT_PUBLIC_BOARD_MODE: "api" });
  } else {
    sys(`attaching to existing board at ${BOARD_URL}`);
  }

  sys("waiting for the board to be ready…");
  if (!(await waitForBoard())) {
    if (!shuttingDown) {
      sys(`board never became ready at ${READY_URL} — giving up.`);
      shutdown(1);
    }
    return;
  }
  sys("board is up.");

  const dispatcherArgs = ["agent/dispatcher.mjs"];
  if (EXECUTE) dispatcherArgs.push("--execute");
  start("dispatch", process.execPath, dispatcherArgs);

  if (WITH_TELEGRAM && !process.env.TELEGRAM_BOT_TOKEN) {
    sys("--telegram given but no TELEGRAM_BOT_TOKEN — skipping the built-in bot.");
  } else if (HAS_TELEGRAM) {
    start("telegram", process.execPath, ["agent/telegram-bot.mjs"]);
  } else {
    sys("built-in bot off — use your external bot (e.g. hans) for inbound; pass --telegram to run it here.");
  }

  sys("control plane up. Ctrl-C to stop everything.");
}

main().catch((e) => {
  sys(`fatal: ${e.message}`);
  shutdown(1);
});

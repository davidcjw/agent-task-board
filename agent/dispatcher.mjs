#!/usr/bin/env node
// Dispatcher — watches the queue, claims tasks, routes each to the right runner
// by its `agent` label, runs it, and reports back to the board (→ Review) and
// to Telegram ("picked up by X" then "done / failed").
//
// SAFETY: dry-run by default. It only executes runner commands when you pass
// --execute (or set AGENT_EXECUTE=1). In dry-run it just reports the command it
// would have run, so nothing touches your repos until you opt in.
//
// Usage:
//   node agent/dispatcher.mjs                 # poll forever, dry-run
//   node agent/dispatcher.mjs --once          # drain the queue once and exit
//   node agent/dispatcher.mjs --execute       # actually run the runner commands
//   node agent/dispatcher.mjs --agent "Claude Code"   # only claim that agent's tasks

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { claimNext, reportResult } from "./lib/api.mjs";
import { sendMessage, telegramEnabled } from "./lib/telegram.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const ONCE = has("--once");
const EXECUTE = has("--execute") || process.env.AGENT_EXECUTE === "1";
const INTERVAL = Number(val("--interval", process.env.AGENT_INTERVAL || "3000"));
const TIMEOUT = Number(process.env.AGENT_TIMEOUT || "1200000"); // 20 min
const WORKER = val("--worker", process.env.AGENT_WORKER || "dispatcher");
const AGENT_FILTER = val("--agent", "") || undefined;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const ROUTES = loadRoutes();

function loadRoutes() {
  const file = process.env.AGENT_ROUTES || path.join(process.cwd(), "agent", "routes.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Fall back to the committed example.
    const example = path.join(process.cwd(), "agent", "routes.example.json");
    try {
      return JSON.parse(readFileSync(example, "utf8"));
    } catch {
      return { default: { command: "echo", args: ["No routes configured for: {title}"], cwd: "." } };
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fill = (s, task) =>
  s
    .replaceAll("{prompt}", task.prompt || "")
    .replaceAll("{title}", task.title || "")
    .replaceAll("{id}", task.id)
    .replaceAll("{agent}", task.agent || "")
    .replaceAll("{tags}", (task.tags || []).join(","));

function routeFor(task) {
  return ROUTES[task.agent] || ROUTES.default || null;
}

async function notify(text) {
  if (telegramEnabled() && CHAT_ID) await sendMessage(CHAT_ID, text);
}

function runCommand(route, task) {
  return new Promise((resolve) => {
    const cmdArgs = (route.args || []).map((a) => fill(a, task));
    const child = spawn(route.command, cmdArgs, {
      cwd: path.resolve(process.cwd(), route.cwd || "."),
      env: process.env,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ result: `Failed to start "${route.command}": ${e.message}`, error: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = out.trim();
      let error = code !== 0;
      // claude --output-format json → { result, is_error }
      try {
        const json = JSON.parse(out);
        if (json && typeof json.result === "string") {
          result = json.result;
          error = error || Boolean(json.is_error);
        }
      } catch {
        /* not JSON — use raw stdout */
      }
      if (!result) result = err.trim() || `(no output, exit ${code})`;
      resolve({ result, error });
    });
  });
}

async function processTask(task) {
  const route = routeFor(task);
  const label = task.agent || "default";
  console.log(`▶ claimed "${task.title}" → ${label}`);
  await notify(`🟢 Picked up "${task.title}"\n→ dispatched to ${label}`);

  let outcome;
  if (!EXECUTE) {
    const preview = route ? `${route.command} ${(route.args || []).map((a) => fill(a, task)).join(" ")}` : "no runner";
    outcome = { result: `[dry-run] would run:\n${preview}`, error: false };
  } else if (!route) {
    outcome = { result: `No runner configured for agent "${task.agent}".`, error: true };
  } else {
    outcome = await runCommand(route, task);
  }

  await reportResult(task.id, { result: outcome.result, error: outcome.error, status: "review" });
  const head = outcome.error ? `❌ Failed "${task.title}"` : `✅ Done "${task.title}" by ${label}`;
  const snippet = outcome.result.length > 500 ? outcome.result.slice(0, 500) + "…" : outcome.result;
  console.log(`${outcome.error ? "✗" : "✓"} ${task.title}`);
  await notify(`${head}\n\n${snippet}\n\n(in Review for your approval)`);
}

async function main() {
  console.log(
    `dispatcher up · ${EXECUTE ? "EXECUTE" : "dry-run"} · worker=${WORKER}` +
      `${AGENT_FILTER ? ` · agent=${AGENT_FILTER}` : ""}` +
      `${telegramEnabled() && CHAT_ID ? " · telegram on" : ""}`,
  );
  for (;;) {
    let task = null;
    try {
      task = await claimNext({ worker: WORKER, agent: AGENT_FILTER });
    } catch (e) {
      console.error("claim error:", e.message);
      await sleep(INTERVAL);
      continue;
    }
    if (!task) {
      if (ONCE) break;
      await sleep(INTERVAL);
      continue;
    }
    try {
      await processTask(task);
    } catch (e) {
      console.error("process error:", e.message);
      try {
        await reportResult(task.id, { result: `Dispatcher error: ${e.message}`, error: true });
      } catch {
        /* board unreachable */
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

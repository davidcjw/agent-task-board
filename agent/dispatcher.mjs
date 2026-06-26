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
import os from "node:os";
import path from "node:path";
import { claimNext, reportResult } from "./lib/api.mjs";
import { finishPr, preflight, restore, startBranch } from "./lib/git.mjs";
import { extractPrUrl } from "./lib/prs.mjs";
import {
  branchName,
  implementPrompt,
  missingRepoTag,
  repoFromTags,
  resolveCwd,
  shouldOpenPr,
} from "./lib/routes.mjs";
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
// Base dir for `repo:<name>` tags — a route's "{repo}" cwd resolves under here.
const REPO_BASE = process.env.AGENT_REPO_BASE || path.join(os.homedir(), "code");

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
    const cwd = resolveCwd(route, task, { base: REPO_BASE, cwdBase: process.cwd() });
    if (missingRepoTag(route, task))
      console.warn(`⚠ no repo: tag on "${task.title}" — running in ${cwd}`);
    const child = spawn(route.command, cmdArgs, { cwd, env: process.env });
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

// Run the agent (edits only), then the dispatcher itself branches, commits,
// pushes, and opens the PR — so a finished task is already a reviewable PR.
async function runWithPr(route, runTask, task) {
  const cwd = resolveCwd(route, runTask, { base: REPO_BASE, cwdBase: process.cwd() });
  const branch = branchName(task);

  const pf = await preflight(cwd);
  if (!pf.ok) return { result: `PR aborted: ${pf.error}`, error: true };

  const created = await startBranch(cwd, branch);
  if (!created.ok) return { result: `PR aborted: couldn't create branch ${branch}: ${created.error}`, error: true };

  try {
    const agent = await runCommand(route, runTask);
    const fin = await finishPr(cwd, { branch, base: pf.base, title: task.title });
    if (fin.error) return { result: `${agent.result}\n\n⚠ PR step failed: ${fin.error}`, error: true };
    if (fin.noChanges) return { result: `${agent.result}\n\n(no file changes — no PR opened)`, error: agent.error };
    console.log(`  ↳ opened PR ${fin.url}`);
    return { result: `${agent.result}\n\nBOARD_PR: ${fin.url}`, error: agent.error };
  } finally {
    await restore(cwd, pf.base);
  }
}

function dryRunPreview(route, runTask, opensPr) {
  if (!route) return "[dry-run] no runner configured";
  const cwd = resolveCwd(route, runTask, { base: REPO_BASE, cwdBase: process.cwd() });
  const cmd = `${route.command} ${(route.args || []).map((a) => fill(a, runTask)).join(" ")}`;
  let preview = `[dry-run] would run:\n(cwd: ${cwd})\n${cmd}`;
  if (opensPr) preview += `\nthen: git checkout -b ${branchName(runTask)} → commit → push → gh pr create --fill`;
  return preview;
}

async function processTask(task) {
  const route = routeFor(task);
  const label = task.agent || "default";
  // Code routes (pr:true) that target a repo get the dispatcher-driven PR flow:
  // the agent only edits, then we branch/commit/push/PR before Review.
  const opensPr = route ? shouldOpenPr(route, task) : false;
  const runTask = opensPr ? { ...task, prompt: implementPrompt(task.prompt) } : task;
  const prNote = opensPr ? ` (→ PR in ${repoFromTags(task.tags)})` : "";
  console.log(`▶ claimed "${task.title}" → ${label}${prNote}`);
  await notify(`🟢 Picked up "${task.title}"\n→ dispatched to ${label}${prNote}`);

  let outcome;
  if (!EXECUTE) {
    outcome = { result: dryRunPreview(route, runTask, opensPr), error: false };
  } else if (!route) {
    outcome = { result: `No runner configured for agent "${task.agent}".`, error: true };
  } else if (opensPr) {
    outcome = await runWithPr(route, runTask, task);
  } else {
    outcome = await runCommand(route, runTask);
  }

  await reportResult(task.id, { result: outcome.result, error: outcome.error, status: "review" });
  const head = outcome.error ? `❌ Failed "${task.title}"` : `✅ Done "${task.title}" by ${label}`;
  // Surface the PR link as its own line (Telegram auto-links it) so it's always
  // clickable — never lost to the snippet cap — and drop the raw BOARD_PR marker.
  const prUrl = extractPrUrl(outcome.result);
  const prLine = prUrl ? `\n🔗 Review PR: ${prUrl}` : "";
  const body = outcome.result.replace(/\n*BOARD_PR:\s*\S+/g, "").trim();
  const snippet = body.length > 500 ? body.slice(0, 500) + "…" : body;
  console.log(`${outcome.error ? "✗" : "✓"} ${task.title}${prUrl ? ` → ${prUrl}` : ""}`);
  await notify(`${head}${prLine}\n\n${snippet}\n\n(in Review for your approval)`);
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

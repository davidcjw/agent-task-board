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
import { createWorktree, finishPr, removeWorktree } from "./lib/git.mjs";
import { extractPrUrl } from "./lib/prs.mjs";
import { reviewConfig, reviewLoop, shouldReview } from "./lib/review.mjs";
import {
  branchName,
  implementPrompt,
  missingRepoTag,
  repoFromTags,
  resolveCwd,
  resultStatus,
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
// How many tasks to run at once. Each PR task runs in its own git worktree, so
// concurrent tasks — even on the same repo — stay isolated. Default 1.
const CONCURRENCY = Math.max(1, Number(val("--concurrency", process.env.AGENT_CONCURRENCY || "1")) || 1);
const INTERVAL = Number(val("--interval", process.env.AGENT_INTERVAL || "3000"));
const TIMEOUT = Number(process.env.AGENT_TIMEOUT || "1200000"); // 20 min
const WORKER = val("--worker", process.env.AGENT_WORKER || "dispatcher");
const AGENT_FILTER = val("--agent", "") || undefined;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
// Base dir for `repo:<name>` tags — a route's "{repo}" cwd resolves under here.
const REPO_BASE = process.env.AGENT_REPO_BASE || path.join(os.homedir(), "code");
// AGENT_REVIEW overrides the per-route `review` flag: "1" forces the pre-PR review
// gate on for every PR route, "0" off, unset → leave it to each route.
const REVIEW_FORCED =
  process.env.AGENT_REVIEW === "1" ? true : process.env.AGENT_REVIEW === "0" ? false : undefined;

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

function runCommand(route, task, cwdOverride) {
  return new Promise((resolve) => {
    const cmdArgs = (route.args || []).map((a) => fill(a, task));
    const cwd = cwdOverride ?? resolveCwd(route, task, { base: REPO_BASE, cwdBase: process.cwd() });
    if (!cwdOverride && missingRepoTag(route, task))
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

// Run the agent (edits only) in an isolated worktree, then the dispatcher itself
// commits, pushes, and opens the PR — so a finished task is already a reviewable
// PR and concurrent same-repo tasks never collide.
async function runWithPr(route, runTask, task) {
  const repo = resolveCwd(route, runTask, { base: REPO_BASE, cwdBase: process.cwd() });
  const branch = branchName(task);

  const wt = await createWorktree(repo, branch, task.id);
  if (wt.error) return { result: `PR aborted: ${wt.error}`, error: true };

  try {
    const agent = await runCommand(route, runTask, wt.path);
    // Independent pre-PR gate: a fresh reviewer + the repo's own checks iterate fixes
    // (in this same worktree) until the change clears the 95% gate or the cap is hit;
    // a flagged result still opens a PR, just marked for a closer human look.
    let note = "";
    if (shouldReview(route, task, REVIEW_FORCED)) {
      const r = await reviewLoop({
        route,
        task,
        wtPath: wt.path,
        runCommand,
        log: (m) => console.log(`  ↳ ${m}`),
      });
      if (r.summary) note = `\n\n${r.summary}`;
    }
    const fin = await finishPr(wt.path, { branch, base: wt.base, title: task.title });
    if (fin.error) return { result: `${agent.result}${note}\n\n⚠ PR step failed: ${fin.error}`, error: true };
    if (fin.noChanges) return { result: `${agent.result}${note}\n\n(no file changes — no PR opened)`, error: agent.error };
    console.log(`  ↳ opened PR ${fin.url}`);
    return { result: `${agent.result}${note}\n\nBOARD_PR: ${fin.url}`, error: agent.error };
  } finally {
    await removeWorktree(repo, wt.path);
  }
}

function dryRunPreview(route, runTask, opensPr) {
  if (!route) return "[dry-run] no runner configured";
  const cwd = resolveCwd(route, runTask, { base: REPO_BASE, cwdBase: process.cwd() });
  const cmd = `${route.command} ${(route.args || []).map((a) => fill(a, runTask)).join(" ")}`;
  let preview = `[dry-run] would run:\n(cwd: ${cwd})\n${cmd}`;
  if (opensPr) {
    if (shouldReview(route, runTask, REVIEW_FORCED)) {
      const { iterations, threshold } = reviewConfig(route);
      preview += `\nthen: review gate (≤${iterations + 1} passes, ${threshold}% + checks)`;
    }
    preview += `\nthen: worktree ${branchName(runTask)} → commit → push → gh pr create --fill`;
  }
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

  // A task that opened no PR (a question, info/subagent work, or a no-diff run)
  // needs no review gate, so it lands straight in Done; PRs and errors wait in
  // Review (the merge-watcher advances merged PRs to Done).
  const prUrl = extractPrUrl(outcome.result);
  const status = resultStatus({ execute: EXECUTE, error: outcome.error, prOpened: Boolean(prUrl) });
  await reportResult(task.id, { result: outcome.result, error: outcome.error, status });

  const head = outcome.error ? `❌ Failed "${task.title}"` : `✅ Done "${task.title}" by ${label}`;
  // Surface the PR link as its own line (Telegram auto-links it) so it's always
  // clickable — never lost to the snippet cap — and drop the raw BOARD_PR marker.
  const prLine = prUrl ? `\n🔗 Review PR: ${prUrl}` : "";
  const body = outcome.result.replace(/\n*BOARD_PR:\s*\S+/g, "").trim();
  const snippet = body.length > 500 ? body.slice(0, 500) + "…" : body;
  const landed = status === "done" ? "(moved to Done)" : "(in Review for your approval)";
  console.log(`${outcome.error ? "✗" : "✓"} ${task.title} → ${status}${prUrl ? ` ${prUrl}` : ""}`);
  await notify(`${head}${prLine}\n\n${snippet}\n\n${landed}`);
}

async function claim() {
  try {
    return await claimNext({ worker: WORKER, agent: AGENT_FILTER });
  } catch (e) {
    console.error("claim error:", e.message);
    return null;
  }
}

async function safeProcess(task) {
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

// One task at a time: claim → run → repeat.
async function runSequential() {
  for (;;) {
    const task = await claim();
    if (!task) {
      if (ONCE) break;
      await sleep(INTERVAL);
      continue;
    }
    await safeProcess(task);
  }
}

// Up to CONCURRENCY tasks at once. Safe because each PR task runs in its own
// worktree (lib/git.mjs), so same-repo tasks don't share a working tree.
async function runPool() {
  const inflight = new Set();
  for (;;) {
    while (inflight.size < CONCURRENCY) {
      const task = await claim();
      if (!task) break;
      const p = safeProcess(task).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (inflight.size === 0) {
      if (ONCE) break;
      await sleep(INTERVAL);
      continue;
    }
    await Promise.race([...inflight, sleep(INTERVAL)]);
  }
  await Promise.allSettled([...inflight]);
}

async function main() {
  console.log(
    `dispatcher up · ${EXECUTE ? "EXECUTE" : "dry-run"} · worker=${WORKER}` +
      `${CONCURRENCY > 1 ? ` · concurrency=${CONCURRENCY}` : ""}` +
      `${AGENT_FILTER ? ` · agent=${AGENT_FILTER}` : ""}` +
      `${telegramEnabled() && CHAT_ID ? " · telegram on" : ""}`,
  );
  if (CONCURRENCY > 1) await runPool();
  else await runSequential();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

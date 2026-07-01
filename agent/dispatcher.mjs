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
import { claimNext, getBoard, patchTask, reportResult } from "./lib/api.mjs";
import {
  createReviseWorktree,
  createWorktree,
  finishPr,
  finishRevise,
  killGroup,
  removeWorktree,
} from "./lib/git.mjs";
import { appendHistory, historyRecord } from "./lib/history.mjs";
import { notifyBody } from "./lib/message.mjs";
import { extractPrUrl } from "./lib/prs.mjs";
import { reviewConfig, reviewLoop, shouldReview } from "./lib/review.mjs";
import {
  AUTO_RETRY_TAG,
  branchName,
  implementPrompt,
  isRevise,
  missingRepoTag,
  repoFromTags,
  resolveCwd,
  resultStatus,
  resumeRoute,
  revisePrompt,
  shouldOpenPr,
  shouldRequeue,
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
// How often to poll the board for cancel requests on in-flight tasks.
const CANCEL_POLL = Number(process.env.AGENT_CANCEL_POLL || "3000");
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

// In-flight tasks → their AbortController. The cancel poll aborts the controller
// for a task whose board card carries `cancelRequestedAt`; every child spawned
// for that task (agent run, review checks, fixer) listens on the signal and is
// process-group-killed. Keyed by task id, so concurrency targets the right run.
const active = new Map();

function runCommand(route, task, cwdOverride, { signal } = {}) {
  return new Promise((resolve) => {
    const cmdArgs = (route.args || []).map((a) => fill(a, task));
    const cwd = cwdOverride ?? resolveCwd(route, task, { base: REPO_BASE, cwdBase: process.cwd() });
    if (!cwdOverride && missingRepoTag(route, task))
      console.warn(`⚠ no repo: tag on "${task.title}" — running in ${cwd}`);
    // detached → the child leads its own process group, so killGroup reaches the
    // model/tool sub-processes a plain child.kill would orphan.
    const child = spawn(route.command, cmdArgs, { cwd, env: process.env, detached: true });
    let out = "";
    let err = "";
    let timedOut = false;
    let canceled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, TIMEOUT);
    const onAbort = () => {
      canceled = true;
      killGroup(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const clear = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clear();
      resolve({ result: `Failed to start "${route.command}": ${e.message}`, error: true });
    });
    child.on("close", (code) => {
      clear();
      let result = out.trim();
      let error = code !== 0;
      let sessionId;
      // claude --output-format json → { result, is_error, session_id }
      try {
        const json = JSON.parse(out);
        if (json && typeof json.result === "string") {
          result = json.result;
          error = error || Boolean(json.is_error);
        }
        // Capture the agent's session id so a follow-up run can resume this exact
        // session (with its full implementation context) instead of starting cold.
        if (json && typeof json.session_id === "string") sessionId = json.session_id;
      } catch {
        /* not JSON — use raw stdout */
      }
      if (!result)
        result =
          err.trim() ||
          (canceled
            ? "(cancelled)"
            : timedOut
              ? `(timed out after ${Math.round(TIMEOUT / 60000)}m)`
              : `(no output, exit ${code})`);
      resolve({ result, error, timedOut, canceled, sessionId });
    });
  });
}

// Run the agent (edits only) in an isolated worktree, then the dispatcher itself
// commits, pushes, and opens the PR — so a finished task is already a reviewable
// PR and concurrent same-repo tasks never collide.
async function runWithPr(route, runTask, task, { signal } = {}) {
  const repo = resolveCwd(route, runTask, { base: REPO_BASE, cwdBase: process.cwd() });
  const branch = branchName(task);

  const wt = await createWorktree(repo, branch, task.id);
  if (wt.error) return { result: `PR aborted: ${wt.error}`, error: true };

  try {
    const agent = await runCommand(route, runTask, wt.path, { signal });
    // Cancelled by you → bail before committing. The worktree is torn down in
    // `finally`, so nothing is pushed; processTask reports it done, no requeue.
    if (agent.canceled || signal?.aborted) return { result: agent.result, error: false, canceled: true };
    // If the agent hit the kill-timeout, don't commit its half-finished edits into a
    // PR. Bail out (the worktree is torn down in `finally`, so nothing is pushed) and
    // let processTask auto-requeue a clean attempt — a fresh run can't collide with a
    // partial remote branch that never existed.
    if (agent.timedOut) return { result: agent.result, error: true, timedOut: true };
    // Independent pre-PR gate: a fresh reviewer + the repo's own checks iterate fixes
    // (in this same worktree) until the change clears the confidence gate or the cap is hit;
    // a flagged result still opens a PR, just marked for a closer human look.
    let note = "";
    let reviewScore;
    if (shouldReview(route, task, REVIEW_FORCED)) {
      const r = await reviewLoop({
        route,
        task,
        wtPath: wt.path,
        runCommand,
        signal,
        log: (m) => console.log(`  ↳ ${m}`),
      });
      if (r.summary) note = `\n\n${r.summary}`;
      if (r.review && Number.isFinite(r.review.confidence)) reviewScore = r.review.confidence;
    }
    // A cancel during the review gate still bails before opening the PR.
    // A cancel during the review gate still bails before opening the PR.
    if (signal?.aborted) return { result: `${agent.result}${note}`, error: false, canceled: true, reviewScore };
    // Carry the implementer's session id (not the reviewer/fixer's) up to the
    // board on every Review-bound return, so a later revise run can resume it.
    const sessionId = agent.sessionId;
    const fin = await finishPr(wt.path, { branch, base: wt.base, title: task.title, id: task.id });
    if (fin.error) return { result: `${agent.result}${note}\n\n⚠ PR step failed: ${fin.error}`, error: true, sessionId, reviewScore };
    if (fin.noChanges) return { result: `${agent.result}${note}\n\n(no file changes — no PR opened)`, error: agent.error, sessionId, reviewScore };
    console.log(`  ↳ opened PR ${fin.url}`);
    return { result: `${agent.result}${note}\n\nBOARD_PR: ${fin.url}`, error: agent.error, sessionId, reviewScore };
  } finally {
    await removeWorktree(repo, wt.path);
  }
}

// Revise pass: the task was sent back from Review with a correction. Re-open its
// EXISTING PR branch in a worktree at the SAME path (so `--resume` recalls the
// original session), let the agent apply the correction (and resolve any conflict
// from merging the latest base), then commit + push to update the SAME PR. Bails
// before committing on cancel/timeout, like runWithPr.
async function runWithRevise(route, task, { signal } = {}) {
  const repo = resolveCwd(route, task, { base: REPO_BASE, cwdBase: process.cwd() });
  const branch = branchName(task);

  const wt = await createReviseWorktree(repo, branch, task.id);
  if (wt.error) return { result: `Revise aborted: ${wt.error}`, error: true };

  try {
    const runTask = { ...task, prompt: revisePrompt(task, { mergeConflict: wt.mergeConflict }) };
    // Resume the original implementer session when we have its id; otherwise a
    // fresh agent works from the checked-out branch + the correction note.
    const gateRoute = resumeRoute(route, task.sessionId);
    const agent = await runCommand(gateRoute, runTask, wt.path, { signal });
    if (agent.canceled || signal?.aborted) return { result: agent.result, error: false, canceled: true };
    if (agent.timedOut) return { result: agent.result, error: true, timedOut: true };

    let note = "";
    let reviewScore;
    if (shouldReview(route, task, REVIEW_FORCED)) {
      const r = await reviewLoop({
        route,
        task,
        wtPath: wt.path,
        runCommand,
        signal,
        log: (m) => console.log(`  ↳ ${m}`),
      });
      if (r.summary) note = `\n\n${r.summary}`;
      if (r.review && Number.isFinite(r.review.confidence)) reviewScore = r.review.confidence;
    }
    if (signal?.aborted) return { result: `${agent.result}${note}`, error: false, canceled: true, reviewScore };

    // Resume keeps the same id; a fresh fallback yields a new one — persist whichever
    // so the next revise resumes the latest session.
    const sessionId = agent.sessionId || task.sessionId;
    const fin = await finishRevise(wt.path, {
      branch,
      title: task.title,
      note: task.reviseNote,
      mergeConflict: wt.mergeConflict,
    });
    if (fin.error) return { result: `${agent.result}${note}\n\n⚠ Revise step failed: ${fin.error}`, error: true, sessionId, reviewScore };
    if (fin.noChanges) return { result: `${agent.result}${note}\n\n(revise made no changes — PR unchanged)`, error: agent.error, sessionId, reviewScore };
    console.log(`  ↳ updated PR ${fin.url}`);
    return { result: `${agent.result}${note}\n\nBOARD_PR: ${fin.url}`, error: agent.error, sessionId, reviewScore };
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

// Best-effort append to the durable run-history log. Never let a history write
// break the dispatch loop.
function recordHistory(task, { status, error, prUrl, reviewScore, startedAt }) {
  appendHistory(
    historyRecord({
      id: task.id,
      title: task.title,
      agent: task.agent || "default",
      repo: repoFromTags(task.tags),
      status,
      durationMs: Date.now() - startedAt,
      reviewScore,
      prUrl,
      error,
      at: Date.now(),
    }),
  );
}

async function processTask(task) {
  const startedAt = Date.now();
  const route = routeFor(task);
  const label = task.agent || "default";
  // Code routes (pr:true) that target a repo get the dispatcher-driven PR flow:
  // the agent only edits, then we branch/commit/push/PR before Review.
  const opensPr = route ? shouldOpenPr(route, task) : false;
  // A revise task (sent back from Review) re-opens its existing PR branch and
  // resumes the original session instead of implementing from scratch.
  const revise = opensPr && isRevise(task);
  const runTask = opensPr && !revise ? { ...task, prompt: implementPrompt(task.prompt) } : task;
  const prNote = revise
    ? ` (↻ revise PR in ${repoFromTags(task.tags)})`
    : opensPr
      ? ` (→ PR in ${repoFromTags(task.tags)})`
      : "";
  console.log(`▶ claimed "${task.title}" → ${label}${prNote}`);
  await notify(`🟢 Picked up "${task.title}"\n→ dispatched to ${label}${prNote}`);

  const ac = new AbortController();
  active.set(task.id, ac);
  let outcome;
  try {
    if (!EXECUTE) {
      outcome = { result: dryRunPreview(route, runTask, opensPr), error: false };
    } else if (!route) {
      outcome = { result: `No runner configured for agent "${task.agent}".`, error: true };
    } else if (revise) {
      outcome = await runWithRevise(route, task, { signal: ac.signal });
    } else if (opensPr) {
      outcome = await runWithPr(route, runTask, task, { signal: ac.signal });
    } else {
      outcome = await runCommand(route, runTask, undefined, { signal: ac.signal });
    }
  } finally {
    active.delete(task.id);
  }

  // Cancelled by you (the signal was aborted) → move straight to Done with a
  // marker; never auto-requeue. Any partial output is kept for context.
  if (ac.signal.aborted || outcome.canceled) {
    const partial = notifyBody(outcome.result || "");
    const body = `🛑 Cancelled by you${partial ? `\n\n${partial}` : ""}`;
    await reportResult(task.id, { result: body, error: false, status: "done" });
    recordHistory(task, { status: "done", error: false, reviewScore: outcome.reviewScore, startedAt });
    console.log(`🛑 cancelled "${task.title}" → Done`);
    await notify(`🛑 Cancelled "${task.title}" — moved to Done.`);
    return;
  }

  // Auto-requeue once on timeout: rather than parking a slow task in Review, give
  // it one clean re-attempt. The AUTO_RETRY_TAG makes it one-shot — a second
  // timeout falls through to the normal Review path below for a human to take over.
  if (shouldRequeue({ execute: EXECUTE, timedOut: outcome.timedOut, tags: task.tags })) {
    const mins = Math.round(TIMEOUT / 60000);
    await patchTask(task.id, { status: "queued", tags: [...(task.tags || []), AUTO_RETRY_TAG] });
    console.log(`⏱ "${task.title}" timed out after ${mins}m → auto-requeued (one retry)`);
    await notify(`⏱ Timed out "${task.title}" after ${mins}m\n→ auto-requeued for one more attempt`);
    return;
  }

  // A task that opened no PR (a question, info/subagent work, or a no-diff run)
  // needs no review gate, so it lands straight in Done; PRs and errors wait in
  // Review (the merge-watcher advances merged PRs to Done).
  const prUrl = extractPrUrl(outcome.result);
  const status = resultStatus({ execute: EXECUTE, error: outcome.error, prOpened: Boolean(prUrl) });
  await reportResult(task.id, { result: outcome.result, error: outcome.error, status, sessionId: outcome.sessionId });
  recordHistory(task, {
    status,
    error: outcome.error,
    prUrl: prUrl || "",
    reviewScore: outcome.reviewScore,
    startedAt,
  });

  const head = outcome.error ? `❌ Failed "${task.title}"` : `✅ Done "${task.title}" by ${label}`;
  // Surface the PR link as its own line (Telegram auto-links it) so it's always
  // clickable — never lost to the snippet cap — and drop the raw BOARD_PR marker.
  const prLine = prUrl ? `\n🔗 Review PR: ${prUrl}` : "";
  // A PR sitting in Review can be sent back for another pass — surface the ready-to-use
  // command with the id already filled in, so you don't have to hunt for it.
  const reviseHint =
    status === "review" && prUrl ? `\n↩️ send back: /revise ${task.id.slice(0, 8)} <correction>` : "";
  // Drop the file-by-file "Changes" section but always keep the review verdict.
  const snippet = notifyBody(outcome.result);
  const landed = status === "done" ? "(moved to Done)" : "(in Review for your approval)";
  console.log(`${outcome.error ? "✗" : "✓"} ${task.title} → ${status}${prUrl ? ` ${prUrl}` : ""}`);
  await notify(`${head}${prLine}${reviseHint}\n\n${snippet}\n\n${landed}`);
}

async function claim() {
  try {
    return await claimNext({ worker: WORKER, agent: AGENT_FILTER });
  } catch (e) {
    console.error("claim error:", e.message);
    return null;
  }
}

// Poll the board for cancel requests on in-flight tasks and abort their runs.
// Runs on its own timer (not the claim loop), so it fires even in sequential mode
// where the claim loop is blocked awaiting a single task.
async function pollCancellations() {
  if (active.size === 0) return;
  let board;
  try {
    board = await getBoard();
  } catch {
    return; // board momentarily unreachable — try again next tick
  }
  for (const [id, ac] of active) {
    const t = board.tasks?.[id];
    if (t && t.cancelRequestedAt && !ac.signal.aborted) {
      console.log(`🛑 cancel requested for "${t.title}" — killing the run`);
      await notify(`🛑 Cancelling "${t.title}"…`);
      ac.abort();
    }
  }
}

// On shutdown, kill the process groups of every in-flight run so a Ctrl-C on the
// control plane doesn't orphan running agents.
function shutdown(sig) {
  for (const ac of active.values()) ac.abort();
  process.exit(sig === "SIGINT" ? 130 : 0);
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
  const cancelTimer = setInterval(() => pollCancellations().catch(() => {}), CANCEL_POLL);
  cancelTimer.unref?.(); // don't keep the process alive just for the poll
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (CONCURRENCY > 1) await runPool();
  else await runSequential();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

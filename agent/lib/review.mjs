// Independent pre-PR review gate. After the implementer agent edits the worktree
// — but BEFORE the dispatcher opens the PR — a FRESH agent process (no implementer
// context) reviews the diff alongside the repo's own checks, and a fixer process
// iterates until the change clears the gate or the cap is hit. The human only ever
// opens PRs that already passed (or are explicitly flagged).
//
// Like prs.mjs, this mixes PURE decision/formatting helpers (unit-tested in
// review.test.mjs) with IMPURE runners that shell out (runChecks/runReviewer) and
// orchestrate (reviewLoop). The reviewer/fixer are spawned via the dispatcher's
// own `runCommand`, injected in, so there's no circular import and one spawn path.

import { readFileSync } from "node:fs";
import path from "node:path";
import { run, worktreeDiff } from "./git.mjs";
import { shouldOpenPr } from "./routes.mjs";

const DEFAULT_CHECKS = ["lint", "typecheck", "test"];
const CHECK_TIMEOUT = Number(process.env.REVIEW_CHECK_TIMEOUT || "300000"); // 5 min/check
// Reviewing/fixing a diff doesn't need the implementer's (Opus) model — run the
// gate on a cheaper one to cut token burn. Override with REVIEW_MODEL ("" disables).
const REVIEW_MODEL = process.env.REVIEW_MODEL ?? "sonnet";

/**
 * Clone a route so the reviewer/fixer run on REVIEW_MODEL instead of the
 * implementer's model. Only touches `claude` routes that don't already pin a
 * `--model`; everything else passes through untouched.
 */
export function reviewerRoute(route) {
  if (!REVIEW_MODEL || !route || route.command !== "claude") return route;
  const args = route.args || [];
  if (args.includes("--model")) return route;
  return { ...route, args: [...args, "--model", REVIEW_MODEL] };
}

// ── pure helpers ───────────────────────────────────────────────────────────

/**
 * Should this PR task run the review gate? Review is a pre-PR step, so it only
 * applies when the task would open a PR. `forced` is the AGENT_REVIEW override:
 * true → on for every PR route, false → off, undefined → per-route `review`.
 */
export function shouldReview(route, task, forced) {
  if (!shouldOpenPr(route, task)) return false;
  if (forced === true) return true;
  if (forced === false) return false;
  return Boolean(route && route.review);
}

/** Normalize a route's `review` (true | {iterations,threshold,checks}) + defaults. */
export function reviewConfig(route) {
  const r = route && route.review;
  const cfg = r && typeof r === "object" ? r : {};
  const iterations = Number.isFinite(cfg.iterations) ? Math.max(0, Math.floor(cfg.iterations)) : 1;
  const threshold = Number.isFinite(cfg.threshold) ? Math.max(0, Math.min(100, cfg.threshold)) : 90;
  const checks = Array.isArray(cfg.checks) ? cfg.checks : null;
  return { iterations, threshold, checks };
}

/**
 * Which of the wanted check scripts actually exist in the worktree's package.json.
 * `configured` (route override) wins; otherwise auto-detect lint/typecheck/test
 * (build is excluded by default — too slow for a tight loop).
 */
export function detectChecks(pkgJson, configured) {
  const scripts = (pkgJson && pkgJson.scripts) || {};
  const wanted = Array.isArray(configured) && configured.length ? configured : DEFAULT_CHECKS;
  return wanted.filter((s) => typeof scripts[s] === "string" && scripts[s].length > 0);
}

function truncate(s, n) {
  const str = String(s || "");
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/** Render check results into the compact text the review/fix prompts embed. */
export function formatChecks(checks) {
  if (!checks || !Array.isArray(checks.results) || checks.results.length === 0)
    return "(no checks configured)";
  return checks.results
    .map((r) => `- ${r.script}: ${r.ok ? "PASS" : "FAIL"}${r.ok ? "" : `\n${truncate(r.output, 1500)}`}`)
    .join("\n");
}

/** Prompt for the INDEPENDENT reviewer — demands a fenced json verdict block. */
export function reviewPrompt(task, diff, checks) {
  return [
    "You are an INDEPENDENT code reviewer. You did NOT write the code below — review it",
    "adversarially and assume nothing. A coding agent attempted this task:",
    `Title: ${task.title || ""}`,
    `Requirement: ${task.prompt || ""}`,
    "",
    "The repo's own automated checks reported:",
    formatChecks(checks),
    "",
    "Full diff of the agent's changes:",
    "```diff",
    diff || "(no diff)",
    "```",
    "",
    "Decide whether this change correctly and safely fulfils the requirement with no bugs.",
    "A 'blocking' issue = anything that makes it wrong, unsafe, broken, or incomplete vs the",
    "requirement (a failing check is always blocking). 'minor' = nits that don't block merge.",
    "Reply with ONLY a fenced json block in EXACTLY this shape, nothing else:",
    "```json",
    '{ "confidence": 0-100, "blocking": ["..."], "minor": ["..."], "summary": "one line" }',
    "```",
    "confidence = your percent certainty the change is error-free and meets the requirement.",
  ].join("\n");
}

/** Edit-only prompt for the fixer — sibling of implementPrompt, cites the findings. */
export function fixPrompt(task, review, checks) {
  const blocking = (review && review.blocking) || [];
  return [
    "An independent review of a previous attempt at this task found problems. Fix them by",
    "editing files in this repository. Make the code changes only —",
    "do NOT commit, push, or open a pull request; that is handled automatically after you finish.",
    `Task: ${task.prompt || ""}`,
    "",
    "Blocking issues to resolve:",
    ...(blocking.length ? blocking.map((b) => `- ${b}`) : ["- (see check output below)"]),
    "",
    "Latest automated check results:",
    formatChecks(checks),
  ].join("\n");
}

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function toStringArray(a) {
  if (!Array.isArray(a)) return [];
  return a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter(Boolean);
}

function tryParseObject(s) {
  try {
    return JSON.parse(s);
  } catch {
    /* not whole-string JSON */
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      /* not a parseable object slice */
    }
  }
  return null;
}

/**
 * Parse the reviewer's answer into { confidence, blocking, minor, summary }.
 * Fails CLOSED: if nothing parses, return confidence 0 + a blocking finding so an
 * unreadable review can never pass the gate.
 */
export function parseReview(text) {
  const s = String(text || "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const obj = (fence && tryParseObject(fence[1])) || tryParseObject(s);
  if (!obj || typeof obj !== "object")
    return { confidence: 0, blocking: ["could not parse reviewer output"], minor: [], summary: "" };
  return {
    confidence: clampPct(obj.confidence),
    blocking: toStringArray(obj.blocking),
    minor: toStringArray(obj.minor),
    summary: typeof obj.summary === "string" ? obj.summary : "",
  };
}

/**
 * The gate. Passes only when ALL hold: checks green, zero blocking findings, and
 * confidence ≥ threshold — a soft (confidence) signal anchored to hard (checks) and
 * concrete (blocking) ones, since an LLM's confidence number isn't calibrated.
 */
export function reviewVerdict({ checks, review, threshold = 95 }) {
  const checksPass = !checks || checks.allPass !== false;
  const blocking = (review && review.blocking) || [];
  const confidence = (review && review.confidence) || 0;
  if (!checksPass) return { pass: false, reason: "checks failing" };
  if (blocking.length > 0) return { pass: false, reason: `${blocking.length} blocking issue(s)` };
  if (confidence < threshold) return { pass: false, reason: `confidence ${confidence}% < ${threshold}%` };
  return { pass: true, reason: `confidence ${confidence}%, checks green, no blocking issues` };
}

/** The human-facing review block folded into the task result (card + Telegram). */
export function reviewSummary(review, { flagged = false, attempts = 0 } = {}) {
  const c = (review && review.confidence) || 0;
  const blocking = (review && review.blocking) || [];
  const minor = (review && review.minor) || [];
  const lines = [
    `🔍 Review: ${c}% confidence · ${blocking.length} blocking · ${minor.length} minor · ${attempts} pass(es)`,
  ];
  if (flagged)
    lines.push("⚠ Flagged: opened below the confidence gate — needs a closer human look.");
  for (const x of blocking) lines.push(`  ⛔ ${x}`);
  for (const x of minor) lines.push(`  • ${x}`);
  return lines.join("\n");
}

// ── impure runners ───────────────────────────────────────────────────────────

function readPkg(wtPath) {
  try {
    return JSON.parse(readFileSync(path.join(wtPath, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Run each check script in the worktree; { allPass, results:[{script,ok,output}] }. */
export async function runChecks(wtPath, scripts) {
  const results = [];
  for (const s of scripts) {
    const r = await run("npm", ["run", "--silent", s], wtPath, { timeout: CHECK_TIMEOUT });
    results.push({ script: s, ok: r.code === 0, output: [r.out, r.err].filter(Boolean).join("\n") });
  }
  return { allPass: results.every((r) => r.ok), results };
}

/** Spawn a fresh reviewer via the injected runCommand and parse its verdict. */
export async function runReviewer(route, task, diff, checks, runCommand, wtPath) {
  const out = await runCommand(route, { ...task, prompt: reviewPrompt(task, diff, checks) }, wtPath);
  return parseReview(out.result);
}

/**
 * Drive the review→fix loop inside an already-created worktree. Returns
 * { review, attempts, flagged, summary }. `runCommand` is the dispatcher's runner
 * (injected). Never opens the PR — the dispatcher does that after this returns.
 */
export async function reviewLoop({ route, task, wtPath, runCommand, log = () => {} }) {
  const cfg = reviewConfig(route);
  const scripts = detectChecks(readPkg(wtPath), cfg.checks);
  const gateRoute = reviewerRoute(route); // reviewer + fixer run on the cheaper model

  let review = null;
  for (let i = 0; i <= cfg.iterations; i++) {
    const attempts = i + 1;
    const diff = await worktreeDiff(wtPath);
    if (i === 0 && !diff.trim()) return { review: null, attempts: 0, flagged: false, summary: "" };

    const checks = await runChecks(wtPath, scripts);
    review = await runReviewer(gateRoute, task, diff, checks, runCommand, wtPath);
    const verdict = reviewVerdict({ checks, review, threshold: cfg.threshold });
    log(`review pass ${attempts}: ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.reason}`);
    if (verdict.pass) return { review, attempts, flagged: false, summary: reviewSummary(review, { attempts }) };

    if (i === cfg.iterations) {
      const summary = reviewSummary(review, { flagged: true, attempts });
      return { review, attempts, flagged: true, summary };
    }
    log(`  ↳ fixing: ${review.blocking.slice(0, 3).join("; ") || "(check failures)"}`);
    await runCommand(gateRoute, { ...task, prompt: fixPrompt(task, review, checks) }, wtPath);
  }
  return { review, attempts: 0, flagged: false, summary: "" };
}

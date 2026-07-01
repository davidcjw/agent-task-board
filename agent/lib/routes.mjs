// Working-directory resolution for the dispatcher. A task picks the repo it acts
// on via a `repo:<name>` tag, so one route (e.g. commit-push) serves every repo:
//   repo:democratizing-claude  →  <AGENT_REPO_BASE>/democratizing-claude
//   repo:/abs/path             →  /abs/path  (absolute wins)
// A route opts into this by setting `"cwd": "{repo}"` (or "{repo}/sub"). Routes
// with a literal cwd (e.g. ".") are unaffected. These helpers are pure — the
// base dirs are injected — so they're deterministic and unit-tested.

import path from "node:path";

const REPO_TAG = "repo:";

/** The repo name from a task's `repo:<name>` tag, or "" if none. */
export function repoFromTags(tags) {
  const t = (tags || []).find((x) => typeof x === "string" && x.startsWith(REPO_TAG));
  return t ? t.slice(REPO_TAG.length).trim() : "";
}

/** Absolute path for a repo: as-is if absolute, else joined under `base`. */
export function resolveRepoPath(repo, base) {
  if (!repo) return "";
  return path.isAbsolute(repo) ? repo : path.join(base, repo);
}

/**
 * Resolve the cwd a task's runner should spawn in.
 * - `route.cwd` containing "{repo}" → filled from the task's `repo:` tag under
 *   `base`. Missing tag falls back to `cwdBase` (the dispatcher passes its own
 *   cwd) so a mis-tagged task can't run loose in the repo-base root.
 * - otherwise `route.cwd` is resolved relative to `cwdBase`.
 */
export function resolveCwd(route, task, { base, cwdBase }) {
  const raw = (route && route.cwd) || ".";
  if (raw.includes("{repo}")) {
    const repoPath = resolveRepoPath(repoFromTags(task && task.tags), base);
    if (!repoPath) return cwdBase;
    return path.resolve(raw.replaceAll("{repo}", repoPath));
  }
  return path.resolve(cwdBase, raw);
}

/** True when a route wants a per-task repo but the task didn't supply one. */
export function missingRepoTag(route, task) {
  return Boolean(route && (route.cwd || "").includes("{repo}") && !repoFromTags(task && task.tags));
}

/**
 * Should this run commit + push + open a PR before landing in Review?
 * Only when the route opts in (`pr: true`) AND the task targets a repo (a
 * `repo:` tag) — so plain questions and the non-code subagent routes never PR.
 */
export function shouldOpenPr(route, task) {
  return Boolean(route && route.pr) && Boolean(repoFromTags(task && task.tags));
}

/**
 * Which lane a finished task lands in:
 *  - dry-run previews stay in Review (nothing actually ran),
 *  - errors stay in Review (a human should look at the failure),
 *  - a task that opened a PR waits in Review for approval (the merge-watcher
 *    moves it to Done once the PR is merged),
 *  - everything else — a plain question, an info/subagent task, or a code run
 *    that produced no diff — needs no review gate, so it goes straight to Done.
 */
export function resultStatus({ execute, error, prOpened }) {
  if (!execute || error || prOpened) return "review";
  return "done";
}

/**
 * Tag the dispatcher stamps on a task when it auto-requeues it after a timeout.
 * Its presence makes the retry one-shot — a second timeout won't requeue again.
 */
export const AUTO_RETRY_TAG = "auto-retry";

/**
 * Should a timed-out task be auto-requeued for one more attempt? Only when we're
 * actually executing, the runner hit the kill-timeout, and the task hasn't
 * already been auto-retried — so a second timeout falls through to the normal
 * Review path for a human to take over.
 */
export function shouldRequeue({ execute, timedOut, tags }) {
  return Boolean(execute && timedOut && !(tags || []).includes(AUTO_RETRY_TAG));
}

/** The branch the dispatcher opens a task's PR from. */
export function branchName(task) {
  return `atb/${task && task.id}`;
}

/** Filesystem path for a task's isolated git worktree under `baseDir`. */
export function worktreePath(baseDir, repo, id) {
  const name = (repo || "").split(/[/\\]/).filter(Boolean).pop() || "repo";
  return path.join(baseDir, `${name}-${id}`);
}

/**
 * Collapse a repo identifier to a separator-insensitive key: lowercase, with
 * spaces / dots / hyphens / underscores stripped. Lets a typed Telegram slug
 * (`/democratizing_claude`, hyphens disallowed in commands) match a real dir
 * named `democratizing-claude` without guessing which separator was meant.
 */
export function normalizeRepoKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s._-]/g, "");
}

/**
 * Match a typed repo slug against a list of directory names, ignoring case and
 * separators. Returns `{ match, candidates }`:
 *  - `match` is the single name whose key equals the slug's, or "" for 0 / >1.
 *  - `candidates` lists every name sharing that key (so a caller can report an
 *    ambiguous slug like `my-app` vs `my_app`).
 */
export function matchRepoSlug(slug, names) {
  const key = normalizeRepoKey(slug);
  if (!key) return { match: "", candidates: [] };
  const candidates = (names || []).filter((n) => normalizeRepoKey(n) === key);
  return { match: candidates.length === 1 ? candidates[0] : "", candidates };
}

/**
 * A Telegram `setMyCommands` command name for a repo dir: lowercase, only
 * `[a-z0-9_]`, no leading/trailing underscore, ≤32 chars (Telegram's limit).
 * Hyphens become underscores — `democratizing-claude` → `democratizing_claude`.
 */
export function repoCommandName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/**
 * Parse `git diff --numstat` output into `{ path, added, removed }[]`. Each line
 * is `added\tremoved\tpath`; binary files report `-` for both counts (kept as
 * null). Rename lines (`old => new`, or `dir/{old => new}/file`) are collapsed to
 * the new path so the summary reads naturally. Pure + unit-tested.
 */
export function parseNumstat(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 3) return null;
      const [a, r] = parts;
      let file = parts.slice(2).join("\t");
      // Collapse a rename to just the destination path.
      file = file.replace(/\{[^}]*=>\s*([^}]*)\}/, "$1").replace(/^.*\s=>\s+/, "");
      file = file.replace(/\/{2,}/g, "/").trim();
      return { path: file, added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r) };
    })
    .filter((f) => f && f.path);
}

/**
 * Build the PR body: a short summary line plus a per-file changed list with
 * +added/-removed counts, so a reviewer sees at a glance what the task touched.
 * `files` is the output of `parseNumstat`. Pure + unit-tested.
 */
export function prBody({ title, files }) {
  const list = files || [];
  const lines = [];
  lines.push("## Summary");
  lines.push("");
  lines.push(title ? String(title).trim() : "Automated change by the agent task board.");
  lines.push("");
  lines.push(`## Files changed (${list.length})`);
  lines.push("");
  if (list.length === 0) {
    lines.push("_No file changes detected._");
  } else {
    for (const f of list) {
      const stat = f.added == null || f.removed == null ? "binary" : `+${f.added}/-${f.removed}`;
      lines.push(`- \`${f.path}\` (${stat})`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("_PR opened automatically by the agent task board dispatcher._");
  return lines.join("\n");
}

/** Wrap a task prompt so the agent ONLY edits files — the dispatcher does the
 *  commit/push/PR afterward, so the agent must not touch git itself. */
export function implementPrompt(prompt) {
  return (
    "Implement the task below by editing files in the CURRENT working directory. " +
    "It is an isolated git worktree — treat it as the repo root. Follow these rules strictly:\n" +
    "- Work ONLY inside the current working directory. Never `cd` elsewhere.\n" +
    "- Treat every path as relative to here. If the task names an ABSOLUTE path " +
    "(e.g. /Users/<name>/code/<repo>/…), ignore the absolute prefix and act on the " +
    "matching path inside the current working directory — never touch the original checkout.\n" +
    "- Make code changes ONLY. Do NOT run git (no add/commit/branch/push) and do NOT open a " +
    "pull request; committing, pushing, and the PR are handled automatically after you finish. " +
    "Leave your changes uncommitted in the working tree.\n\n" +
    "Task: " +
    (prompt || "")
  );
}

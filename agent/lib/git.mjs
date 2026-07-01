// Dispatcher-driven git/PR flow, isolated per task via `git worktree`: each task
// gets its own checkout on branch atb/<id>, so multiple tasks — even on the SAME
// repo — never share a working tree, and your main checkout is never touched. The
// DISPATCHER (not the agent) commits, pushes, and opens the PR, so it's
// deterministic. All functions shell out to git/gh (impure, like prs.mjs's
// prState); the pure worktree-path helper lives in routes.mjs and is unit-tested.

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractPrUrl } from "./prs.mjs";
import { parseNumstat, prBody, worktreePath } from "./routes.mjs";

const WORKTREE_BASE = process.env.AGENT_WORKTREE_DIR || path.join(os.tmpdir(), "atb-worktrees");

// Kill a child's whole process group (it's spawned detached, so it leads its own
// group) — git/gh/npm can fork sub-processes a plain child.kill would orphan.
// Falls back to killing just the child if the group send fails.
export function killGroup(child, sig = "SIGKILL") {
  if (!child || child.pid == null) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

// Shell out to git/gh (and, for the review gate, npm). Resolves { code, out, err }
// and never rejects. `timeout` (ms) SIGKILLs a hung command — checks like
// `npm test` can otherwise run forever. `signal` (AbortSignal) lets a caller
// cancel a long check mid-run (the dispatcher's task-cancel). Both kill the whole
// process group. Exported so review.mjs/dispatcher reuse one runner.
export function run(cmd, args, cwd, { timeout, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, detached: true });
    let out = "";
    let err = "";
    const timer = timeout ? setTimeout(() => killGroup(child), timeout) : null;
    const onAbort = () => killGroup(child);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      cleanup();
      resolve({ code: -1, out: out.trim(), err: e.message });
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

// Serialize the fast worktree admin ops per repo — concurrent `git worktree add`
// to one repo can race on its lock. The long agent run happens OUTSIDE this lock,
// so different tasks on the same repo still execute in parallel.
const repoChains = new Map();
function withRepoLock(repo, fn) {
  const next = (repoChains.get(repo) || Promise.resolve()).then(fn, fn);
  repoChains.set(
    repo,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// Bring gitignored essentials into the fresh worktree so builds/tests still work:
// symlink node_modules (read-mostly, shared) and copy .env files.
async function hydrateWorktree(repo, wt) {
  const nm = path.join(repo, "node_modules");
  if ((await exists(nm)) && !(await exists(path.join(wt, "node_modules")))) {
    await fsp.symlink(nm, path.join(wt, "node_modules"), "dir").catch(() => {});
  }
  for (const name of [".env", ".env.local"]) {
    if (await exists(path.join(repo, name))) {
      await fsp.copyFile(path.join(repo, name), path.join(wt, name)).catch(() => {});
    }
  }
}

/**
 * Create an isolated worktree for a task: a fresh checkout of `repo` on a new
 * branch atb/<id>, hydrated with node_modules + .env. Returns { path, base }
 * (base = the branch the PR targets) or { error }.
 */
export async function createWorktree(repo, branch, id) {
  return withRepoLock(repo, async () => {
    const isRepo = await run("git", ["rev-parse", "--is-inside-work-tree"], repo);
    if (isRepo.code !== 0) return { error: `not a git repo: ${repo}` };
    const cur = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo);
    if (cur.code !== 0) return { error: `couldn't read current branch: ${cur.err}` };
    const base = cur.out;

    await fsp.mkdir(WORKTREE_BASE, { recursive: true });
    const wt = worktreePath(WORKTREE_BASE, repo, id);

    // Clear any leftover from a crashed run, then drop its dangling registration.
    await fsp.rm(wt, { recursive: true, force: true }).catch(() => {});
    await run("git", ["worktree", "prune"], repo);

    let add = await run("git", ["worktree", "add", "-b", branch, wt, base], repo);
    if (add.code !== 0) {
      // Branch likely left over from a prior run — drop it and retry from base.
      await run("git", ["branch", "-D", branch], repo);
      add = await run("git", ["worktree", "add", "-b", branch, wt, base], repo);
      if (add.code !== 0) return { error: `git worktree add failed: ${add.err || add.out}` };
    }

    await hydrateWorktree(repo, wt);
    return { path: wt, base };
  });
}

/**
 * Create a worktree for a REVISE pass: check out the task's EXISTING PR branch
 * (from origin — the source of truth the PR shows) at the SAME deterministic path
 * the original run used, so `claude --resume` resolves the session and the later
 * push updates the same PR. When the base branch has moved ahead, merge it in so
 * the PR is current; a merge that conflicts is left in place for the agent to
 * resolve (surfaced via `mergeConflict`). Returns { path, base, mergeConflict }
 * or { error }.
 */
export async function createReviseWorktree(repo, branch, id) {
  return withRepoLock(repo, async () => {
    const isRepo = await run("git", ["rev-parse", "--is-inside-work-tree"], repo);
    if (isRepo.code !== 0) return { error: `not a git repo: ${repo}` };
    const cur = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo);
    if (cur.code !== 0) return { error: `couldn't read current branch: ${cur.err}` };
    const base = cur.out;

    // Refresh remote refs so origin/<branch> and origin/<base> are current.
    const fetched = await run("git", ["fetch", "origin"], repo);
    if (fetched.code !== 0) return { error: `git fetch failed: ${fetched.err || fetched.out}` };

    // The PR branch must exist on origin (a PR was opened from it).
    const remoteRef = `origin/${branch}`;
    const hasRemote = await run("git", ["rev-parse", "--verify", "--quiet", remoteRef], repo);
    if (hasRemote.code !== 0) return { error: `PR branch ${remoteRef} not found — nothing to revise` };

    await fsp.mkdir(WORKTREE_BASE, { recursive: true });
    const wt = worktreePath(WORKTREE_BASE, repo, id);
    await fsp.rm(wt, { recursive: true, force: true }).catch(() => {});
    await run("git", ["worktree", "prune"], repo);

    // -B forces local <branch> to origin/<branch>, so we build on exactly what the
    // PR shows and the later push fast-forwards.
    const add = await run("git", ["worktree", "add", "-B", branch, wt, remoteRef], repo);
    if (add.code !== 0) return { error: `git worktree add failed: ${add.err || add.out}` };

    await hydrateWorktree(repo, wt);

    // Only merge the base in when the branch is actually behind it.
    const baseRef = `origin/${base}`;
    let mergeConflict = false;
    const upToDate = await run("git", ["merge-base", "--is-ancestor", baseRef, "HEAD"], wt);
    if (upToDate.code !== 0) {
      const merge = await run("git", ["merge", "--no-edit", baseRef], wt);
      if (merge.code !== 0) {
        const unmerged = await run("git", ["ls-files", "-u"], wt);
        if (unmerged.out) {
          mergeConflict = true; // leave the conflict in the tree for the agent to resolve
        } else {
          await run("git", ["merge", "--abort"], wt);
          return { error: `git merge ${baseRef} failed: ${merge.err || merge.out}` };
        }
      }
    }
    return { path: wt, base, mergeConflict };
  });
}

/**
 * Commit whatever the agent changed, push the branch, and open (or find) the PR.
 * Runs inside the worktree. Returns { url } | { noChanges: true } | { error }.
 */
export async function finishPr(wt, { branch, base, title }) {
  const add = await run("git", ["add", "-A"], wt);
  if (add.code !== 0) return { error: `git add failed: ${add.err || add.out}` };
  // Unstage the worktree-hydration artifacts so they never land in the PR: the
  // node_modules symlink slips past a `node_modules/` (dir-only) .gitignore rule
  // because git treats a symlink as a non-directory, and a copied .env would leak
  // if the repo doesn't ignore it. Resetting unstaged paths is a harmless no-op.
  await run("git", ["reset", "-q", "--", "node_modules", ".env", ".env.local"], wt);
  const staged = await run("git", ["diff", "--cached", "--name-only"], wt);
  if (staged.out) {
    const commit = await run("git", ["commit", "-m", title || "agent task"], wt);
    if (commit.code !== 0) return { error: `git commit failed: ${commit.err || commit.out}` };
  }

  const ahead = await run("git", ["rev-list", "--count", `${base}..${branch}`], wt);
  if ((Number(ahead.out) || 0) === 0) return { noChanges: true };

  const push = await run("git", ["push", "-u", "origin", branch], wt);
  if (push.code !== 0) return { error: `git push failed: ${push.err || push.out}` };

  // Build the PR description from the branch's diffstat so reviewers get a summary
  // of what changed (falls back to a bare body if the numstat read fails).
  const numstat = await run("git", ["diff", "--numstat", `${base}..${branch}`], wt);
  const body = prBody({ title, files: numstat.code === 0 ? parseNumstat(numstat.out) : [] });
  const create = await run(
    "gh",
    ["pr", "create", "--title", title || "agent task", "--body", body, "--head", branch, "--base", base],
    wt,
  );
  let url = create.code === 0 ? extractPrUrl(create.out) || extractPrUrl(create.err) : null;
  if (!url) {
    // A PR may already exist for this branch (e.g. a re-run) — look it up.
    const view = await run("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], wt);
    if (view.code === 0) url = extractPrUrl(view.out);
  }
  if (!url) return { error: `gh pr create failed: ${create.err || create.out}` };
  return { url };
}

/**
 * Finish a REVISE pass: stage the agent's edits (dropping hydration artifacts),
 * complete the in-progress merge if there was a conflict (refusing while markers
 * remain), otherwise commit the fixes, then push to the EXISTING PR branch — a
 * fast-forward, since createReviseWorktree built on origin/<branch> — and resolve
 * the PR url. Returns { url } | { noChanges: true } | { error }.
 */
export async function finishRevise(wt, { branch, title, note, mergeConflict }) {
  const add = await run("git", ["add", "-A"], wt);
  if (add.code !== 0) return { error: `git add failed: ${add.err || add.out}` };
  await run("git", ["reset", "-q", "--", "node_modules", ".env", ".env.local"], wt);

  if (mergeConflict) {
    // Refuse to finish while conflict markers linger (git flags "leftover conflict
    // marker"; whitespace-only --check noise is ignored by the marker match).
    const check = await run("git", ["diff", "--cached", "--check"], wt);
    if (check.code !== 0 && /conflict marker/i.test(`${check.out}\n${check.err}`)) {
      return { error: "unresolved merge conflicts remain in the worktree" };
    }
    const commit = await run("git", ["commit", "--no-edit"], wt);
    if (commit.code !== 0) return { error: `git commit (merge) failed: ${commit.err || commit.out}` };
  } else {
    const staged = await run("git", ["diff", "--cached", "--name-only"], wt);
    if (staged.out) {
      const msg = `revise: ${(note || title || "agent task").trim()}`.slice(0, 72);
      const commit = await run("git", ["commit", "-m", msg], wt);
      if (commit.code !== 0) return { error: `git commit failed: ${commit.err || commit.out}` };
    }
  }

  // Nothing new on top of what the PR already shows → don't push.
  const ahead = await run("git", ["rev-list", "--count", `origin/${branch}..HEAD`], wt);
  if ((Number(ahead.out) || 0) === 0) return { noChanges: true };

  const push = await run("git", ["push", "origin", branch], wt);
  if (push.code !== 0) return { error: `git push failed: ${push.err || push.out}` };

  const view = await run("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], wt);
  const url = view.code === 0 ? extractPrUrl(view.out) : null;
  if (!url) return { error: `pushed, but couldn't resolve PR url for ${branch}: ${view.err || view.out}` };
  return { url };
}

/**
 * The diff of everything the agent changed in the worktree, for the review gate.
 * Stages all changes (so new files show too), unstages the hydration artifacts the
 * same way finishPr does (node_modules symlink + .env copies), then returns the
 * cached diff capped to `maxBytes` so a huge change can't blow up the review prompt.
 * Staging here is harmless — finishPr re-runs `git add -A` before committing.
 */
export async function worktreeDiff(wt, { maxBytes = 60000 } = {}) {
  await run("git", ["add", "-A"], wt);
  await run("git", ["reset", "-q", "--", "node_modules", ".env", ".env.local"], wt);
  const diff = await run("git", ["diff", "--cached"], wt);
  const text = diff.out || "";
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… (diff truncated)` : text;
}

/** Tear down the task's worktree (best-effort), serialized per repo. */
export async function removeWorktree(repo, wt) {
  await withRepoLock(repo, async () => {
    await run("git", ["worktree", "remove", "--force", wt], repo);
    await fsp.rm(wt, { recursive: true, force: true }).catch(() => {});
    await run("git", ["worktree", "prune"], repo);
  });
}

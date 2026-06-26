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
import { worktreePath } from "./routes.mjs";

const WORKTREE_BASE = process.env.AGENT_WORKTREE_DIR || path.join(os.tmpdir(), "atb-worktrees");

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out: out.trim(), err: e.message }));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
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

  const create = await run("gh", ["pr", "create", "--fill", "--head", branch, "--base", base], wt);
  let url = create.code === 0 ? extractPrUrl(create.out) || extractPrUrl(create.err) : null;
  if (!url) {
    // A PR may already exist for this branch (e.g. a re-run) — look it up.
    const view = await run("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], wt);
    if (view.code === 0) url = extractPrUrl(view.out);
  }
  if (!url) return { error: `gh pr create failed: ${create.err || create.out}` };
  return { url };
}

/** Tear down the task's worktree (best-effort), serialized per repo. */
export async function removeWorktree(repo, wt) {
  await withRepoLock(repo, async () => {
    await run("git", ["worktree", "remove", "--force", wt], repo);
    await fsp.rm(wt, { recursive: true, force: true }).catch(() => {});
    await run("git", ["worktree", "prune"], repo);
  });
}

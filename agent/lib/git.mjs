// Dispatcher-driven git/PR flow: after the agent edits the repo, the DISPATCHER
// (not the agent) branches, commits, pushes, and opens the PR — deterministic,
// not reliant on the model following instructions. Every function shells out to
// `git`/`gh`; they're impure (like prs.mjs's prState) so they aren't unit-tested.

import { spawn } from "node:child_process";
import { extractPrUrl } from "./prs.mjs";

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

/**
 * Verify cwd is a git repo with a CLEAN tree (so we never sweep unrelated
 * uncommitted work into the PR). Returns the current branch as the PR base.
 */
export async function preflight(cwd) {
  const repo = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  if (repo.code !== 0) return { ok: false, error: `not a git repo: ${cwd}` };
  const dirty = await run("git", ["status", "--porcelain"], cwd);
  if (dirty.out) {
    return { ok: false, error: `working tree not clean in ${cwd} — refusing to auto-commit unrelated changes` };
  }
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch.code !== 0) return { ok: false, error: `couldn't read current branch: ${branch.err}` };
  return { ok: true, base: branch.out };
}

/** Create + switch to the task branch (carrying the clean tree forward). */
export async function startBranch(cwd, branch) {
  const r = await run("git", ["checkout", "-b", branch], cwd);
  return { ok: r.code === 0, error: r.err || r.out };
}

/**
 * Commit whatever the agent changed, push the branch, and open the PR (or find
 * an existing one for re-runs). Returns { url } | { noChanges: true } | { error }.
 */
export async function finishPr(cwd, { branch, base, title }) {
  const dirty = await run("git", ["status", "--porcelain"], cwd);
  if (dirty.out) {
    const add = await run("git", ["add", "-A"], cwd);
    if (add.code !== 0) return { error: `git add failed: ${add.err || add.out}` };
    const commit = await run("git", ["commit", "-m", title || "agent task"], cwd);
    if (commit.code !== 0) return { error: `git commit failed: ${commit.err || commit.out}` };
  }

  const ahead = await run("git", ["rev-list", "--count", `${base}..${branch}`], cwd);
  if ((Number(ahead.out) || 0) === 0) return { noChanges: true };

  const push = await run("git", ["push", "-u", "origin", branch], cwd);
  if (push.code !== 0) return { error: `git push failed: ${push.err || push.out}` };

  const create = await run("gh", ["pr", "create", "--fill", "--head", branch, "--base", base], cwd);
  let url = create.code === 0 ? extractPrUrl(create.out) || extractPrUrl(create.err) : null;
  if (!url) {
    // A PR may already exist for this branch (e.g. a re-run) — look it up.
    const view = await run("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], cwd);
    if (view.code === 0) url = extractPrUrl(view.out);
  }
  if (!url) return { error: `gh pr create failed: ${create.err || create.out}` };
  return { url };
}

/** Best-effort: return the repo to the branch we started on. */
export async function restore(cwd, base) {
  if (base) await run("git", ["checkout", base], cwd);
}

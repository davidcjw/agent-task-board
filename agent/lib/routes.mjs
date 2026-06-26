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

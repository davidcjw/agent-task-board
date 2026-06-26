// Filesystem side of repo resolution (impure — reads ~/code), kept apart from
// the pure matchers in routes.mjs. The Telegram bot lists the repos here and
// matches a typed `/slug` against them with `matchRepoSlug`.

import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where bare repo names resolve. Same default as the dispatcher's REPO_BASE. */
export const REPO_BASE = process.env.AGENT_REPO_BASE || path.join(os.homedir(), "code");

/** Sorted directory names directly under `base` (dotfiles skipped). [] on error. */
export function listRepos(base = REPO_BASE) {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

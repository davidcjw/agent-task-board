// PR helpers for the merge-watcher. `extractPrUrl` and `isMerged` are pure (and
// unit-tested); `prState` shells out to `gh` and is only called when a Review
// task actually carries a PR URL.

import { spawn } from "node:child_process";

const PR_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i;

/** The first GitHub PR URL found anywhere in a blob of text, or null. */
export function extractPrUrl(text) {
  if (!text) return null;
  const m = String(text).match(PR_RE);
  return m ? m[0] : null;
}

/** A PR counts as merged when gh reports state MERGED (mergedAt is the stamp). */
export function isMerged(info) {
  return Boolean(info && (info.state === "MERGED" || info.mergedAt));
}

/** A PR counts as closed-without-merge when gh reports state CLOSED and it was
 *  never merged (no mergedAt) — i.e. you rejected it. */
export function isClosed(info) {
  return Boolean(info && info.state === "CLOSED" && !info.mergedAt);
}

/**
 * Ask `gh` for a PR's merge state.
 * Resolves `{ state, mergedAt }` on success, or `{ error }` (gh missing, not
 * authed, bad URL) — never rejects, so the watcher loop can keep going.
 */
export function prState(url) {
  return new Promise((resolve) => {
    const child = spawn("gh", ["pr", "view", url, "--json", "state,mergedAt"], { env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ error: e.code === "ENOENT" ? "gh not found on PATH" : e.message }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ error: err.trim() || `gh exited ${code}` });
      try {
        const j = JSON.parse(out);
        resolve({ state: j.state || null, mergedAt: j.mergedAt || null });
      } catch {
        resolve({ error: "could not parse gh output" });
      }
    });
  });
}

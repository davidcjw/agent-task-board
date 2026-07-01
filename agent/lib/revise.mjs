// Pure helpers for the Telegram `/revise` flow: parse the command, pick the
// revise-capable Review cards (those carrying an open PR to update), resolve a
// typed id-prefix to one, label it, and build the send-back patch. Impure bits
// (fetching the board, PATCHing) live in telegram-bot.mjs. Unit-tested in
// revise.test.mjs.

import { extractPrUrl } from "./prs.mjs";
import { repoFromTags, REVISE_TAG } from "./routes.mjs";

/**
 * Parse the text after `/revise ` into `{ idPrefix, note }`: the first token is
 * the target card's id-prefix, the rest is the free-text correction.
 */
export function parseReviseCommand(arg) {
  const s = String(arg || "").trim();
  if (!s) return { idPrefix: "", note: "" };
  const m = s.match(/^(\S+)\s*([\s\S]*)$/);
  return { idPrefix: m[1], note: m[2].trim() };
}

/** Review cards that can be sent back: they carry an open PR (in `result`) to update. */
export function reviseCandidates(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => t && extractPrUrl(t.result));
}

/** The PR number from a task's result, or null. */
export function prNumberOf(task) {
  const m = /\/pull\/(\d+)/.exec(extractPrUrl(task && task.result) || "");
  return m ? m[1] : null;
}

/**
 * Resolve a typed id (prefix or full) to a single revise candidate. Returns
 * `{ match, candidates }` — `match` is the unique task or null; `candidates` is
 * every candidate whose id starts with the query (so the caller can distinguish
 * "ambiguous" from "no match").
 */
export function matchReviseTask(tasks, query) {
  const q = String(query || "").trim().toLowerCase();
  const list = Array.isArray(tasks) ? tasks : [];
  if (!q) return { match: null, candidates: [] };
  const candidates = list.filter((t) => t && String(t.id).toLowerCase().startsWith(q));
  return { match: candidates.length === 1 ? candidates[0] : null, candidates };
}

/** Short one-line label for a revise candidate: title · repo · #prNum. */
export function reviseLabel(task) {
  const repo = repoFromTags((task && task.tags) || []);
  const num = prNumberOf(task);
  const bits = [(task && task.title) || "untitled"];
  if (repo) bits.push(repo);
  if (num) bits.push(`#${num}`);
  return bits.join(" · ");
}

/** The list body for bare `/revise` (or a no-match), showing what can be sent back. */
export function reviseListText(tasks, cap = 12) {
  const list = reviseCandidates(tasks);
  if (!list.length) return "No Review cards with an open PR to send back.";
  const lines = list.slice(0, cap).map((t) => `• ${String(t.id).slice(0, 8)} — ${reviseLabel(t)}`);
  return "↩️ Review cards you can send back — reply `/revise <id> <correction>`:\n" + lines.join("\n");
}

/**
 * Build the send-back patch (mirrors lib/board.ts `revisePatch`): back to Queued,
 * add the `revise` tag (deduped server-side by updateTask's tag normalization),
 * stamp the trimmed correction as `reviseNote`. `sessionId`/`result`/`createdAt`
 * are left untouched by the PATCH, so the dispatcher can resume + FIFO re-picks it.
 */
export function revisePatch(task, note) {
  return {
    status: "queued",
    tags: [...((task && task.tags) || []), REVISE_TAG],
    reviseNote: String(note || "").trim(),
  };
}

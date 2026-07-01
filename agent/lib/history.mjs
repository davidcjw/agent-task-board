// Durable run-history for the dispatcher: one JSON line per finished task in
// `.data/history.jsonl`. `historyRecord` normalizes a task's outcome into a plain
// object (pure); `appendHistory` writes it (impure, best-effort like pending.mjs).
// `readHistory` + `summarizeHistory` back the `npm run history` stats CLI — the
// summary is pure so it's deterministic and unit-tested.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const HISTORY_FILE = path.join(process.cwd(), ".data", "history.jsonl");

const str = (v) => (v == null ? "" : String(v));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Normalize a run outcome into a flat, serializable record. Pure — all types are
 * coerced and missing fields defaulted, so a partial call never yields NaN/undefined.
 * `reviewScore` is a number when the review gate ran, else null; `at` defaults to 0
 * (callers pass Date.now()).
 */
export function historyRecord({
  id,
  title,
  agent,
  repo,
  status,
  durationMs,
  reviewScore,
  prUrl,
  error,
  at,
} = {}) {
  return {
    id: str(id),
    title: str(title),
    agent: str(agent),
    repo: str(repo),
    status: str(status),
    durationMs: Math.max(0, num(durationMs)),
    reviewScore: reviewScore == null || !Number.isFinite(Number(reviewScore)) ? null : Number(reviewScore),
    prUrl: str(prUrl),
    error: Boolean(error),
    at: num(at),
  };
}

/** Append one record as a JSONL line. Best-effort: swallows fs errors, returns bool. */
export function appendHistory(record, file = HISTORY_FILE) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Parse the JSONL log into an array of records, skipping malformed lines. */
export function readHistory(file = HISTORY_FILE) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return []; // absent/unreadable → empty history
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* malformed line — skip */
    }
  }
  return records;
}

const bump = (map, key) => {
  const k = key || "(none)";
  map[k] = (map[k] || 0) + 1;
};

/**
 * Aggregate records into summary stats. Pure. `successRate` is the fraction of
 * non-error runs (0 when empty); `avgDurationMs` averages `durationMs`.
 */
export function summarizeHistory(records) {
  const list = Array.isArray(records) ? records : [];
  const total = list.length;
  const byStatus = {};
  const byRepo = {};
  const byAgent = {};
  let successes = 0;
  let totalDuration = 0;
  for (const r of list) {
    bump(byStatus, r.status);
    bump(byRepo, r.repo);
    bump(byAgent, r.agent);
    if (!r.error) successes += 1;
    totalDuration += Math.max(0, num(r.durationMs));
  }
  return {
    total,
    byStatus,
    successRate: total ? successes / total : 0,
    avgDurationMs: total ? totalDuration / total : 0,
    byRepo,
    byAgent,
  };
}

// Scout memory — the ledger that turns the 2-hourly scout from a cold re-read of
// every repo into an incremental one. Two jobs:
//
//  1. SKIP UNCHANGED REPOS. Each run fingerprints every repo by its HEAD commit
//     (`+dirty` when the tree has uncommitted changes); a repo is deep-scanned
//     only when its fingerprint moved since the last scan (or it's new, or a
//     periodic full sweep is due). On a typical day only a handful of repos
//     changed, so the model scan stays small and cheap.
//
//  2. KEEP A BACKLOG. A scan ranks many ideas but only the single best is
//     proposed per run; the rest are persisted as a ranked `ideas` backlog so a
//     quiet run (nothing changed) still has something to propose — the #2–#5 from
//     earlier scans. Proposing an idea drops it from the backlog; only an
//     ACCEPTED idea (✅ / headless direct-queue) is recorded in `accepted` and
//     permanently suppressed. A rejected or ignored idea is NOT suppressed, so a
//     later scan can resurface it. Fresh scans dedupe against the backlog + the
//     accepted list.
//
// The pure ledger logic is deterministic and unit-tested in scout-memory.test.mjs;
// the fs read/write and git fingerprinting are the impure tail. Dedup/merge of the
// backlog itself needs idea SCORING, so it lives next to rankIdeas in lib/scout.mjs
// (mergeBacklog) — this module just persists what that produces and keys are
// carried on each idea (`idea.key`) so the memory ops here need no scoring import.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "./git.mjs";
import { REPO_BASE } from "./repos.mjs";

export const MEMORY_VERSION = 2;

/**
 * How long before scout force-rescans the whole workspace regardless of
 * fingerprints. With SHA-skip, unchanged repos are otherwise never revisited, so
 * this periodic sweep is also what gives a stagnant-but-improvable repo a fresh
 * look. Tunable via SCOUT_FULL_SCAN_MS; defaults to 24h.
 */
export const FULL_SCAN_INTERVAL_MS = Number(process.env.SCOUT_FULL_SCAN_MS) || 24 * 60 * 60 * 1000;

/** Cap on the remembered accepted ideas (newest-first) used to suppress repeats. */
export const ACCEPTED_CAP = 200;

const MEMORY_FILE = path.join(process.cwd(), ".data", "scout-memory.json");

/** A fresh, empty ledger. */
export function emptyMemory() {
  return { version: MEMORY_VERSION, repos: {}, ideas: [], accepted: [], lastFullScanAt: 0 };
}

/** Coerce any parsed value into a well-formed ledger (fails safe to empty). */
export function normalizeMemory(mem) {
  if (!mem || typeof mem !== "object") return emptyMemory();
  return {
    version: MEMORY_VERSION,
    repos: mem.repos && typeof mem.repos === "object" ? mem.repos : {},
    ideas: Array.isArray(mem.ideas) ? mem.ideas : [],
    accepted: Array.isArray(mem.accepted) ? mem.accepted : [],
    lastFullScanAt: Number.isFinite(mem.lastFullScanAt) ? mem.lastFullScanAt : 0,
  };
}

/** The stored ledger, or a fresh empty one if absent/unreadable. */
export function readMemory() {
  try {
    return normalizeMemory(JSON.parse(readFileSync(MEMORY_FILE, "utf8")));
  } catch {
    return emptyMemory();
  }
}

/** Persist the ledger (overwrites). Returns true on success. */
export function writeMemory(memory) {
  try {
    mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * A repo's change fingerprint: its HEAD sha, marked `+dirty` when the working
 * tree has uncommitted changes, and a stable `nogit` sentinel when it isn't a
 * readable git repo (so a non-repo folder is still skippable once scanned).
 * Impure — shells git via git.mjs's `run`.
 */
export async function repoFingerprint(name, base = REPO_BASE) {
  const dir = path.join(base, name);
  const head = await run("git", ["rev-parse", "HEAD"], dir);
  if (head.code !== 0 || !head.out) return "nogit";
  const status = await run("git", ["status", "--porcelain"], dir);
  return status.out ? `${head.out}+dirty` : head.out;
}

/** Fingerprint every repo, returning a name→fingerprint map. */
export async function repoFingerprints(repos, base = REPO_BASE) {
  const entries = await Promise.all(repos.map(async (r) => [r, await repoFingerprint(r, base)]));
  return Object.fromEntries(entries);
}

/** Has it been long enough since the last full sweep to force one now? */
export function dueForFullScan(memory, now, intervalMs = FULL_SCAN_INTERVAL_MS) {
  const last = Number(normalizeMemory(memory).lastFullScanAt) || 0;
  return now - last >= intervalMs;
}

/**
 * Which repos need a deep scan this run: those whose fingerprint changed since
 * the last scan, plus any never scanned. Everything unchanged is skipped — that's
 * the cost saving. Returns { scan, skipped } (arrays of names).
 */
export function reposToScan(repos, fingerprints, memory) {
  const mem = normalizeMemory(memory);
  const scan = [];
  const skipped = [];
  for (const name of Array.isArray(repos) ? repos : []) {
    const rec = mem.repos[name];
    const fp = fingerprints ? fingerprints[name] : undefined;
    if (!rec || rec.sha !== fp) scan.push(name);
    else skipped.push(name);
  }
  return { scan, skipped };
}

/**
 * Stamp the scanned repos' current fingerprints so unchanged ones skip next time.
 * `full` marks a workspace-wide sweep (resets the full-scan clock). Pure: returns
 * a new ledger.
 */
export function recordScan(memory, { scanned = [], fingerprints = {}, now = 0, full = false } = {}) {
  const mem = normalizeMemory(memory);
  const repos = { ...mem.repos };
  for (const name of scanned) {
    repos[name] = { sha: fingerprints[name] ?? repos[name]?.sha ?? null, scannedAt: now };
  }
  return { ...mem, repos, lastFullScanAt: full ? now : mem.lastFullScanAt };
}

/** Replace the persisted idea backlog (already merged + ranked by mergeBacklog). */
export function setBacklog(memory, ideas) {
  return { ...normalizeMemory(memory), ideas: Array.isArray(ideas) ? ideas : [] };
}

/** The set of accepted idea keys — the only ones permanently suppressed in dedup. */
export function acceptedKeySet(memory) {
  return new Set(
    normalizeMemory(memory)
      .accepted.map((p) => p && p.key)
      .filter(Boolean),
  );
}

/** The top (best-ranked) backlog idea to propose next, or null when empty. */
export function topIdea(memory) {
  return normalizeMemory(memory).ideas[0] || null;
}

/**
 * Drop an idea from the backlog by key — used the moment it's PROPOSED (so a
 * quiet run advances to the next idea instead of re-pitching this one). It is NOT
 * recorded as accepted, so a later scan can resurface it if you didn't take it.
 * Pure: returns a new ledger.
 */
export function dropIdea(memory, key) {
  const mem = normalizeMemory(memory);
  return { ...mem, ideas: mem.ideas.filter((i) => i && i.key !== key) };
}

/**
 * Record an idea as ACCEPTED (✅ tap, or headless direct-queue): drop it from the
 * backlog and add its key to the capped `accepted` list so it's never proposed
 * again. This is the only permanent suppression. Pure: returns a new ledger.
 */
export function recordAccepted(memory, key, { title = "", repo = "", now = 0 } = {}, cap = ACCEPTED_CAP) {
  const mem = normalizeMemory(memory);
  const ideas = mem.ideas.filter((i) => i && i.key !== key);
  const accepted = [{ key, title, repo, at: now }, ...mem.accepted.filter((p) => p && p.key !== key)].slice(0, cap);
  return { ...mem, ideas, accepted };
}

/**
 * Titles to tell the model not to re-suggest: everything still in the backlog
 * plus everything accepted (deduped, capped). Rejected/ignored ideas are NOT
 * listed, so the model is free to surface them again.
 */
export function avoidTitles(memory, limit = 40) {
  const mem = normalizeMemory(memory);
  const titles = [...mem.ideas, ...mem.accepted]
    .map((i) => (i && i.title ? (i.repo ? `${i.title} (${i.repo})` : i.title) : ""))
    .filter(Boolean);
  return [...new Set(titles)].slice(0, limit);
}

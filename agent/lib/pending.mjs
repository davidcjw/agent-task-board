// The scout's pending-proposal store: a single JSON file holding the one idea
// currently awaiting your Telegram Yes/No. Written by scout.mjs (the producer)
// and read/cleared by telegram-bot.mjs (which acts on your tap). Impure (fs) —
// the pure validity/serialization helpers live in lib/scout.mjs. There is at
// most ONE pending proposal at a time: scout pauses while it's active, so this
// file is either absent or the single live offer.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const PENDING_FILE = path.join(process.cwd(), ".data", "scout-pending.json");

/** The current pending proposal, or null if none / unreadable. */
export function readPending() {
  try {
    return JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** Persist the pending proposal (overwrites any prior one). */
export function writePending(proposal) {
  try {
    mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify(proposal, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Remove the pending proposal (answered or expired). No-op if absent. */
export function clearPending() {
  try {
    rmSync(PENDING_FILE);
  } catch {
    /* already gone — fine */
  }
}

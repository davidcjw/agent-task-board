// localStorage persistence + JSON import/export. The board is local-first:
// nothing leaves the browser unless the user explicitly exports.

import { emptyState, reconcile, SCHEMA_VERSION } from "./board";
import type { BoardState } from "./types";

export const STORAGE_KEY = "agent-task-board:v1";

interface Persisted {
  version: number;
  state: BoardState;
  savedAt: number;
}

/** Load board state from localStorage, returning an empty board on any failure. */
export function loadState(): BoardState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || typeof parsed !== "object" || !parsed.state) return emptyState();
    return reconcile(parsed.state);
  } catch {
    return emptyState();
  }
}

/** Persist board state. Silently no-ops outside the browser. */
export function saveState(state: BoardState): void {
  if (typeof window === "undefined") return;
  try {
    const payload: Persisted = { version: SCHEMA_VERSION, state, savedAt: Date.now() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota or privacy mode — fail quietly; the in-memory board still works.
  }
}

/** Serialize the board to a pretty JSON string for download. */
export function exportState(state: BoardState): string {
  const payload: Persisted = { version: SCHEMA_VERSION, state, savedAt: Date.now() };
  return JSON.stringify(payload, null, 2);
}

/** Parse an imported JSON string into a reconciled board, or throw on bad input. */
export function importState(json: string): BoardState {
  const parsed = JSON.parse(json);
  // Accept both the wrapped { version, state } shape and a bare BoardState.
  const candidate: BoardState =
    parsed && typeof parsed === "object" && "state" in parsed ? parsed.state : parsed;
  if (!candidate || typeof candidate !== "object" || !("tasks" in candidate)) {
    throw new Error("Unrecognised board file: missing tasks.");
  }
  return reconcile(candidate as BoardState);
}

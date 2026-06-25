// Local-first engine: the board lives in this tab's localStorage. This is the
// default mode and what the public demo uses.

import {
  addTask,
  clearBoard,
  commitDrag,
  createTask,
  deleteTask,
  moveTask,
  updateTask,
} from "./board";
import { STORAGE_KEY, loadState, saveState } from "./storage";
import { seedState } from "./seed";
import { EMPTY, type BoardEngine } from "./boardEngine";
import type { BoardState } from "./types";

let current: BoardState = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(next: BoardState) {
  current = next;
  saveState(current);
  emit();
}

export const localEngine: BoardEngine = {
  mode: "local",
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => current,
  getServerSnapshot: () => EMPTY,
  hydrate() {
    if (hydrated) return;
    hydrated = true;
    let initial: BoardState;
    try {
      initial = window.localStorage.getItem(STORAGE_KEY) ? loadState() : seedState();
    } catch {
      initial = seedState();
    }
    set(initial);
  },
  addTask: (input) => set(addTask(current, createTask(input))),
  updateTask: (id, patch) => set(updateTask(current, id, patch)),
  deleteTask: (id) => set(deleteTask(current, id)),
  moveTask: (id, toStatus, toIndex) => set(moveTask(current, id, toStatus, toIndex)),
  commitDrag: (columns, movedId, toStatus) => set(commitDrag(current, columns, movedId, toStatus)),
  restore: (next) => set(next),
  seed: () => set(seedState()),
  clear: () => set(clearBoard()),
};

// Reset hook for tests.
export function __resetLocalEngine() {
  current = EMPTY;
  hydrated = false;
  listeners.clear();
}

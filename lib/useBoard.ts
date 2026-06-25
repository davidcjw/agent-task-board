"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  addTask,
  clearBoard,
  commitDrag,
  createTask,
  deleteTask,
  emptyState,
  moveTask,
  updateTask,
} from "./board";
import { STORAGE_KEY, loadState, saveState } from "./storage";
import { seedState } from "./seed";
import type { BoardState, Status, TaskInput } from "./types";

/*
 * A tiny external store backing the board. Using useSyncExternalStore (rather
 * than useReducer + effects) keeps hydration SSR-safe and avoids setState-in-
 * effect / ref-write-in-render patterns. The EMPTY sentinel doubles as the
 * server snapshot AND the "not yet hydrated" marker.
 */
const EMPTY: BoardState = emptyState();
let current: BoardState = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): BoardState {
  return current;
}

function getServerSnapshot(): BoardState {
  return EMPTY;
}

function set(next: BoardState) {
  current = next;
  saveState(current);
  emit();
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  let initial: BoardState;
  try {
    initial = window.localStorage.getItem(STORAGE_KEY) ? loadState() : seedState();
  } catch {
    initial = seedState();
  }
  set(initial); // persists (so a first-visit seed survives refresh) and notifies
}

export interface BoardApi {
  state: BoardState;
  mounted: boolean;
  addTask: (input: TaskInput) => void;
  updateTask: (id: string, patch: Partial<TaskInput>) => void;
  deleteTask: (id: string) => void;
  moveTask: (id: string, toStatus: Status, toIndex: number) => void;
  commitDrag: (columns: Record<Status, string[]>, movedId: string, toStatus: Status) => void;
  restore: (state: BoardState) => void;
  seed: () => void;
  clear: () => void;
}

export function useBoard(): BoardApi {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    hydrate();
  }, []);

  const actions = useMemo(
    () => ({
      addTask: (input: TaskInput) => set(addTask(current, createTask(input))),
      updateTask: (id: string, patch: Partial<TaskInput>) => set(updateTask(current, id, patch)),
      deleteTask: (id: string) => set(deleteTask(current, id)),
      moveTask: (id: string, toStatus: Status, toIndex: number) =>
        set(moveTask(current, id, toStatus, toIndex)),
      commitDrag: (columns: Record<Status, string[]>, movedId: string, toStatus: Status) =>
        set(commitDrag(current, columns, movedId, toStatus)),
      restore: (next: BoardState) => set(next),
      seed: () => set(seedState()),
      clear: () => set(clearBoard()),
    }),
    [],
  );

  // mounted = client has hydrated (snapshot is no longer the server sentinel).
  const mounted = state !== EMPTY;

  return useMemo<BoardApi>(
    () => ({ state, mounted, ...actions }),
    [state, mounted, actions],
  );
}

// Exposed only for tests that need a clean store between cases.
export function __resetBoardStoreForTests() {
  current = EMPTY;
  hydrated = false;
  listeners.clear();
}

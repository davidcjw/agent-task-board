"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { BOARD_MODE, EMPTY, type BoardEngine } from "./boardEngine";
import { localEngine } from "./localEngine";
import { apiEngine } from "./apiEngine";
import type { BoardState, Status, TaskInput, TaskPatch } from "./types";

// Pick the engine once, at module load, from the build-time mode flag.
const engine: BoardEngine = BOARD_MODE === "api" ? apiEngine : localEngine;

export interface BoardApi {
  state: BoardState;
  mounted: boolean;
  /** "local" = this browser's storage; "live" = server-backed (agents can act on it). */
  mode: "local" | "live";
  addTask: (input: TaskInput) => void;
  updateTask: (id: string, patch: TaskPatch) => void;
  deleteTask: (id: string) => void;
  moveTask: (id: string, toStatus: Status, toIndex: number) => void;
  commitDrag: (columns: Record<Status, string[]>, movedId: string, toStatus: Status) => void;
  restore: (state: BoardState) => void;
  seed: () => void;
  clear: () => void;
}

export function useBoard(): BoardApi {
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getServerSnapshot);

  useEffect(() => {
    engine.hydrate();
  }, []);

  const mounted = state !== EMPTY;

  return useMemo<BoardApi>(
    () => ({
      state,
      mounted,
      mode: engine.mode,
      addTask: engine.addTask,
      updateTask: engine.updateTask,
      deleteTask: engine.deleteTask,
      moveTask: engine.moveTask,
      commitDrag: engine.commitDrag,
      restore: engine.restore,
      seed: engine.seed,
      clear: engine.clear,
    }),
    [state, mounted],
  );
}

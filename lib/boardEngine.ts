import { emptyState } from "./board";
import type { BoardState, Status, TaskInput } from "./types";

/**
 * Shared EMPTY sentinel: it is both the SSR snapshot and the "not yet
 * hydrated" marker, so both engines must reference this exact object.
 */
export const EMPTY: BoardState = emptyState();

/** "local" = browser localStorage; "api" = a live server-backed board. */
export const BOARD_MODE: "local" | "api" =
  process.env.NEXT_PUBLIC_BOARD_MODE === "api" ? "api" : "local";

/** The contract `useBoard` drives, implemented by the local and API engines. */
export interface BoardEngine {
  /** Display label for the current data source. */
  mode: "local" | "live";
  subscribe(listener: () => void): () => void;
  getSnapshot(): BoardState;
  getServerSnapshot(): BoardState;
  hydrate(): void;
  addTask(input: TaskInput): void;
  updateTask(id: string, patch: Partial<TaskInput>): void;
  deleteTask(id: string): void;
  moveTask(id: string, toStatus: Status, toIndex: number): void;
  commitDrag(columns: Record<Status, string[]>, movedId: string, toStatus: Status): void;
  restore(state: BoardState): void;
  seed(): void;
  clear(): void;
}

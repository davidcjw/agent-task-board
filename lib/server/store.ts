// Server-side board store: a JSON file on disk, with all access serialized
// through an in-process async mutex so claims are atomic (one task → one
// agent). Only imported from Route Handlers — never from client components.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  addTask,
  claimNext,
  createTask,
  deleteTask,
  emptyState,
  moveTask,
  reconcile,
  setResult,
  updateTask,
  type ClaimFilter,
} from "@/lib/board";
import { seedState } from "@/lib/seed";
import type { BoardState, Status, Task, TaskInput } from "@/lib/types";

function dataDir(): string {
  return process.env.BOARD_DATA_DIR || path.join(process.cwd(), ".data");
}
function filePath(): string {
  return path.join(dataDir(), "board.json");
}

// --- async mutex: chain operations so reads/writes never interleave ---
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Assumes the lock is held. Seeds + persists on first run so the live board
// (and any worker polling it) starts from the same non-empty state.
async function readLocked(): Promise<BoardState> {
  try {
    const raw = await fs.readFile(filePath(), "utf8");
    return reconcile(JSON.parse(raw));
  } catch {
    const initial = process.env.BOARD_SEED === "0" ? emptyState() : seedState();
    await writeLocked(initial);
    return initial;
  }
}

async function writeLocked(state: BoardState): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = filePath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, filePath());
}

export const store = {
  getBoard(): Promise<BoardState> {
    return withLock(readLocked);
  },

  create(input: TaskInput): Promise<{ task: Task; board: BoardState }> {
    return withLock(async () => {
      const state = await readLocked();
      const task = createTask(input);
      const board = addTask(state, task);
      await writeLocked(board);
      return { task, board };
    });
  },

  update(id: string, patch: Partial<TaskInput>): Promise<BoardState> {
    return withLock(async () => {
      const board = updateTask(await readLocked(), id, patch);
      await writeLocked(board);
      return board;
    });
  },

  move(id: string, toStatus: Status, toIndex: number): Promise<BoardState> {
    return withLock(async () => {
      const board = moveTask(await readLocked(), id, toStatus, toIndex);
      await writeLocked(board);
      return board;
    });
  },

  remove(id: string): Promise<BoardState> {
    return withLock(async () => {
      const board = deleteTask(await readLocked(), id);
      await writeLocked(board);
      return board;
    });
  },

  claim(filter: ClaimFilter, worker: string): Promise<Task | null> {
    return withLock(async () => {
      const { state, task } = claimNext(await readLocked(), filter, worker);
      if (task) await writeLocked(state);
      return task;
    });
  },

  result(
    id: string,
    result: string,
    options: { toStatus?: Status; error?: boolean },
  ): Promise<Task | null> {
    return withLock(async () => {
      const board = setResult(await readLocked(), id, result, options);
      await writeLocked(board);
      return board.tasks[id] ?? null;
    });
  },

  replace(state: BoardState): Promise<BoardState> {
    return withLock(async () => {
      const board = reconcile(state);
      await writeLocked(board);
      return board;
    });
  },
};

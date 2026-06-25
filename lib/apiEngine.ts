// Live engine: the board is server-backed (the /api routes). Mutations proxy
// to the API and a poll keeps the UI in sync with whatever workers / the
// dispatcher / the MCP server do to the queue — so cards move on their own.

import { emptyState, reconcile } from "./board";
import { seedState } from "./seed";
import { EMPTY, type BoardEngine } from "./boardEngine";
import type { BoardState, TaskInput } from "./types";

const POLL_MS = 2000;

let current: BoardState = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setBoard(board: BoardState | null | undefined) {
  if (!board || typeof board !== "object") return;
  current = reconcile(board);
  emit();
}

async function send(method: string, url: string, body?: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) {
      await refresh();
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

async function refresh() {
  try {
    const res = await fetch("/api/board", { cache: "no-store" });
    if (res.ok) setBoard((await res.json()) as BoardState);
  } catch {
    /* offline — keep last snapshot, next poll retries */
  }
}

function applyMutation(data: unknown) {
  // /api/tasks* return { task, board }; /api/board returns the board directly.
  if (data && typeof data === "object" && "board" in data) {
    setBoard((data as { board: BoardState }).board);
  } else {
    setBoard(data as BoardState);
  }
}

export const apiEngine: BoardEngine = {
  mode: "live",
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => current,
  getServerSnapshot: () => EMPTY,
  hydrate() {
    if (hydrated) return;
    hydrated = true;
    // After the first fetch attempt, leave the sentinel even if the server is
    // unreachable, so the UI shows an (empty) board rather than a stuck skeleton.
    void refresh().finally(() => {
      if (current === EMPTY) setBoard(emptyState());
    });
    setInterval(() => void refresh(), POLL_MS);
  },
  addTask: (input: TaskInput) => {
    void send("POST", "/api/tasks", input).then(applyMutation);
  },
  updateTask: (id, patch) => {
    void send("PATCH", `/api/tasks/${id}`, patch).then(applyMutation);
  },
  deleteTask: (id) => {
    void send("DELETE", `/api/tasks/${id}`).then(applyMutation);
  },
  moveTask: (id, toStatus) => {
    void send("PATCH", `/api/tasks/${id}`, { status: toStatus }).then(applyMutation);
  },
  commitDrag: (_columns, movedId, toStatus) => {
    // The server doesn't track intra-lane order; only commit cross-lane moves.
    if (current.tasks[movedId]?.status === toStatus) return;
    void send("PATCH", `/api/tasks/${movedId}`, { status: toStatus }).then(applyMutation);
  },
  restore: (state: BoardState) => {
    void send("POST", "/api/board", state).then(applyMutation);
  },
  seed: () => {
    void send("POST", "/api/board", seedState()).then(applyMutation);
  },
  clear: () => {
    void send("DELETE", "/api/board").then(applyMutation);
  },
};

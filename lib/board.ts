// Pure, framework-free board logic. Everything here is deterministic given
// its inputs (ids and timestamps can be injected) so it is trivially testable.

import { STATUSES } from "./columns";
import type { BoardState, Status, Task, TaskInput } from "./types";

export const SCHEMA_VERSION = 1;

/** An empty board with all four columns present. */
export function emptyState(): BoardState {
  return {
    tasks: {},
    columns: { queued: [], running: [], review: [], done: [] },
  };
}

let idCounter = 0;
/** Generate a reasonably unique id, falling back when crypto is unavailable. */
function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  idCounter += 1;
  return `task_${Date.now().toString(36)}_${idCounter}`;
}

/** Build a fully-formed Task from user input. `id` and `now` are injectable for tests. */
export function createTask(input: TaskInput, now = Date.now(), id = genId()): Task {
  const status = input.status ?? "queued";
  return {
    id,
    title: input.title.trim() || "Untitled task",
    prompt: input.prompt ?? "",
    agent: input.agent.trim(),
    tags: normalizeTags(input.tags),
    notes: input.notes ?? "",
    status,
    createdAt: now,
    updatedAt: now,
    startedAt: status === "running" ? now : undefined,
    completedAt: status === "done" ? now : undefined,
  };
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().replace(/^#/, "");
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Parse a comma/space separated tag string into a clean list. */
export function parseTags(value: string): string[] {
  return normalizeTags(value.split(/[,\n]/));
}

// ---------------------------------------------------------------------------
// Mutations — all return a NEW BoardState, never mutating the input.
// ---------------------------------------------------------------------------

/** Insert a task at the top of its column. */
export function addTask(state: BoardState, task: Task): BoardState {
  return {
    tasks: { ...state.tasks, [task.id]: task },
    columns: {
      ...state.columns,
      [task.status]: [task.id, ...state.columns[task.status]],
    },
  };
}

/** Patch a task's editable fields. If `status` changes, the task is moved too. */
export function updateTask(
  state: BoardState,
  id: string,
  patch: Partial<TaskInput>,
  now = Date.now(),
): BoardState {
  const existing = state.tasks[id];
  if (!existing) return state;

  const nextStatus = patch.status ?? existing.status;
  const updated: Task = {
    ...existing,
    title: patch.title !== undefined ? patch.title.trim() || "Untitled task" : existing.title,
    prompt: patch.prompt !== undefined ? patch.prompt : existing.prompt,
    agent: patch.agent !== undefined ? patch.agent.trim() : existing.agent,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : existing.tags,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    updatedAt: now,
  };

  let next: BoardState = { ...state, tasks: { ...state.tasks, [id]: updated } };
  if (nextStatus !== existing.status) {
    next = moveTask(next, id, nextStatus, 0, now);
  }
  return next;
}

/** Remove a task entirely. */
export function deleteTask(state: BoardState, id: string): BoardState {
  const task = state.tasks[id];
  if (!task) return state;
  const tasks = { ...state.tasks };
  delete tasks[id];
  return {
    tasks,
    columns: {
      ...state.columns,
      [task.status]: state.columns[task.status].filter((tid) => tid !== id),
    },
  };
}

/**
 * Apply startedAt/completedAt bookkeeping for a status change. Returns a new
 * Task; `startedAt` is sticky (set once, the first time work begins) and
 * `completedAt` is set on entering done / cleared when a task is reopened.
 */
function stampStatusChange(task: Task, from: Status, to: Status, now: number): Task {
  const updated: Task = { ...task, status: to, updatedAt: now };
  if (to !== from) {
    if (to === "running" && updated.startedAt === undefined) updated.startedAt = now;
    if (to === "done") updated.completedAt = now;
    else if (from === "done") updated.completedAt = undefined;
  }
  return updated;
}

function cloneColumns(columns: BoardState["columns"]): Record<Status, string[]> {
  return {
    queued: [...columns.queued],
    running: [...columns.running],
    review: [...columns.review],
    done: [...columns.done],
  };
}

/**
 * Move a task to `toStatus` at position `toIndex` (clamped). Handles in-column
 * reordering and cross-column moves, and maintains startedAt/completedAt.
 */
export function moveTask(
  state: BoardState,
  id: string,
  toStatus: Status,
  toIndex: number,
  now = Date.now(),
): BoardState {
  const task = state.tasks[id];
  if (!task) return state;

  const from = task.status;
  const columns = cloneColumns(state.columns);

  // Remove from current column.
  columns[from] = columns[from].filter((tid) => tid !== id);

  // Insert into destination column at clamped index.
  const dest = columns[toStatus];
  const index = Math.max(0, Math.min(toIndex, dest.length));
  dest.splice(index, 0, id);

  const updated = stampStatusChange(task, from, toStatus, now);
  return { tasks: { ...state.tasks, [id]: updated }, columns };
}

/**
 * Commit a drag-and-drop result. The caller supplies the already-reordered
 * column id-lists (computed with dnd-kit's arrayMove, which avoids off-by-one
 * shift bugs); this only reconciles the moved task's status + timestamps.
 */
export function commitDrag(
  state: BoardState,
  columns: Record<Status, string[]>,
  movedId: string,
  toStatus: Status,
  now = Date.now(),
): BoardState {
  const task = state.tasks[movedId];
  if (!task) return { ...state, columns };
  const updated = stampStatusChange(task, task.status, toStatus, now);
  return { columns, tasks: { ...state.tasks, [movedId]: updated } };
}

/** Drop every task. */
export function clearBoard(): BoardState {
  return emptyState();
}

/** Read the ordered task objects for a single column. */
export function tasksForColumn(state: BoardState, status: Status): Task[] {
  return state.columns[status]
    .map((id) => state.tasks[id])
    .filter((t): t is Task => Boolean(t));
}

/** Total number of tasks on the board. */
export function taskCount(state: BoardState): number {
  return Object.keys(state.tasks).length;
}

/**
 * Repair a possibly-malformed state (e.g. from an old export): ensures every
 * column exists, drops ids with no task, and appends orphan tasks to queued.
 */
export function reconcile(state: BoardState): BoardState {
  const base = emptyState();
  const tasks: Record<string, Task> = {};
  for (const [id, task] of Object.entries(state.tasks ?? {})) {
    if (task && typeof task.id === "string") tasks[id] = task;
  }
  const placed = new Set<string>();
  for (const status of STATUSES) {
    const ids = Array.isArray(state.columns?.[status]) ? state.columns[status] : [];
    for (const id of ids) {
      if (tasks[id] && !placed.has(id)) {
        base.columns[status].push(id);
        placed.add(id);
      }
    }
  }
  // Any task not referenced by a column is appended to its declared lane
  // (falling back to queued if the status is unrecognised).
  for (const id of Object.keys(tasks)) {
    if (placed.has(id)) continue;
    const lane = base.columns[tasks[id].status] ?? base.columns.queued;
    lane.push(id);
  }
  base.tasks = tasks;
  return base;
}

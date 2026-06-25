import { describe, expect, it } from "vitest";
import {
  addTask,
  clearBoard,
  commitDrag,
  createTask,
  deleteTask,
  emptyState,
  moveTask,
  normalizeTags,
  parseTags,
  reconcile,
  tasksForColumn,
  taskCount,
  updateTask,
} from "./board";
import type { BoardState, TaskInput } from "./types";

const baseInput: TaskInput = {
  title: "Test task",
  prompt: "Do the thing",
  agent: "Claude Code",
  tags: ["backend"],
  notes: "",
};

function boardWith(...inputs: Array<Partial<TaskInput>>): BoardState {
  let state = emptyState();
  inputs.forEach((input, i) => {
    const task = createTask({ ...baseInput, ...input }, 1000 + i, `t${i}`);
    state = addTask(state, task);
  });
  return state;
}

describe("createTask", () => {
  it("fills defaults and trims the title", () => {
    const t = createTask({ ...baseInput, title: "  Hello  " }, 5, "id1");
    expect(t.id).toBe("id1");
    expect(t.title).toBe("Hello");
    expect(t.status).toBe("queued");
    expect(t.createdAt).toBe(5);
    expect(t.updatedAt).toBe(5);
    expect(t.startedAt).toBeUndefined();
    expect(t.completedAt).toBeUndefined();
  });

  it("falls back to 'Untitled task' for an empty title", () => {
    expect(createTask({ ...baseInput, title: "   " }, 1, "x").title).toBe("Untitled task");
  });

  it("stamps startedAt when created directly into running", () => {
    const t = createTask({ ...baseInput, status: "running" }, 9, "x");
    expect(t.startedAt).toBe(9);
  });

  it("stamps completedAt when created directly into done", () => {
    const t = createTask({ ...baseInput, status: "done" }, 9, "x");
    expect(t.completedAt).toBe(9);
  });
});

describe("tag parsing", () => {
  it("normalizes, dedupes (case-insensitive) and strips leading #", () => {
    expect(normalizeTags(["#API", "api", " backend ", ""])).toEqual(["API", "backend"]);
  });
  it("parses comma and newline separated strings", () => {
    expect(parseTags("frontend, bug\n#urgent")).toEqual(["frontend", "bug", "urgent"]);
  });
});

describe("addTask", () => {
  it("inserts at the top of the column", () => {
    const state = boardWith({ title: "first" }, { title: "second" });
    expect(tasksForColumn(state, "queued").map((t) => t.title)).toEqual(["second", "first"]);
    expect(taskCount(state)).toBe(2);
  });
});

describe("moveTask", () => {
  it("moves a task across columns and stamps startedAt", () => {
    let state = boardWith({ title: "a" });
    const id = state.columns.queued[0];
    state = moveTask(state, id, "running", 0, 2000);
    expect(state.columns.queued).toHaveLength(0);
    expect(state.columns.running).toEqual([id]);
    expect(state.tasks[id].status).toBe("running");
    expect(state.tasks[id].startedAt).toBe(2000);
  });

  it("stamps completedAt entering done and clears it when reopened", () => {
    let state = boardWith({ title: "a" });
    const id = state.columns.queued[0];
    state = moveTask(state, id, "done", 0, 3000);
    expect(state.tasks[id].completedAt).toBe(3000);
    state = moveTask(state, id, "review", 0, 4000);
    expect(state.tasks[id].completedAt).toBeUndefined();
  });

  it("preserves the original startedAt across subsequent moves", () => {
    let state = boardWith({ title: "a" });
    const id = state.columns.queued[0];
    state = moveTask(state, id, "running", 0, 2000);
    state = moveTask(state, id, "review", 0, 2500);
    state = moveTask(state, id, "running", 0, 5000);
    expect(state.tasks[id].startedAt).toBe(2000); // not overwritten
  });

  it("reorders within a column and clamps an out-of-range index", () => {
    let state = boardWith({ title: "a" }, { title: "b" }, { title: "c" });
    // visual top-to-bottom is c, b, a
    const ids = state.columns.queued;
    const last = ids[2];
    state = moveTask(state, last, "queued", 99, 9000); // clamp to end
    expect(state.columns.queued[state.columns.queued.length - 1]).toBe(last);
  });

  it("is immutable — does not mutate the input state", () => {
    const state = boardWith({ title: "a" });
    const snapshot = JSON.stringify(state);
    moveTask(state, state.columns.queued[0], "done", 0, 1);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("ignores an unknown id", () => {
    const state = boardWith({ title: "a" });
    expect(moveTask(state, "nope", "done", 0, 1)).toBe(state);
  });
});

describe("commitDrag", () => {
  it("adopts the supplied column order and stamps the moved task's new status", () => {
    let state = boardWith({ title: "a" }, { title: "b" });
    const id = state.columns.queued[0]; // "b" (top)
    // Simulate dnd-kit moving the task to the running column.
    const columns = {
      queued: state.columns.queued.filter((tid) => tid !== id),
      running: [id],
      review: [],
      done: [],
    };
    state = commitDrag(state, columns, id, "running", 4242);
    expect(state.columns.running).toEqual([id]);
    expect(state.columns.queued).not.toContain(id);
    expect(state.tasks[id].status).toBe("running");
    expect(state.tasks[id].startedAt).toBe(4242);
  });

  it("does not stamp timestamps for a pure in-column reorder", () => {
    let state = boardWith({ title: "a" }, { title: "b" });
    const [first, second] = state.columns.queued;
    const columns = { ...state.columns, queued: [second, first] };
    state = commitDrag(state, columns, first, "queued", 5000);
    expect(state.columns.queued).toEqual([second, first]);
    expect(state.tasks[first].startedAt).toBeUndefined();
  });
});

describe("updateTask", () => {
  it("patches fields and bumps updatedAt", () => {
    let state = boardWith({ title: "a" });
    const id = state.columns.queued[0];
    state = updateTask(state, id, { title: "renamed", tags: ["x", "x", "y"] }, 7777);
    expect(state.tasks[id].title).toBe("renamed");
    expect(state.tasks[id].tags).toEqual(["x", "y"]);
    expect(state.tasks[id].updatedAt).toBe(7777);
  });

  it("moves the task when status changes via edit", () => {
    let state = boardWith({ title: "a" });
    const id = state.columns.queued[0];
    state = updateTask(state, id, { status: "running" }, 8888);
    expect(state.columns.running).toContain(id);
    expect(state.columns.queued).not.toContain(id);
    expect(state.tasks[id].startedAt).toBe(8888);
  });
});

describe("deleteTask", () => {
  it("removes the task from the map and its column", () => {
    let state = boardWith({ title: "a" }, { title: "b" });
    const id = state.columns.queued[0];
    state = deleteTask(state, id);
    expect(state.tasks[id]).toBeUndefined();
    expect(state.columns.queued).not.toContain(id);
    expect(taskCount(state)).toBe(1);
  });
});

describe("clearBoard", () => {
  it("returns an empty board", () => {
    expect(taskCount(clearBoard())).toBe(0);
  });
});

describe("reconcile", () => {
  it("rebuilds a board, drops dangling ids and re-homes orphan tasks", () => {
    const broken = {
      tasks: {
        a: { id: "a", status: "queued" },
        b: { id: "b", status: "running" },
      },
      columns: {
        queued: ["a", "ghost"], // ghost has no task
        running: [], // b is an orphan
        review: [],
        done: [],
      },
    } as unknown as BoardState;
    const fixed = reconcile(broken);
    expect(fixed.columns.queued).toEqual(["a"]);
    expect(fixed.columns.running).toEqual(["b"]); // re-homed by its declared status
    expect(taskCount(fixed)).toBe(2);
  });
});

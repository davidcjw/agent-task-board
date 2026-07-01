import { describe, expect, it } from "vitest";
import {
  addTask,
  claimNext,
  clearBoard,
  commitDrag,
  createTask,
  deleteTask,
  emptyState,
  isArchived,
  moveTask,
  normalizeTags,
  parseTags,
  reconcile,
  REVISE_TAG,
  revisePatch,
  setResult,
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

  it("archives and restores via the archived flag without moving the task", () => {
    let state = boardWith({ title: "a", status: "done" });
    const id = state.columns.done[0];

    state = updateTask(state, id, { archived: true }, 9000);
    expect(state.tasks[id].archivedAt).toBe(9000);
    expect(isArchived(state.tasks[id])).toBe(true);
    expect(state.columns.done).toContain(id); // stays in its lane, just hidden

    state = updateTask(state, id, { archived: false }, 9100);
    expect(state.tasks[id].archivedAt).toBeUndefined();
    expect(isArchived(state.tasks[id])).toBe(false);
  });

  it("leaves archivedAt untouched when a patch omits `archived`", () => {
    let state = boardWith({ title: "a", status: "done" });
    const id = state.columns.done[0];
    state = updateTask(state, id, { archived: true }, 9000);
    state = updateTask(state, id, { title: "renamed" }, 9200);
    expect(state.tasks[id].archivedAt).toBe(9000);
    expect(state.tasks[id].title).toBe("renamed");
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

describe("claimNext", () => {
  function queuedBoard() {
    let state = emptyState();
    // created oldest → newest; addTask unshifts so newest ends up on top.
    state = addTask(state, createTask({ ...baseInput, title: "old", agent: "Claude Code" }, 100, "old"));
    state = addTask(state, createTask({ ...baseInput, title: "mid", agent: "Cursor", tags: ["urgent"] }, 200, "mid"));
    state = addTask(state, createTask({ ...baseInput, title: "new", agent: "Claude Code" }, 300, "new"));
    return state;
  }

  it("claims the oldest queued task FIFO and moves it to running", () => {
    const { state, task } = claimNext(queuedBoard(), {}, "w1", 9000);
    expect(task?.id).toBe("old");
    expect(task?.status).toBe("running");
    expect(task?.claimedBy).toBe("w1");
    expect(task?.startedAt).toBe(9000);
    expect(state.columns.running).toEqual(["old"]);
    expect(state.columns.queued).not.toContain("old");
  });

  it("respects an agent filter", () => {
    const { task } = claimNext(queuedBoard(), { agent: "Cursor" }, "w1", 1);
    expect(task?.id).toBe("mid");
  });

  it("respects a tag filter", () => {
    const { task } = claimNext(queuedBoard(), { tag: "urgent" }, "w1", 1);
    expect(task?.id).toBe("mid");
  });

  it("returns null task when nothing matches", () => {
    const board = queuedBoard();
    const { state, task } = claimNext(board, { agent: "Nobody" }, "w1", 1);
    expect(task).toBeNull();
    expect(state).toBe(board);
  });

  it("never hands the same task to two workers", () => {
    let board = queuedBoard();
    const first = claimNext(board, {}, "w1", 1);
    board = first.state;
    const second = claimNext(board, {}, "w2", 2);
    expect(first.task?.id).not.toBe(second.task?.id);
    expect(first.task?.id).toBe("old");
    expect(second.task?.id).toBe("mid");
  });
});

describe("setResult", () => {
  it("writes the result and moves the task to review by default", () => {
    let state = emptyState();
    state = addTask(state, createTask({ ...baseInput, status: "running" }, 1, "t1"));
    state = setResult(state, "t1", "agent output here", {}, 5000);
    expect(state.tasks.t1.result).toBe("agent output here");
    expect(state.tasks.t1.error).toBe(false);
    expect(state.tasks.t1.status).toBe("review");
    expect(state.columns.review).toContain("t1");
  });

  it("can flag an error and target a custom lane", () => {
    let state = emptyState();
    state = addTask(state, createTask({ ...baseInput, status: "running" }, 1, "t1"));
    state = setResult(state, "t1", "boom", { error: true, toStatus: "done" }, 5000);
    expect(state.tasks.t1.error).toBe(true);
    expect(state.tasks.t1.status).toBe("done");
  });

  it("persists a runner session id when one is reported", () => {
    let state = emptyState();
    state = addTask(state, createTask({ ...baseInput, status: "running" }, 1, "t1"));
    state = setResult(state, "t1", "done", { sessionId: "sess-abc" }, 5000);
    expect(state.tasks.t1.sessionId).toBe("sess-abc");
  });

  it("keeps a previously-captured session id when a later run reports none", () => {
    let state = emptyState();
    state = addTask(state, createTask({ ...baseInput, status: "running" }, 1, "t1"));
    state = setResult(state, "t1", "first", { sessionId: "sess-abc" }, 5000);
    state = setResult(state, "t1", "second", {}, 6000);
    expect(state.tasks.t1.sessionId).toBe("sess-abc");
  });
});

describe("revise (send back)", () => {
  it("revisePatch returns a queued patch with the revise tag and a trimmed note", () => {
    const task = createTask({ ...baseInput, tags: ["backend"] }, 1, "t1");
    const patch = revisePatch(task, "  fix the lint error  ");
    expect(patch.status).toBe("queued");
    expect(patch.tags).toEqual(["backend", REVISE_TAG]);
    expect(patch.reviseNote).toBe("fix the lint error");
  });

  it("sends a Review task back to Queued, keeping session id, result and createdAt", () => {
    let state = emptyState();
    state = addTask(state, createTask({ ...baseInput, status: "running" }, 1000, "t1"));
    state = setResult(state, "t1", "opened a PR", { sessionId: "sess-1" }, 2000);
    expect(state.tasks.t1.status).toBe("review");

    state = updateTask(state, "t1", revisePatch(state.tasks.t1, "rebase onto main"), 3000);
    const t = state.tasks.t1;
    expect(t.status).toBe("queued");
    expect(state.columns.queued).toContain("t1");
    expect(t.tags).toContain(REVISE_TAG);
    expect(t.reviseNote).toBe("rebase onto main");
    expect(t.sessionId).toBe("sess-1"); // preserved so the dispatcher can resume
    expect(t.result).toBe("opened a PR"); // previous output kept for context
    expect(t.createdAt).toBe(1000); // FIFO slot preserved — re-picked next
  });

  it("does not duplicate the revise tag across successive passes", () => {
    let state = emptyState();
    state = addTask(
      state,
      createTask({ ...baseInput, tags: ["backend", REVISE_TAG], status: "running" }, 1000, "t1"),
    );
    state = setResult(state, "t1", "x", {}, 2000);
    state = updateTask(state, "t1", revisePatch(state.tasks.t1, "again"), 3000);
    expect(state.tasks.t1.tags.filter((x) => x === REVISE_TAG)).toHaveLength(1);
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

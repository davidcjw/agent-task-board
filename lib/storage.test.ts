import { describe, expect, it, beforeEach } from "vitest";
import {
  STORAGE_KEY,
  exportState,
  importState,
  loadState,
  saveState,
} from "./storage";
import { addTask, createTask, emptyState, taskCount } from "./board";
import type { BoardState } from "./types";

function sampleBoard(): BoardState {
  const t = createTask(
    { title: "x", prompt: "p", agent: "Claude Code", tags: ["a"], notes: "" },
    100,
    "id1",
  );
  return addTask(emptyState(), t);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("save/load round-trip", () => {
  it("persists and restores board state", () => {
    const board = sampleBoard();
    saveState(board);
    const restored = loadState();
    expect(taskCount(restored)).toBe(1);
    expect(restored.tasks.id1.title).toBe("x");
  });

  it("returns an empty board when nothing is stored", () => {
    expect(taskCount(loadState())).toBe(0);
  });

  it("returns an empty board on corrupt JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(taskCount(loadState())).toBe(0);
  });
});

describe("export/import", () => {
  it("exports pretty JSON that re-imports to an equivalent board", () => {
    const board = sampleBoard();
    const json = exportState(board);
    expect(json).toContain("\n"); // pretty-printed
    const reimported = importState(json);
    expect(taskCount(reimported)).toBe(1);
    expect(reimported.tasks.id1.title).toBe("x");
  });

  it("accepts a bare BoardState (no wrapper)", () => {
    const board = sampleBoard();
    const reimported = importState(JSON.stringify(board));
    expect(taskCount(reimported)).toBe(1);
  });

  it("throws on a file with no tasks field", () => {
    expect(() => importState(JSON.stringify({ hello: "world" }))).toThrow();
  });
});

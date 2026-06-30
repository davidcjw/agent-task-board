import { describe, expect, it } from "vitest";
import {
  cancelCallbackData,
  cancelKeyboard,
  cancelPickerText,
  matchRunningTask,
  parseCancelCallback,
  runningLabel,
} from "./cancel.mjs";

describe("cancelCallbackData / parseCancelCallback", () => {
  it("round-trips a task id", () => {
    expect(parseCancelCallback(cancelCallbackData("abc-123"))).toEqual({ id: "abc-123" });
  });
  it("rejects foreign / malformed callback data", () => {
    expect(parseCancelCallback("scout:yes:1")).toBeNull();
    expect(parseCancelCallback("cancel:")).toBeNull();
    expect(parseCancelCallback("")).toBeNull();
    expect(parseCancelCallback(null)).toBeNull();
  });
});

describe("runningLabel", () => {
  const now = 1_000_000;
  it("shows title · repo · elapsed minutes", () => {
    const t = { title: "Fix login", tags: ["repo:my-app"], startedAt: now - 4 * 60_000 };
    expect(runningLabel(t, now)).toBe("Fix login · my-app · 4m");
  });
  it("omits repo when there's no repo tag, and shows 0m without startedAt", () => {
    expect(runningLabel({ title: "Q", tags: [] }, now)).toBe("Q · 0m");
  });
  it("falls back to 'untitled'", () => {
    expect(runningLabel({ tags: [] }, now)).toBe("untitled · 0m");
  });
});

describe("cancelKeyboard", () => {
  const now = 1_000_000;
  const tasks = [
    { id: "a1", title: "one", tags: ["repo:x"], startedAt: now },
    { id: "b2", title: "two", tags: [], startedAt: now },
  ];
  it("makes one cancel button per task with the right callback data", () => {
    const kb = cancelKeyboard(tasks, now);
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0][0].callback_data).toBe("cancel:a1");
    expect(kb.inline_keyboard[0][0].text).toContain("one");
  });
  it("caps the number of buttons", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `id${i}`, title: `t${i}`, tags: [], startedAt: now }));
    expect(cancelKeyboard(many, now, 8).inline_keyboard).toHaveLength(8);
  });
});

describe("cancelPickerText", () => {
  it("counts the running tasks", () => {
    expect(cancelPickerText([{}, {}, {}])).toContain("3 tasks running");
  });
});

describe("matchRunningTask", () => {
  const tasks = [
    { id: "abc123", title: "a" },
    { id: "abd456", title: "b" },
    { id: "zzz999", title: "c" },
  ];
  it("matches a unique id prefix", () => {
    expect(matchRunningTask(tasks, "abc").match.id).toBe("abc123");
    expect(matchRunningTask(tasks, "zzz").match.title).toBe("c");
  });
  it("returns no match but lists candidates when ambiguous", () => {
    const { match, candidates } = matchRunningTask(tasks, "ab");
    expect(match).toBeNull();
    expect(candidates.map((t) => t.id)).toEqual(["abc123", "abd456"]);
  });
  it("returns no match for an unknown prefix or empty query", () => {
    expect(matchRunningTask(tasks, "xyz").match).toBeNull();
    expect(matchRunningTask(tasks, "").candidates).toEqual([]);
  });
});

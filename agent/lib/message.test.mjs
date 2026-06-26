import { describe, expect, it } from "vitest";
import { parseMessage } from "./message.mjs";

describe("parseMessage", () => {
  it("queues plain text under the default agent", () => {
    const t = parseMessage("Refactor auth and add tests");
    expect(t).toMatchObject({
      agent: "",
      prompt: "Refactor auth and add tests",
      tags: [],
      status: "queued",
    });
    expect(t.title).toBe("Refactor auth and add tests");
  });

  it("reads an [Agent] prefix and strips it from the body", () => {
    const t = parseMessage("[Claude Code] fix the flaky test #bug");
    expect(t.agent).toBe("Claude Code");
    expect(t.tags).toEqual(["bug"]);
    expect(t.prompt).toBe("fix the flaky test #bug");
  });

  it("keeps the colon on a repo: tag (the whole point of the fix)", () => {
    const t = parseMessage("[commit-push] add a favicon #repo:democratizing-claude #ui");
    expect(t.tags).toEqual(["repo:democratizing-claude", "ui"]);
  });

  it("supports org/name and absolute-path repo values", () => {
    expect(parseMessage("ship it #repo:my-org/my-app").tags).toEqual(["repo:my-org/my-app"]);
    expect(parseMessage("ship it #repo:/srv/legacy").tags).toEqual(["repo:/srv/legacy"]);
  });

  it("derives a one-line title capped at 80 chars", () => {
    const long = "a".repeat(100);
    const t = parseMessage(`${long}\nsecond line`);
    expect(t.title).toHaveLength(80);
    expect(t.prompt).toContain("second line");
  });

  it("collapses whitespace in the title", () => {
    expect(parseMessage("hello     world").title).toBe("hello world");
  });

  it("falls back to 'task' for empty input", () => {
    const t = parseMessage("");
    expect(t.title).toBe("task");
    expect(t.tags).toEqual([]);
  });
});

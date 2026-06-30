import { describe, expect, it } from "vitest";
import { notifyBody, parseMessage } from "./message.mjs";

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

  it("extracts a leading /slug repo and strips it from the body", () => {
    const t = parseMessage("/democratizing_claude fix the login bug");
    expect(t.repoSlug).toBe("democratizing_claude");
    expect(t.prompt).toBe("fix the login bug");
    expect(t.title).toBe("fix the login bug");
  });

  it("supports a /slug spelled with hyphens", () => {
    const t = parseMessage("/democratizing-claude ship it");
    expect(t.repoSlug).toBe("democratizing-claude");
    expect(t.prompt).toBe("ship it");
  });

  it("treats a bare /slug as a slug with an empty prompt (tap-to-switch)", () => {
    const t = parseMessage("/democratizing_claude");
    expect(t.repoSlug).toBe("democratizing_claude");
    expect(t.prompt).toBe("");
  });

  it("parses /slug together with an [Agent] prefix and tags", () => {
    const t = parseMessage("/my_app [Claude Code] fix flaky test #bug");
    expect(t.repoSlug).toBe("my_app");
    expect(t.agent).toBe("Claude Code");
    expect(t.tags).toEqual(["bug"]);
    expect(t.prompt).toBe("fix flaky test #bug");
  });

  it("does not treat a mid-path slash as a slug", () => {
    const t = parseMessage("/etc/hosts is broken");
    expect(t.repoSlug).toBe("");
    expect(t.prompt).toBe("/etc/hosts is broken");
  });

  it("leaves repoSlug empty for ordinary messages", () => {
    expect(parseMessage("just do the thing").repoSlug).toBe("");
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

describe("notifyBody", () => {
  const result = [
    "## Summary",
    "",
    "Added a Copy button to the grocery list.",
    "",
    "**Changes:**",
    "",
    "1. `lib/grocery.ts` — new helper",
    "2. `app/plan/page.tsx` — the button",
    "",
    "**Verification:**",
    "- `npm run lint` — clean",
    "",
    "🔍 Review: 90% confidence · 0 blocking · 3 minor · 2 pass(es)",
    "⚠ Flagged: opened below the confidence gate — needs a closer human look.",
    "",
    "BOARD_PR: https://github.com/x/y/pull/7",
  ].join("\n");

  it("drops the Changes section but keeps Summary and Verification", () => {
    const out = notifyBody(result);
    expect(out).toContain("Added a Copy button");
    expect(out).toContain("Verification");
    expect(out).not.toContain("lib/grocery.ts");
    expect(out).not.toMatch(/\*\*Changes:\*\*/);
  });

  it("always includes the review block and strips the BOARD_PR marker", () => {
    const out = notifyBody(result);
    expect(out).toContain("🔍 Review: 90% confidence");
    expect(out).toContain("⚠ Flagged");
    expect(out).not.toContain("BOARD_PR");
  });

  it("never truncates the review block, even when the prose is long", () => {
    const long = "## Summary\n\n" + "x ".repeat(800) + "\n\n## Changes\n\nlots of files\n\n🔍 Review: 99% confidence · 0 blocking · 0 minor · 1 pass(es)";
    const out = notifyBody(long);
    expect(out).toContain("🔍 Review: 99% confidence");
    expect(out).toContain("…");
    expect(out).not.toContain("lots of files");
  });

  it("handles a result with no review block (plain prose)", () => {
    expect(notifyBody("Just answered a question.")).toBe("Just answered a question.");
  });
});

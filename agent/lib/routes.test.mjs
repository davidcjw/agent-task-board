import { describe, expect, it } from "vitest";
import {
  branchName,
  implementPrompt,
  missingRepoTag,
  repoFromTags,
  resolveCwd,
  resolveRepoPath,
  shouldOpenPr,
  worktreePath,
} from "./routes.mjs";

const BASE = "/home/me/code";
const CWD = "/home/me/code/agent-task-board";

describe("repoFromTags", () => {
  it("extracts the repo name from a repo: tag", () => {
    expect(repoFromTags(["repo:democratizing-claude"])).toBe("democratizing-claude");
  });

  it("finds the repo: tag among others and trims it", () => {
    expect(repoFromTags(["urgent", "repo: my-app ", "frontend"])).toBe("my-app");
  });

  it("returns '' when there is no repo: tag", () => {
    expect(repoFromTags(["urgent", "frontend"])).toBe("");
    expect(repoFromTags([])).toBe("");
    expect(repoFromTags(undefined)).toBe("");
  });
});

describe("resolveRepoPath", () => {
  it("joins a bare name under the base dir", () => {
    expect(resolveRepoPath("my-app", BASE)).toBe("/home/me/code/my-app");
  });

  it("uses an absolute path as-is", () => {
    expect(resolveRepoPath("/srv/other/repo", BASE)).toBe("/srv/other/repo");
  });

  it("returns '' for an empty repo", () => {
    expect(resolveRepoPath("", BASE)).toBe("");
  });
});

describe("resolveCwd", () => {
  it("fills {repo} from the task's repo: tag under the base", () => {
    const route = { cwd: "{repo}" };
    const task = { tags: ["repo:democratizing-claude"] };
    expect(resolveCwd(route, task, { base: BASE, cwdBase: CWD })).toBe(
      "/home/me/code/democratizing-claude",
    );
  });

  it("supports a subdirectory after {repo}", () => {
    const route = { cwd: "{repo}/packages/web" };
    const task = { tags: ["repo:monorepo"] };
    expect(resolveCwd(route, task, { base: BASE, cwdBase: CWD })).toBe(
      "/home/me/code/monorepo/packages/web",
    );
  });

  it("falls back to cwdBase when a {repo} route has no repo: tag", () => {
    const route = { cwd: "{repo}" };
    const task = { tags: [] };
    expect(resolveCwd(route, task, { base: BASE, cwdBase: CWD })).toBe(CWD);
  });

  it("resolves a literal cwd relative to cwdBase", () => {
    expect(resolveCwd({ cwd: "." }, { tags: [] }, { base: BASE, cwdBase: CWD })).toBe(CWD);
    expect(resolveCwd({ cwd: "../sibling" }, { tags: [] }, { base: BASE, cwdBase: CWD })).toBe(
      "/home/me/code/sibling",
    );
  });

  it("defaults to cwdBase when no cwd is set", () => {
    expect(resolveCwd({}, { tags: [] }, { base: BASE, cwdBase: CWD })).toBe(CWD);
  });

  it("honours an absolute repo: tag value", () => {
    const route = { cwd: "{repo}" };
    const task = { tags: ["repo:/srv/legacy"] };
    expect(resolveCwd(route, task, { base: BASE, cwdBase: CWD })).toBe("/srv/legacy");
  });
});

describe("missingRepoTag", () => {
  it("is true for a {repo} route with no repo: tag", () => {
    expect(missingRepoTag({ cwd: "{repo}" }, { tags: [] })).toBe(true);
  });

  it("is false once the repo: tag is present", () => {
    expect(missingRepoTag({ cwd: "{repo}" }, { tags: ["repo:x"] })).toBe(false);
  });

  it("is false for a literal-cwd route", () => {
    expect(missingRepoTag({ cwd: "." }, { tags: [] })).toBe(false);
  });
});

describe("shouldOpenPr", () => {
  it("is true for a pr route with a repo: tag", () => {
    expect(shouldOpenPr({ pr: true }, { tags: ["repo:my-app"] })).toBe(true);
  });

  it("is false when the route doesn't opt in", () => {
    expect(shouldOpenPr({ pr: false }, { tags: ["repo:my-app"] })).toBe(false);
    expect(shouldOpenPr({}, { tags: ["repo:my-app"] })).toBe(false);
  });

  it("is false without a repo: tag (a plain question never PRs)", () => {
    expect(shouldOpenPr({ pr: true }, { tags: [] })).toBe(false);
    expect(shouldOpenPr({ pr: true }, { tags: ["bug"] })).toBe(false);
  });
});

describe("branchName", () => {
  it("derives a stable branch from the task id", () => {
    expect(branchName({ id: "abc123" })).toBe("atb/abc123");
  });
});

describe("implementPrompt", () => {
  it("tells the agent to edit only and leave git to the dispatcher", () => {
    const out = implementPrompt("add a favicon");
    expect(out).toMatch(/do NOT commit, push, or open a pull request/i);
    expect(out.endsWith("Task: add a favicon")).toBe(true);
  });
});

describe("worktreePath", () => {
  it("places the worktree under the base dir, named by repo + id", () => {
    expect(worktreePath("/tmp/wt", "/home/me/code/the-chronicle-v2", "abc123")).toBe(
      "/tmp/wt/the-chronicle-v2-abc123",
    );
  });

  it("ignores a trailing slash on the repo path", () => {
    expect(worktreePath("/tmp/wt", "/home/me/code/my-app/", "x")).toBe("/tmp/wt/my-app-x");
  });

  it("falls back to 'repo' when the repo path is empty", () => {
    expect(worktreePath("/tmp/wt", "", "x")).toBe("/tmp/wt/repo-x");
  });
});

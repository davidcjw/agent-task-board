import { describe, expect, it } from "vitest";
import {
  AUTO_RETRY_TAG,
  branchName,
  implementPrompt,
  matchRepoSlug,
  missingRepoTag,
  normalizeRepoKey,
  repoCommandName,
  repoFromTags,
  resolveCwd,
  resolveRepoPath,
  resultStatus,
  shouldOpenPr,
  shouldRequeue,
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

describe("resultStatus", () => {
  it("sends a successful no-PR run straight to Done", () => {
    expect(resultStatus({ execute: true, error: false, prOpened: false })).toBe("done");
  });

  it("keeps a PR task in Review for approval", () => {
    expect(resultStatus({ execute: true, error: false, prOpened: true })).toBe("review");
  });

  it("keeps an errored run in Review", () => {
    expect(resultStatus({ execute: true, error: true, prOpened: false })).toBe("review");
  });

  it("keeps dry-run previews in Review (nothing actually ran)", () => {
    expect(resultStatus({ execute: false, error: false, prOpened: false })).toBe("review");
  });
});

describe("shouldRequeue", () => {
  it("requeues a timed-out task that hasn't been retried yet", () => {
    expect(shouldRequeue({ execute: true, timedOut: true, tags: ["repo:my-app"] })).toBe(true);
  });

  it("does not requeue when the runner finished in time", () => {
    expect(shouldRequeue({ execute: true, timedOut: false, tags: [] })).toBe(false);
  });

  it("is one-shot: a task already carrying the auto-retry tag is not requeued again", () => {
    expect(shouldRequeue({ execute: true, timedOut: true, tags: [AUTO_RETRY_TAG] })).toBe(false);
  });

  it("never requeues in dry-run (nothing actually ran)", () => {
    expect(shouldRequeue({ execute: false, timedOut: true, tags: [] })).toBe(false);
  });

  it("tolerates missing tags", () => {
    expect(shouldRequeue({ execute: true, timedOut: true, tags: undefined })).toBe(true);
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

describe("normalizeRepoKey", () => {
  it("strips separators and lowercases", () => {
    expect(normalizeRepoKey("Democratizing-Claude")).toBe("democratizingclaude");
    expect(normalizeRepoKey("democratizing_claude")).toBe("democratizingclaude");
    expect(normalizeRepoKey("democratizing.claude")).toBe("democratizingclaude");
    expect(normalizeRepoKey(" my repo ")).toBe("myrepo");
  });

  it("is empty for empty / nullish input", () => {
    expect(normalizeRepoKey("")).toBe("");
    expect(normalizeRepoKey(undefined)).toBe("");
  });
});

describe("matchRepoSlug", () => {
  const NAMES = ["democratizing-claude", "agent-task-board", "the-chronicle-v2"];

  it("matches a hyphenated dir from an underscored slug", () => {
    expect(matchRepoSlug("democratizing_claude", NAMES).match).toBe("democratizing-claude");
  });

  it("matches with no separators at all", () => {
    expect(matchRepoSlug("democratizingclaude", NAMES).match).toBe("democratizing-claude");
  });

  it("returns '' with no match when nothing fits", () => {
    const r = matchRepoSlug("nope", NAMES);
    expect(r.match).toBe("");
    expect(r.candidates).toEqual([]);
  });

  it("reports candidates and no single match when ambiguous", () => {
    const r = matchRepoSlug("my_app", ["my-app", "my_app"]);
    expect(r.match).toBe("");
    expect(r.candidates).toEqual(["my-app", "my_app"]);
  });

  it("returns '' for an empty slug", () => {
    expect(matchRepoSlug("", NAMES).match).toBe("");
  });
});

describe("repoCommandName", () => {
  it("lowercases and turns hyphens into underscores", () => {
    expect(repoCommandName("democratizing-claude")).toBe("democratizing_claude");
    expect(repoCommandName("The-Chronicle-v2")).toBe("the_chronicle_v2");
  });

  it("trims leading/trailing underscores and caps at 32 chars", () => {
    expect(repoCommandName("-weird-")).toBe("weird");
    expect(repoCommandName("a".repeat(40))).toHaveLength(32);
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

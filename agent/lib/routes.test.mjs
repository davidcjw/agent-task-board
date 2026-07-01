import { describe, expect, it } from "vitest";
import {
  AUTO_RETRY_TAG,
  branchName,
  implementPrompt,
  isRevise,
  matchRepoSlug,
  missingRepoTag,
  normalizeRepoKey,
  parseNumstat,
  prBody,
  repoCommandName,
  repoFromTags,
  resolveCwd,
  resolveRepoPath,
  resultStatus,
  resumeRoute,
  REVISE_TAG,
  revisePrompt,
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
    expect(out).toMatch(/do NOT run git/i);
    expect(out).toMatch(/do NOT open a/i);
    expect(out.endsWith("Task: add a favicon")).toBe(true);
  });

  it("confines the agent to the worktree and defuses absolute paths", () => {
    const out = implementPrompt("in /Users/foo/code/bar, add CI");
    expect(out).toMatch(/current working directory/i);
    expect(out).toMatch(/absolute/i);
    expect(out).toMatch(/never `cd`/i);
  });
});

describe("isRevise", () => {
  it("detects the revise tag case-insensitively", () => {
    expect(isRevise({ tags: ["repo:foo", REVISE_TAG] })).toBe(true);
    expect(isRevise({ tags: ["repo:foo", "Revise"] })).toBe(true);
    expect(isRevise({ tags: ["repo:foo"] })).toBe(false);
    expect(isRevise({})).toBe(false);
  });
});

describe("resumeRoute", () => {
  const claude = { command: "claude", args: ["-p", "{prompt}", "--output-format", "json"] };
  it("adds --resume <id> to a plain claude route", () => {
    const out = resumeRoute(claude, "sess-1");
    expect(out.args).toEqual(["-p", "{prompt}", "--output-format", "json", "--resume", "sess-1"]);
    expect(claude.args).not.toContain("--resume"); // original untouched
  });
  it("returns the route unchanged when there is no session id (fresh fallback)", () => {
    expect(resumeRoute(claude, undefined)).toBe(claude);
    expect(resumeRoute(claude, "")).toBe(claude);
  });
  it("does not resume non-claude or subagent routes", () => {
    const echo = { command: "echo", args: ["x"] };
    expect(resumeRoute(echo, "sess-1")).toBe(echo);
    const agent = { command: "claude", args: ["-p", "{prompt}", "--agent", "kb"] };
    expect(resumeRoute(agent, "sess-1")).toBe(agent);
  });
});

describe("revisePrompt", () => {
  const task = { prompt: "add a favicon", reviseNote: "CI fails on lint — fix the unused import" };
  it("carries the correction and original task, edit-only + worktree-confined", () => {
    const out = revisePrompt(task);
    expect(out).toMatch(/Correction to apply: CI fails on lint/);
    expect(out).toMatch(/Original task: add a favicon/);
    expect(out).toMatch(/do NOT run git/i);
    expect(out).toMatch(/never `cd`/i);
    expect(out).not.toMatch(/conflict marker/i); // no conflict → no resolve instructions
  });
  it("adds conflict-resolution instructions when a base merge conflicted", () => {
    const out = revisePrompt(task, { mergeConflict: true });
    expect(out).toMatch(/conflict marker/i);
    expect(out).toMatch(/<<<<<<</);
  });
  it("handles a missing note gracefully", () => {
    const out = revisePrompt({ prompt: "x" });
    expect(out).toMatch(/none provided/i);
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

describe("parseNumstat", () => {
  it("parses added/removed/path lines", () => {
    expect(parseNumstat("3\t1\tlib/a.mjs\n10\t0\tlib/b.mjs")).toEqual([
      { path: "lib/a.mjs", added: 3, removed: 1 },
      { path: "lib/b.mjs", added: 10, removed: 0 },
    ]);
  });

  it("marks binary files (— counts) as null", () => {
    expect(parseNumstat("-\t-\tassets/logo.png")).toEqual([
      { path: "assets/logo.png", added: null, removed: null },
    ]);
  });

  it("collapses renames to the destination path", () => {
    expect(parseNumstat("1\t1\tsrc/{old => new}/file.ts")).toEqual([
      { path: "src/new/file.ts", added: 1, removed: 1 },
    ]);
    expect(parseNumstat("0\t0\told.ts => new.ts")).toEqual([
      { path: "new.ts", added: 0, removed: 0 },
    ]);
  });

  it("ignores blank and malformed lines", () => {
    expect(parseNumstat("\n5\tfoo\n2\t2\tok.ts\n")).toEqual([
      { path: "ok.ts", added: 2, removed: 2 },
    ]);
  });

  it("handles empty input", () => {
    expect(parseNumstat("")).toEqual([]);
    expect(parseNumstat(null)).toEqual([]);
  });
});

describe("prBody", () => {
  it("includes the title as the summary and a per-file changed list", () => {
    const body = prBody({
      title: "Add feature X",
      files: [
        { path: "lib/a.mjs", added: 3, removed: 1 },
        { path: "assets/logo.png", added: null, removed: null },
      ],
    });
    expect(body).toContain("## Summary");
    expect(body).toContain("Add feature X");
    expect(body).toContain("## Files changed (2)");
    expect(body).toContain("- `lib/a.mjs` (+3/-1)");
    expect(body).toContain("- `assets/logo.png` (binary)");
  });

  it("handles no files", () => {
    const body = prBody({ title: "Docs tweak", files: [] });
    expect(body).toContain("## Files changed (0)");
    expect(body).toContain("_No file changes detected._");
  });

  it("falls back to a default summary line without a title", () => {
    const body = prBody({ files: [{ path: "a.ts", added: 1, removed: 0 }] });
    expect(body).toContain("Automated change by the agent task board.");
  });
});

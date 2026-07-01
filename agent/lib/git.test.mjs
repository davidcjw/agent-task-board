// Integration tests for the git-only helpers in git.mjs. These shell out to a
// real `git`, so they build a throwaway repo under os.tmpdir() in beforeAll and
// point AGENT_WORKTREE_DIR at an isolated temp dir. git.mjs reads
// AGENT_WORKTREE_DIR at import time, so it's imported dynamically AFTER the env
// is set. finishPr is intentionally not exercised — it needs `git push`/`gh`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

let repoDir; // the throwaway origin repo
let worktreeBase; // AGENT_WORKTREE_DIR
let git; // dynamically-imported git.mjs
let run; // git.mjs's exported runner

let idSeq = 0;
const nextId = () => `t${++idSeq}`;

beforeAll(async () => {
  // Two isolated temp roots: one for the repo, one for the worktrees.
  repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), "atb-git-repo-"));
  worktreeBase = await fsp.mkdtemp(path.join(os.tmpdir(), "atb-git-wt-"));
  process.env.AGENT_WORKTREE_DIR = worktreeBase;

  // Import after the env is set so WORKTREE_BASE picks up our temp dir.
  git = await import("./git.mjs");
  run = git.run;

  // A minimal repo on a known base branch with one commit.
  await run("git", ["init", "-b", "base"], repoDir);
  await run("git", ["config", "user.email", "test@example.com"], repoDir);
  await run("git", ["config", "user.name", "Test"], repoDir);
  await fsp.writeFile(path.join(repoDir, "README.md"), "hello\n");
  await run("git", ["add", "README.md"], repoDir);
  await run("git", ["commit", "-m", "init"], repoDir);
});

afterAll(async () => {
  await fsp.rm(repoDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
});

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("run", () => {
  it("resolves { code, out, err } and captures stdout", async () => {
    const res = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
    expect(res.code).toBe(0);
    expect(res.out).toBe("base");
    expect(res.err).toBe("");
  });

  it("never rejects on a bad command and reports a non-zero code", async () => {
    const res = await run("git", ["not-a-real-subcommand"], repoDir);
    expect(res.code).not.toBe(0);
  });

  it("kills a hung command when the timeout fires", async () => {
    const res = await run("sleep", ["30"], repoDir, { timeout: 100 });
    // Killed via killGroup — resolves promptly with a non-zero/killed code.
    expect(res.code).not.toBe(0);
  });
});

describe("killGroup", () => {
  it("is a no-op (no throw) for a null/pid-less child", () => {
    expect(() => git.killGroup(null)).not.toThrow();
    expect(() => git.killGroup({ pid: null })).not.toThrow();
  });
});

describe("createWorktree", () => {
  it("returns { path, base }, the path exists, and it's on branch atb/<id>", async () => {
    const id = nextId();
    const branch = `atb/${id}`;
    const res = await git.createWorktree(repoDir, branch, id);
    expect(res.error).toBeUndefined();
    expect(res.base).toBe("base");
    expect(res.path).toBeTruthy();
    expect(await pathExists(res.path)).toBe(true);

    const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], res.path);
    expect(head.out).toBe(branch);

    await git.removeWorktree(repoDir, res.path);
  });

  it("returns { error } for a non-git directory", async () => {
    const notRepo = await fsp.mkdtemp(path.join(os.tmpdir(), "atb-git-notrepo-"));
    try {
      const res = await git.createWorktree(notRepo, "atb/x", "x");
      expect(res.error).toBeTruthy();
      expect(res.path).toBeUndefined();
    } finally {
      await fsp.rm(notRepo, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("worktreeDiff", () => {
  it("includes new file content but excludes a copied .env", async () => {
    const id = nextId();
    const branch = `atb/${id}`;
    const { path: wt } = await git.createWorktree(repoDir, branch, id);
    try {
      await fsp.writeFile(path.join(wt, "feature.txt"), "the new feature content\n");
      // A .env dropped into the worktree (like hydration would) must be reset out.
      await fsp.writeFile(path.join(wt, ".env"), "SECRET=leak-me\n");

      const diff = await git.worktreeDiff(wt);
      expect(diff).toContain("the new feature content");
      expect(diff).toContain("feature.txt");
      expect(diff).not.toContain("SECRET=leak-me");
      expect(diff).not.toContain(".env");
    } finally {
      await git.removeWorktree(repoDir, wt);
    }
  });

  it("truncates when the diff exceeds maxBytes", async () => {
    const id = nextId();
    const branch = `atb/${id}`;
    const { path: wt } = await git.createWorktree(repoDir, branch, id);
    try {
      await fsp.writeFile(path.join(wt, "big.txt"), "x".repeat(5000));
      const diff = await git.worktreeDiff(wt, { maxBytes: 10 });
      expect(diff.endsWith("… (diff truncated)")).toBe(true);
      // The kept prefix is the tiny maxBytes slice, not the whole diff.
      expect(diff.length).toBeLessThan(100);
    } finally {
      await git.removeWorktree(repoDir, wt);
    }
  });
});

describe("removeWorktree", () => {
  it("deletes the worktree path", async () => {
    const id = nextId();
    const branch = `atb/${id}`;
    const { path: wt } = await git.createWorktree(repoDir, branch, id);
    expect(await pathExists(wt)).toBe(true);
    await git.removeWorktree(repoDir, wt);
    expect(await pathExists(wt)).toBe(false);
  });
});

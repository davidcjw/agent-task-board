import { describe, expect, it } from "vitest";
import { missingRepoTag, repoFromTags, resolveCwd, resolveRepoPath } from "./routes.mjs";

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

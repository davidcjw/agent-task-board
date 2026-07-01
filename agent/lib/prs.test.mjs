import { describe, expect, it } from "vitest";
import { extractPrUrl, isClosed, isMerged } from "./prs.mjs";

describe("extractPrUrl", () => {
  it("pulls a PR url out of a blob of agent output", () => {
    const text = "Done. Opened the PR.\nBOARD_PR: https://github.com/davidcjw/agent-task-board/pull/42\n";
    expect(extractPrUrl(text)).toBe("https://github.com/davidcjw/agent-task-board/pull/42");
  });

  it("matches a raw gh pr create url with no marker", () => {
    expect(extractPrUrl("https://github.com/acme/repo-1/pull/7 is ready")).toBe(
      "https://github.com/acme/repo-1/pull/7",
    );
  });

  it("returns the first url when several are present", () => {
    const text = "see https://github.com/a/b/pull/1 and https://github.com/a/b/pull/2";
    expect(extractPrUrl(text)).toBe("https://github.com/a/b/pull/1");
  });

  it("ignores non-PR github urls", () => {
    expect(extractPrUrl("https://github.com/a/b/issues/3")).toBeNull();
    expect(extractPrUrl("https://github.com/a/b/commit/abc123")).toBeNull();
  });

  it("returns null for empty / missing input", () => {
    expect(extractPrUrl("")).toBeNull();
    expect(extractPrUrl(undefined)).toBeNull();
    expect(extractPrUrl(null)).toBeNull();
  });
});

describe("isMerged", () => {
  it("is true when gh reports state MERGED", () => {
    expect(isMerged({ state: "MERGED", mergedAt: "2026-06-26T00:00:00Z" })).toBe(true);
  });

  it("is true when only mergedAt is set", () => {
    expect(isMerged({ state: null, mergedAt: "2026-06-26T00:00:00Z" })).toBe(true);
  });

  it("is false for open / closed / errored PRs", () => {
    expect(isMerged({ state: "OPEN", mergedAt: null })).toBe(false);
    expect(isMerged({ state: "CLOSED", mergedAt: null })).toBe(false);
    expect(isMerged({ error: "gh not found" })).toBe(false);
    expect(isMerged(null)).toBe(false);
  });
});

describe("isClosed", () => {
  it("is true only when CLOSED without a merge", () => {
    expect(isClosed({ state: "CLOSED", mergedAt: null })).toBe(true);
  });

  it("is false for merged, open, or errored PRs", () => {
    expect(isClosed({ state: "MERGED", mergedAt: "2026-06-26T00:00:00Z" })).toBe(false);
    // a merged PR reports state MERGED, but guard against a CLOSED+mergedAt combo too
    expect(isClosed({ state: "CLOSED", mergedAt: "2026-06-26T00:00:00Z" })).toBe(false);
    expect(isClosed({ state: "OPEN", mergedAt: null })).toBe(false);
    expect(isClosed({ error: "gh not found" })).toBe(false);
    expect(isClosed(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { extractPrUrl, prNumber, splitUrls } from "./urls";

describe("extractPrUrl", () => {
  it("finds a PR url in a blob of result text", () => {
    const text = "Done and pushed.\n\nBOARD_PR: https://github.com/davidcjw/the-chronicle-v2/pull/7";
    expect(extractPrUrl(text)).toBe("https://github.com/davidcjw/the-chronicle-v2/pull/7");
  });

  it("ignores non-PR github urls and empty input", () => {
    expect(extractPrUrl("https://github.com/a/b/issues/3")).toBeNull();
    expect(extractPrUrl("")).toBeNull();
    expect(extractPrUrl(null)).toBeNull();
  });
});

describe("prNumber", () => {
  it("pulls the PR number out", () => {
    expect(prNumber("https://github.com/a/b/pull/42")).toBe("42");
    expect(prNumber(null)).toBeNull();
  });
});

describe("splitUrls", () => {
  it("splits plain text and urls", () => {
    const parts = splitUrls("see https://github.com/a/b/pull/1 now");
    expect(parts).toEqual([
      { url: false, value: "see " },
      { url: true, value: "https://github.com/a/b/pull/1" },
      { url: false, value: " now" },
    ]);
  });

  it("keeps trailing punctuation out of the link", () => {
    const parts = splitUrls("ship (https://x.dev/y).");
    expect(parts).toEqual([
      { url: false, value: "ship (" },
      { url: true, value: "https://x.dev/y" },
      { url: false, value: ")." },
    ]);
  });

  it("returns a single plain part when there is no url", () => {
    expect(splitUrls("no links here")).toEqual([{ url: false, value: "no links here" }]);
  });
});

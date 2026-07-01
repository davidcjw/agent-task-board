import { describe, expect, it } from "vitest";
import {
  matchReviseTask,
  parseReviseCommand,
  prNumberOf,
  reviseCandidates,
  reviseLabel,
  reviseListText,
  revisePatch,
} from "./revise.mjs";
import { REVISE_TAG } from "./routes.mjs";

const pr = (n) => `did the work\nBOARD_PR: https://github.com/me/app/pull/${n}`;
const cards = [
  { id: "aaa11111", title: "Fix login", tags: ["repo:app"], result: pr(9) },
  { id: "bbb22222", title: "Add tests", tags: ["repo:app"], result: pr(10) },
  { id: "ccc33333", title: "A question", tags: [], result: "just an answer, no PR" },
];

describe("parseReviseCommand", () => {
  it("splits the first token as id and the rest as the note", () => {
    expect(parseReviseCommand("aaa1 rebase onto main and fix lint")).toEqual({
      idPrefix: "aaa1",
      note: "rebase onto main and fix lint",
    });
  });
  it("handles an id with no note, and bare input", () => {
    expect(parseReviseCommand("aaa1")).toEqual({ idPrefix: "aaa1", note: "" });
    expect(parseReviseCommand("   ")).toEqual({ idPrefix: "", note: "" });
  });
});

describe("reviseCandidates / prNumberOf", () => {
  it("keeps only cards carrying an open PR", () => {
    expect(reviseCandidates(cards).map((t) => t.id)).toEqual(["aaa11111", "bbb22222"]);
    expect(reviseCandidates([])).toEqual([]);
  });
  it("extracts the PR number", () => {
    expect(prNumberOf(cards[0])).toBe("9");
    expect(prNumberOf(cards[2])).toBe(null);
  });
});

describe("matchReviseTask", () => {
  it("matches a unique id-prefix", () => {
    const { match } = matchReviseTask(reviseCandidates(cards), "aaa");
    expect(match.id).toBe("aaa11111");
  });
  it("reports ambiguity and no-match without a match", () => {
    const many = matchReviseTask([{ id: "abc1" }, { id: "abc2" }], "abc");
    expect(many.match).toBe(null);
    expect(many.candidates).toHaveLength(2);
    expect(matchReviseTask(reviseCandidates(cards), "zzz").match).toBe(null);
  });
});

describe("reviseLabel / reviseListText", () => {
  it("labels a card title · repo · #pr", () => {
    expect(reviseLabel(cards[0])).toBe("Fix login · app · #9");
  });
  it("lists candidates, or says there are none", () => {
    expect(reviseListText(cards)).toMatch(/aaa11111 — Fix login · app · #9/);
    expect(reviseListText([cards[2]])).toMatch(/No Review cards/);
  });
});

describe("revisePatch", () => {
  it("returns a queued patch with the revise tag + trimmed note", () => {
    expect(revisePatch(cards[0], "  fix it  ")).toEqual({
      status: "queued",
      tags: ["repo:app", REVISE_TAG],
      reviseNote: "fix it",
    });
  });
});

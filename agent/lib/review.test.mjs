import { describe, expect, it } from "vitest";
import {
  detectChecks,
  fixPrompt,
  formatChecks,
  parseReview,
  reviewConfig,
  reviewerRoute,
  reviewPrompt,
  reviewSummary,
  reviewVerdict,
  shouldReview,
} from "./review.mjs";

const PR_ROUTE = { pr: true, cwd: "{repo}" };
const PR_TASK = { tags: ["repo:my-app"], title: "t", prompt: "do x" };

describe("shouldReview", () => {
  it("is false when the task wouldn't open a PR (review is a pre-PR step)", () => {
    expect(shouldReview({ pr: false, review: true }, PR_TASK)).toBe(false);
    expect(shouldReview(PR_ROUTE, { tags: [] })).toBe(false);
  });

  it("respects the per-route review flag when nothing is forced", () => {
    expect(shouldReview({ ...PR_ROUTE, review: true }, PR_TASK)).toBe(true);
    expect(shouldReview(PR_ROUTE, PR_TASK)).toBe(false);
  });

  it("lets the AGENT_REVIEW override force on/off for any PR route", () => {
    expect(shouldReview(PR_ROUTE, PR_TASK, true)).toBe(true);
    expect(shouldReview({ ...PR_ROUTE, review: true }, PR_TASK, false)).toBe(false);
  });
});

describe("reviewConfig", () => {
  it("defaults a bare review:true to 1 iteration / 90% / auto checks", () => {
    expect(reviewConfig({ review: true })).toEqual({ iterations: 1, threshold: 90, checks: null });
  });

  it("reads overrides and clamps them", () => {
    expect(reviewConfig({ review: { iterations: 4, threshold: 88, checks: ["test"] } })).toEqual({
      iterations: 4,
      threshold: 88,
      checks: ["test"],
    });
    expect(reviewConfig({ review: { threshold: 250 } }).threshold).toBe(100);
    expect(reviewConfig({ review: { iterations: -3 } }).iterations).toBe(0);
  });
});

describe("reviewerRoute", () => {
  // REVIEW_MODEL defaults to "sonnet" (not set in the test env).
  it("appends --model <REVIEW_MODEL> to a claude route that doesn't pin a model", () => {
    const out = reviewerRoute({ command: "claude", args: ["-p", "{prompt}"] });
    expect(out.args).toEqual(["-p", "{prompt}", "--model", "sonnet"]);
  });

  it("leaves a route that already pins --model untouched", () => {
    const route = { command: "claude", args: ["-p", "{prompt}", "--model", "opus"] };
    expect(reviewerRoute(route)).toBe(route);
  });

  it("passes through a non-claude route unchanged", () => {
    const route = { command: "echo", args: ["{prompt}"] };
    expect(reviewerRoute(route)).toBe(route);
  });

  it("handles a null/empty route without throwing", () => {
    expect(reviewerRoute(null)).toBeNull();
    expect(reviewerRoute({ command: "claude" }).args).toEqual(["--model", "sonnet"]);
  });

  it("does not mutate the input route's args", () => {
    const args = ["-p", "{prompt}"];
    reviewerRoute({ command: "claude", args });
    expect(args).toEqual(["-p", "{prompt}"]);
  });
});

describe("detectChecks", () => {
  const pkg = { scripts: { lint: "eslint", typecheck: "tsc", test: "vitest run", build: "next build" } };

  it("auto-detects lint/typecheck/test that exist (build excluded)", () => {
    expect(detectChecks(pkg)).toEqual(["lint", "typecheck", "test"]);
  });

  it("honours a configured subset, filtered to scripts that exist", () => {
    expect(detectChecks(pkg, ["test", "build", "missing"])).toEqual(["test", "build"]);
  });

  it("returns [] when no wanted scripts exist", () => {
    expect(detectChecks({ scripts: { start: "next" } })).toEqual([]);
    expect(detectChecks(null)).toEqual([]);
  });
});

describe("parseReview", () => {
  it("parses a fenced json block", () => {
    const text = 'here you go\n```json\n{ "confidence": 96, "blocking": [], "minor": ["nit"], "summary": "ok" }\n```';
    expect(parseReview(text)).toEqual({ confidence: 96, blocking: [], minor: ["nit"], summary: "ok" });
  });

  it("parses a raw json object with no fence", () => {
    expect(parseReview('{"confidence": 80, "blocking": ["bug"]}')).toMatchObject({
      confidence: 80,
      blocking: ["bug"],
    });
  });

  it("clamps confidence and coerces non-string findings", () => {
    const r = parseReview('{"confidence": 250, "blocking": [{"x":1}], "minor": "no"}');
    expect(r.confidence).toBe(100);
    expect(r.blocking).toEqual(['{"x":1}']);
    expect(r.minor).toEqual([]);
  });

  it("fails closed on unparseable output (0% + a blocking finding)", () => {
    const r = parseReview("the code looks fine to me, ship it");
    expect(r.confidence).toBe(0);
    expect(r.blocking.length).toBeGreaterThan(0);
  });
});

describe("reviewVerdict", () => {
  const ok = { confidence: 97, blocking: [], minor: [] };
  const greenChecks = { allPass: true, results: [{ script: "test", ok: true }] };

  it("passes only when checks green AND no blocking AND confidence ≥ threshold", () => {
    expect(reviewVerdict({ checks: greenChecks, review: ok, threshold: 95 }).pass).toBe(true);
  });

  it("fails on a failing check regardless of confidence", () => {
    const v = reviewVerdict({ checks: { allPass: false, results: [] }, review: ok });
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/checks/i);
  });

  it("fails on any blocking finding", () => {
    const v = reviewVerdict({ checks: greenChecks, review: { confidence: 99, blocking: ["x"] } });
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/blocking/i);
  });

  it("fails when confidence is below the threshold", () => {
    const v = reviewVerdict({ checks: greenChecks, review: { confidence: 80, blocking: [] }, threshold: 95 });
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/confidence/i);
  });

  it("treats absent checks as a pass (no checks configured)", () => {
    expect(reviewVerdict({ checks: null, review: ok, threshold: 95 }).pass).toBe(true);
  });
});

describe("prompts", () => {
  it("reviewPrompt frames an independent reviewer and embeds the diff + checks", () => {
    const out = reviewPrompt({ title: "T", prompt: "add favicon" }, "diff --git a b", {
      results: [{ script: "test", ok: false, output: "1 failing" }],
    });
    expect(out).toMatch(/INDEPENDENT code reviewer/i);
    expect(out).toMatch(/did NOT write/i);
    expect(out).toContain("add favicon");
    expect(out).toContain("diff --git a b");
    expect(out).toMatch(/test: FAIL/);
    expect(out).toMatch(/```json/);
  });

  it("fixPrompt is edit-only and lists the blocking findings", () => {
    const out = fixPrompt({ prompt: "add favicon" }, { blocking: ["missing alt text"] }, null);
    expect(out).toMatch(/do NOT commit, push, or open a pull request/i);
    expect(out).toContain("missing alt text");
  });
});

describe("formatChecks", () => {
  it("notes when nothing is configured", () => {
    expect(formatChecks(null)).toMatch(/no checks/i);
    expect(formatChecks({ results: [] })).toMatch(/no checks/i);
  });

  it("shows PASS without output and FAIL with truncated output", () => {
    const out = formatChecks({ results: [{ script: "lint", ok: true }, { script: "test", ok: false, output: "boom" }] });
    expect(out).toMatch(/lint: PASS/);
    expect(out).toMatch(/test: FAIL/);
    expect(out).toContain("boom");
  });
});

describe("reviewSummary", () => {
  it("leads with the stat line and lists minor findings even when not flagged", () => {
    const out = reviewSummary({ confidence: 96, blocking: [], minor: ["tidy the import"] }, { attempts: 1 });
    expect(out).toMatch(/96% confidence/);
    expect(out).not.toMatch(/Flagged/);
    expect(out).toContain("• tidy the import");
  });

  it("adds a flagged warning and lists both blocking and minor findings when flagged", () => {
    const out = reviewSummary(
      { confidence: 60, blocking: ["bug a"], minor: ["nit b"] },
      { flagged: true, attempts: 3 },
    );
    expect(out).toMatch(/⚠ Flagged/);
    expect(out).toContain("⛔ bug a");
    expect(out).toContain("• nit b");
  });
});

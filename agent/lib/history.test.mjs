import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHistory, historyRecord, readHistory, summarizeHistory } from "./history.mjs";

describe("historyRecord", () => {
  it("coerces and defaults every field", () => {
    const r = historyRecord({ id: 7, title: "Fix login", agent: "Claude Code", repo: "app", status: "done" });
    expect(r).toEqual({
      id: "7",
      title: "Fix login",
      agent: "Claude Code",
      repo: "app",
      status: "done",
      durationMs: 0,
      reviewScore: null,
      prUrl: "",
      error: false,
      at: 0,
    });
  });

  it("normalizes numbers, booleans, and review score", () => {
    const r = historyRecord({
      id: "a",
      durationMs: "1500",
      reviewScore: "92",
      prUrl: "https://x/pull/1",
      error: 1,
      at: 123,
    });
    expect(r.durationMs).toBe(1500);
    expect(r.reviewScore).toBe(92);
    expect(r.prUrl).toBe("https://x/pull/1");
    expect(r.error).toBe(true);
    expect(r.at).toBe(123);
  });

  it("clamps negative duration to 0 and keeps null review score for junk", () => {
    expect(historyRecord({ durationMs: -50 }).durationMs).toBe(0);
    expect(historyRecord({ reviewScore: "n/a" }).reviewScore).toBeNull();
    expect(historyRecord({ durationMs: "oops" }).durationMs).toBe(0);
  });

  it("tolerates no argument", () => {
    expect(historyRecord()).toMatchObject({ id: "", status: "", error: false });
  });
});

describe("summarizeHistory", () => {
  const records = [
    historyRecord({ status: "done", error: false, repo: "app", agent: "Claude Code", durationMs: 1000 }),
    historyRecord({ status: "review", error: true, repo: "app", agent: "Claude Code", durationMs: 3000 }),
    historyRecord({ status: "done", error: false, repo: "web", agent: "default", durationMs: 2000 }),
  ];

  it("counts totals and groups by status/repo/agent", () => {
    const s = summarizeHistory(records);
    expect(s.total).toBe(3);
    expect(s.byStatus).toEqual({ done: 2, review: 1 });
    expect(s.byRepo).toEqual({ app: 2, web: 1 });
    expect(s.byAgent).toEqual({ "Claude Code": 2, default: 1 });
  });

  it("computes successRate and avgDurationMs", () => {
    const s = summarizeHistory(records);
    expect(s.successRate).toBeCloseTo(2 / 3);
    expect(s.avgDurationMs).toBe(2000);
  });

  it("returns a clean zero-state for empty/non-array input", () => {
    expect(summarizeHistory([])).toEqual({
      total: 0,
      byStatus: {},
      successRate: 0,
      avgDurationMs: 0,
      byRepo: {},
      byAgent: {},
    });
    expect(summarizeHistory(null).total).toBe(0);
  });

  it("buckets missing repo/agent under (none)", () => {
    const s = summarizeHistory([historyRecord({ status: "done" })]);
    expect(s.byRepo).toEqual({ "(none)": 1 });
    expect(s.byAgent).toEqual({ "(none)": 1 });
  });
});

describe("appendHistory / readHistory", () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "history-test-"));
    file = path.join(dir, "nested", "history.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips records, creating the dir", () => {
    expect(appendHistory(historyRecord({ id: "1", status: "done" }), file)).toBe(true);
    expect(appendHistory(historyRecord({ id: "2", status: "review" }), file)).toBe(true);
    const rows = readHistory(file);
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("skips malformed lines", () => {
    const flat = path.join(dir, "history.jsonl");
    writeFileSync(flat, '{"id":"1","status":"done"}\nnot json\n\n{"id":"2"}\n');
    const rows = readHistory(flat);
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("returns [] for an absent log", () => {
    expect(readHistory(path.join(dir, "missing.jsonl"))).toEqual([]);
  });
});

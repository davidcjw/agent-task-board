import { describe, expect, it } from "vitest";
import {
  acceptedKeySet,
  ACCEPTED_CAP,
  avoidTitles,
  dropIdea,
  dueForFullScan,
  emptyMemory,
  FULL_SCAN_INTERVAL_MS,
  normalizeMemory,
  recordAccepted,
  recordScan,
  reposToScan,
  setBacklog,
  topIdea,
} from "./scout-memory.mjs";

describe("normalizeMemory", () => {
  it("returns an empty ledger for junk", () => {
    expect(normalizeMemory(null)).toEqual(emptyMemory());
    expect(normalizeMemory("x")).toEqual(emptyMemory());
    expect(normalizeMemory({})).toEqual(emptyMemory());
  });
  it("preserves valid fields and drops malformed ones", () => {
    const mem = normalizeMemory({
      repos: { a: { sha: "1" } },
      ideas: [{ key: "k", title: "t" }],
      accepted: [{ key: "p" }],
      lastFullScanAt: 5,
      junk: 9,
    });
    expect(mem.repos).toEqual({ a: { sha: "1" } });
    expect(mem.ideas).toEqual([{ key: "k", title: "t" }]);
    expect(mem.accepted).toEqual([{ key: "p" }]);
    expect(mem.lastFullScanAt).toBe(5);
    expect(mem.junk).toBeUndefined();
  });
  it("defaults missing arrays to empty", () => {
    const mem = normalizeMemory({ repos: { a: { sha: "1" } } });
    expect(mem.ideas).toEqual([]);
    expect(mem.accepted).toEqual([]);
  });
});

describe("reposToScan", () => {
  it("scans a repo that's never been seen", () => {
    const { scan, skipped } = reposToScan(["a"], { a: "sha1" }, emptyMemory());
    expect(scan).toEqual(["a"]);
    expect(skipped).toEqual([]);
  });

  it("scans a repo whose fingerprint changed", () => {
    const mem = { repos: { a: { sha: "old" } } };
    expect(reposToScan(["a"], { a: "new" }, mem).scan).toEqual(["a"]);
  });

  it("skips an unchanged repo (pure SHA — no landed/accepted clause)", () => {
    const mem = { repos: { a: { sha: "sha1" } } };
    const { scan, skipped } = reposToScan(["a"], { a: "sha1" }, mem);
    expect(scan).toEqual([]);
    expect(skipped).toEqual(["a"]);
  });

  it("treats a dirty fingerprint as changed", () => {
    const mem = { repos: { a: { sha: "sha1" } } };
    expect(reposToScan(["a"], { a: "sha1+dirty" }, mem).scan).toEqual(["a"]);
  });

  it("partitions a mix of repos", () => {
    const mem = { repos: { same: { sha: "x" }, moved: { sha: "old" } } };
    const fp = { same: "x", moved: "new", fresh: "z" };
    const { scan, skipped } = reposToScan(["same", "moved", "fresh"], fp, mem);
    expect(scan.sort()).toEqual(["fresh", "moved"]);
    expect(skipped).toEqual(["same"]);
  });
});

describe("dueForFullScan", () => {
  it("is due when the interval has elapsed since the last full scan", () => {
    expect(dueForFullScan({ lastFullScanAt: 1000 }, 1000 + FULL_SCAN_INTERVAL_MS)).toBe(true);
  });
  it("is not due within the interval", () => {
    expect(dueForFullScan({ lastFullScanAt: 1000 }, 1000 + FULL_SCAN_INTERVAL_MS - 1)).toBe(false);
  });
  it("treats a missing/empty ledger (lastFullScanAt 0) as due at any real time", () => {
    expect(dueForFullScan(emptyMemory(), FULL_SCAN_INTERVAL_MS)).toBe(true);
    expect(dueForFullScan(null, FULL_SCAN_INTERVAL_MS)).toBe(true);
  });
});

describe("recordScan", () => {
  it("stamps fingerprints + scannedAt for scanned repos", () => {
    const next = recordScan(emptyMemory(), { scanned: ["a", "b"], fingerprints: { a: "x", b: "y" }, now: 100 });
    expect(next.repos.a).toEqual({ sha: "x", scannedAt: 100 });
    expect(next.repos.b).toEqual({ sha: "y", scannedAt: 100 });
  });

  it("only resets the full-scan clock on a full sweep", () => {
    const partial = recordScan(emptyMemory(), { scanned: ["a"], fingerprints: { a: "x" }, now: 50 });
    expect(partial.lastFullScanAt).toBe(0);
    const full = recordScan(emptyMemory(), { scanned: ["a"], fingerprints: { a: "x" }, now: 50, full: true });
    expect(full.lastFullScanAt).toBe(50);
  });

  it("does not mutate the input ledger", () => {
    const mem = { repos: { a: { sha: "old" } } };
    recordScan(mem, { scanned: ["a"], fingerprints: { a: "new" }, now: 1 });
    expect(mem.repos.a.sha).toBe("old");
  });
});

describe("backlog: setBacklog / topIdea", () => {
  it("replaces the backlog and reads the top idea", () => {
    const mem = setBacklog(emptyMemory(), [{ key: "a", title: "best" }, { key: "b", title: "next" }]);
    expect(mem.ideas).toHaveLength(2);
    expect(topIdea(mem).title).toBe("best");
  });
  it("topIdea is null on an empty backlog", () => {
    expect(topIdea(emptyMemory())).toBeNull();
  });
});

describe("dropIdea (propose) vs recordAccepted (✅)", () => {
  it("dropIdea removes the idea from the backlog WITHOUT suppressing it (can resurface)", () => {
    let mem = setBacklog(emptyMemory(), [
      { key: "a", title: "x" },
      { key: "b", title: "y" },
    ]);
    mem = dropIdea(mem, "a");
    expect(mem.ideas.map((i) => i.key)).toEqual(["b"]);
    expect(acceptedKeySet(mem).has("a")).toBe(false); // not accepted → not suppressed
  });

  it("recordAccepted drops it from the backlog AND records its key as accepted", () => {
    let mem = setBacklog(emptyMemory(), [{ key: "a", title: "x" }]);
    mem = recordAccepted(mem, "a", { repo: "app", title: "x", now: 5 });
    expect(mem.ideas).toEqual([]);
    expect(mem.accepted[0]).toEqual({ key: "a", repo: "app", title: "x", at: 5 });
    expect(acceptedKeySet(mem).has("a")).toBe(true);
  });

  it("de-dups the accepted list by key (re-accepting moves it to the front)", () => {
    let mem = recordAccepted(emptyMemory(), "a", { title: "first", now: 1 });
    mem = recordAccepted(mem, "b", { title: "second", now: 2 });
    mem = recordAccepted(mem, "a", { title: "first-again", now: 3 });
    expect(mem.accepted.map((p) => p.key)).toEqual(["a", "b"]);
    expect(mem.accepted[0].at).toBe(3);
  });

  it("caps the accepted list", () => {
    let mem = emptyMemory();
    for (let i = 0; i < ACCEPTED_CAP + 5; i++) mem = recordAccepted(mem, `k${i}`, { title: `t${i}`, now: i });
    expect(mem.accepted).toHaveLength(ACCEPTED_CAP);
    expect(mem.accepted[0].key).toBe(`k${ACCEPTED_CAP + 4}`);
  });
});

describe("avoidTitles", () => {
  it("collects backlog + accepted titles (deduped), with repo annotation", () => {
    const mem = {
      ideas: [{ key: "a", title: "Add CI", repo: "app" }],
      accepted: [{ key: "b", title: "Docs" }, { key: "c", title: "Add CI", repo: "app" }],
    };
    expect(avoidTitles(mem)).toEqual(["Add CI (app)", "Docs"]);
  });
});

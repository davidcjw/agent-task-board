import { describe, expect, it } from "vitest";
import {
  iceScore,
  ideaToTask,
  NEW_PROJECT_TAG,
  parseScout,
  projectSlug,
  rankIdeas,
  scoutSummary,
  SCOUT_TAG,
  selectTop,
  WORKSPACE_TAG,
} from "./scout.mjs";

describe("iceScore", () => {
  it("multiplies impact × confidence × ease", () => {
    expect(iceScore({ impact: 10, confidence: 10, ease: 10 })).toBe(1000);
    expect(iceScore({ impact: 5, confidence: 4, ease: 2 })).toBe(40);
  });

  it("clamps factors into [1,10] and defaults missing ones to 5", () => {
    expect(iceScore({ impact: 99, confidence: 0, ease: -3 })).toBe(10 * 1 * 1);
    expect(iceScore({})).toBe(125); // 5 × 5 × 5
  });

  it("is 0 for non-objects", () => {
    expect(iceScore(null)).toBe(0);
    expect(iceScore("x")).toBe(0);
  });
});

describe("rankIdeas / selectTop", () => {
  const ideas = [
    { title: "low", impact: 2, confidence: 2, ease: 2 }, // 8
    { title: "high", impact: 9, confidence: 8, ease: 7 }, // 504
    { title: "mid", impact: 5, confidence: 5, ease: 5 }, // 125
  ];

  it("sorts best-first and attaches score", () => {
    const ranked = rankIdeas(ideas);
    expect(ranked.map((r) => r.title)).toEqual(["high", "mid", "low"]);
    expect(ranked[0].score).toBe(504);
  });

  it("breaks ties deterministically by impact then title", () => {
    const tied = [
      { title: "b", impact: 4, confidence: 5, ease: 5 }, // 100
      { title: "a", impact: 4, confidence: 5, ease: 5 }, // 100, same impact → title
      { title: "c", impact: 5, confidence: 5, ease: 4 }, // 100, higher impact wins
    ];
    expect(rankIdeas(tied).map((r) => r.title)).toEqual(["c", "a", "b"]);
  });

  it("selectTop returns the winner, or null when empty", () => {
    expect(selectTop(ideas).title).toBe("high");
    expect(selectTop([])).toBeNull();
    expect(selectTop("nope")).toBeNull();
  });
});

describe("projectSlug", () => {
  it("slugifies titles into folder-safe names", () => {
    expect(projectSlug("My Cool Project!")).toBe("my-cool-project");
    expect(projectSlug("  spaces & --dashes-- ")).toBe("spaces-dashes");
  });
});

describe("parseScout", () => {
  it("parses a fenced ```json ideas block", () => {
    const text = `Here is my analysis.\n\n\`\`\`json
{ "ideas": [
  { "title": "Add CI cache", "prompt": "do it", "impact": 7, "confidence": 8, "ease": 6 }
] }
\`\`\``;
    const { ideas } = parseScout(text);
    expect(ideas).toHaveLength(1);
    expect(ideas[0].title).toBe("Add CI cache");
    expect(ideas[0].impact).toBe(7);
  });

  it("takes the LAST fenced block (earlier ones are illustrative)", () => {
    const text =
      '```json\n{"ideas":[{"title":"example","prompt":"x"}]}\n```\n' +
      '```json\n{"ideas":[{"title":"real","prompt":"y","impact":9}]}\n```';
    const { ideas } = parseScout(text);
    expect(ideas.map((i) => i.title)).toEqual(["real"]);
  });

  it("falls back to a bare JSON object with no fence", () => {
    const { ideas } = parseScout('prefix {"ideas":[{"title":"t","prompt":"p"}]} suffix');
    expect(ideas).toHaveLength(1);
  });

  it("drops ideas missing a title or prompt", () => {
    const { ideas } = parseScout('{"ideas":[{"title":"ok","prompt":"p"},{"title":"no prompt"},{"prompt":"no title"}]}');
    expect(ideas.map((i) => i.title)).toEqual(["ok"]);
  });

  it("fails closed on garbage", () => {
    expect(parseScout("no json here").ideas).toEqual([]);
    expect(parseScout("```json\nnot valid json\n```").ideas).toEqual([]);
    expect(parseScout("").ideas).toEqual([]);
  });

  it("normalizes an unknown category to 'feature' and clamps factors", () => {
    const { ideas } = parseScout('{"ideas":[{"title":"t","prompt":"p","category":"bogus","impact":999}]}');
    expect(ideas[0].category).toBe("feature");
    expect(ideas[0].impact).toBe(10);
  });
});

describe("ideaToTask", () => {
  const knownRepos = ["agent-task-board", "democratizing-claude"];

  it("tags an existing repo (separator-insensitive) for the PR route", () => {
    const idea = { title: "Speed up tests", prompt: "make tests fast", repo: "democratizing_claude" };
    const task = ideaToTask(idea, { knownRepos });
    expect(task.tags).toEqual([SCOUT_TAG, "repo:democratizing-claude"]);
    expect(task.agent).toBe("");
    expect(task.status).toBe("queued");
    expect(task.prompt).toBe("make tests fast");
  });

  it("scaffolds a new project when category is new-project (no repo tag)", () => {
    const idea = { title: "Shared CLI toolkit", prompt: "build a CLI", repo: "code-toolkit", category: "new-project" };
    const task = ideaToTask(idea, { knownRepos, repoBase: "/home/x/code" });
    expect(task.tags).toEqual([SCOUT_TAG, NEW_PROJECT_TAG]);
    expect(task.tags).not.toContain("repo:code-toolkit");
    expect(task.prompt).toContain("/home/x/code/code-toolkit");
    expect(task.prompt).toContain("git init");
    expect(task.prompt).toContain("build a CLI");
  });

  it("derives a new-project slug from the title when repo is blank", () => {
    const idea = { title: "Cross-Repo Dashboard", prompt: "make it", repo: "", category: "new-project" };
    const task = ideaToTask(idea, { knownRepos, repoBase: "~/code" });
    expect(task.prompt).toContain("~/code/cross-repo-dashboard");
  });

  it("treats an unknown repo on a non-new-project idea as a workspace task (no scaffolding)", () => {
    const idea = { title: "git-init all repos", prompt: "init each folder", repo: "workspace", category: "infra" };
    const task = ideaToTask(idea, { knownRepos, repoBase: "/home/x/code" });
    expect(task.tags).toEqual([SCOUT_TAG, WORKSPACE_TAG]);
    expect(task.prompt).toContain("/home/x/code");
    expect(task.prompt).toContain("init each folder");
    expect(task.prompt).not.toContain("brand-new project");
  });
});

describe("scoutSummary", () => {
  it("describes the winner and runners-up", () => {
    const ranked = rankIdeas([
      { title: "Win", repo: "app", category: "infra", impact: 9, confidence: 9, ease: 9, rationale: "big" },
      { title: "Second", impact: 5, confidence: 5, ease: 5 },
    ]);
    const out = scoutSummary(ranked, ranked[0]);
    expect(out).toContain("★ Win (app)");
    expect(out).toContain("score 729");
    expect(out).toContain("Runners-up:");
    expect(out).toContain("• Second — 125");
  });

  it("handles the empty case", () => {
    expect(scoutSummary([], null)).toContain("no actionable improvements");
  });
});

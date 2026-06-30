// Improvement Scout — pure helpers. The scout scans every repo under
// AGENT_REPO_BASE (~/code), asks an agent to brainstorm + score improvements,
// then pushes only the single highest-ranked idea to the board for the
// dispatcher to pick up. Everything here is pure (no fs / network / clock) so it
// is deterministic and unit-tested in scout.test.mjs; the impure scanning +
// pushing lives in agent/scout.mjs.
//
// Idea shape the model is asked to emit (one per improvement it finds):
//   { title, repo, category, impact, confidence, ease, rationale, prompt }
// where impact/confidence/ease are 1..10. We compute the ICE score in code
// (impact × confidence × ease) — ranking stays deterministic and reproducible
// rather than trusting a model-supplied number.

import { matchRepoSlug } from "./routes.mjs";

/** Every scout-authored task carries this tag so its provenance is visible. */
export const SCOUT_TAG = "scout";
/** New-project ideas (a brand-new folder under ~/code) carry this one too. */
export const NEW_PROJECT_TAG = "new-project";
/** Cross-repo / workspace-level ideas (touch no single repo) carry this one. */
export const WORKSPACE_TAG = "workspace";

/**
 * How long a Telegram proposal waits for your Yes/No before the next scout run
 * auto-dismisses it as stale. Until then scout pauses (no new scans) so an
 * unanswered idea never piles up; after it, scout moves on and scans afresh.
 */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Pure: is this stored proposal still awaiting an answer (exists + within TTL)? */
export function proposalActive(proposal, now, ttlMs = PROPOSAL_TTL_MS) {
  if (!proposal || !proposal.id || !Number.isFinite(proposal.createdAt)) return false;
  return now - proposal.createdAt < ttlMs;
}

/** The inline Yes/No keyboard for a proposal (one tap → queue or skip). */
export function proposalKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Queue it", callback_data: `scout:yes:${id}` },
        { text: "❌ Skip", callback_data: `scout:no:${id}` },
      ],
    ],
  };
}

/** Parse a button's callback_data back into `{ action, id }`, or null if foreign. */
export function parseCallback(data) {
  const m = /^scout:(yes|no):(.+)$/.exec(String(data || ""));
  return m ? { action: m[1], id: m[2] } : null;
}

/** The proposal message body: the ranked summary plus the Yes/No ask. */
export function proposalText(summary) {
  return `${summary}\n\n❓ Queue this to the board? I'll do nothing unless you tap ✅.`;
}

const CATEGORIES = ["infra", "devtools", "feature", "fix", "docs", "new-project"];

/** Clamp a value to an integer in [1,10], defaulting to `d` when not a number. */
function factor(v, d = 5) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return d;
  return Math.max(1, Math.min(10, n));
}

/**
 * ICE score for an idea: impact × confidence × ease, each 1..10 → 1..1000.
 * Higher is better (high impact, high confidence, low effort/high ease).
 */
export function iceScore(idea) {
  if (!idea || typeof idea !== "object") return 0;
  return factor(idea.impact) * factor(idea.confidence) * factor(idea.ease);
}

/**
 * Return a new array of ideas, each given a computed `score`, sorted best-first.
 * Ties break by impact (desc) then title (asc) so the order is fully deterministic.
 */
export function rankIdeas(ideas) {
  return (Array.isArray(ideas) ? ideas : [])
    .filter((i) => i && typeof i === "object")
    .map((i) => ({ ...i, score: iceScore(i) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        factor(b.impact) - factor(a.impact) ||
        String(a.title || "").localeCompare(String(b.title || "")),
    );
}

/** The single highest-ranked idea, or null when there are none. */
export function selectTop(ideas) {
  return rankIdeas(ideas)[0] || null;
}

/** Lowercase, hyphen-separated folder slug for a brand-new project. */
export function projectSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/** Coerce one raw idea object into the normalized shape, or null if unusable. */
function normalizeIdea(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title || "").trim();
  const prompt = String(raw.prompt || "").trim();
  if (!title || !prompt) return null;
  const category = CATEGORIES.includes(raw.category) ? raw.category : "feature";
  return {
    title: title.slice(0, 120),
    repo: String(raw.repo || "").trim(),
    category,
    impact: factor(raw.impact),
    confidence: factor(raw.confidence),
    ease: factor(raw.ease),
    rationale: String(raw.rationale || "").trim(),
    prompt,
  };
}

/**
 * Extract the ideas array from an agent's free-form output. The model is asked
 * to emit a single ```json fenced block; we take the LAST such block (any
 * earlier ones are illustrative), falling back to the outermost {...}. Fails
 * closed — any parse problem yields `{ ideas: [] }` rather than throwing.
 */
export function parseScout(text) {
  const s = String(text || "");
  const fences = [...s.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const candidates = [];
  if (fences.length) candidates.push(fences[fences.length - 1][1]);
  // Fallback: outermost brace span (covers a bare JSON reply with no fence).
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      const list = Array.isArray(obj) ? obj : obj && obj.ideas;
      if (Array.isArray(list)) {
        return { ideas: list.map(normalizeIdea).filter(Boolean) };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return { ideas: [] };
}

/**
 * Turn a ranked idea into a board task input. Three cases:
 *  1. `repo` resolves to a real directory (separator-insensitive, reusing
 *     matchRepoSlug) → a `repo:<name>` tag so the dispatcher's default PR route
 *     runs there and opens a PR.
 *  2. `category` is "new-project" → a brand-new folder: no repo tag (so no
 *     worktree/PR), prompt prefixed to scaffold it under `repoBase`.
 *  3. otherwise (a cross-repo / workspace-level idea) → no repo tag, prompt
 *     prefixed with the absolute workspace base so relative folder names in the
 *     prompt still resolve when the runner spawns outside ~/code.
 */
export function ideaToTask(idea, { knownRepos = [], repoBase = "~/code" } = {}) {
  const { match } = matchRepoSlug(idea.repo, knownRepos);
  if (match) {
    return {
      title: idea.title,
      prompt: idea.prompt,
      agent: "",
      tags: [SCOUT_TAG, `repo:${match}`],
      status: "queued",
    };
  }
  if (idea.category === "new-project") {
    const slug = projectSlug(idea.repo || idea.title) || "new-project";
    return {
      title: idea.title,
      prompt:
        `Create a brand-new project in a fresh folder at ${repoBase}/${slug} ` +
        `(make the directory and run \`git init\` there). Then: ${idea.prompt}`,
      agent: "",
      tags: [SCOUT_TAG, NEW_PROJECT_TAG],
      status: "queued",
    };
  }
  return {
    title: idea.title,
    prompt: `Work within the developer's project workspace at ${repoBase}. ${idea.prompt}`,
    agent: "",
    tags: [SCOUT_TAG, WORKSPACE_TAG],
    status: "queued",
  };
}

/**
 * Human/Telegram-facing summary: the winning pick plus the ranked runners-up,
 * so a glance shows what was chosen and what it beat. Pure string builder.
 */
export function scoutSummary(ranked, top) {
  if (!top) return "Scout found no actionable improvements this run.";
  const where = top.repo ? ` (${top.repo})` : "";
  const lines = [
    `🔭 Scout ranked ${ranked.length} idea${ranked.length === 1 ? "" : "s"}; queued the top pick:`,
    "",
    `★ ${top.title}${where} — score ${top.score} [${top.category}]`,
  ];
  if (top.rationale) lines.push(`  ${top.rationale}`);
  const rest = ranked.slice(1, 6);
  if (rest.length) {
    lines.push("", "Runners-up:");
    for (const r of rest) lines.push(`  • ${r.title} — ${r.score}`);
    if (ranked.length > 6) lines.push(`  …and ${ranked.length - 6} more`);
  }
  return lines.join("\n");
}

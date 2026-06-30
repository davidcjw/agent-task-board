// Parse an inbound Telegram message into a board task input. Pure + unit-tested.
//
// Format:
//   "Refactor auth and add tests"                   → default agent, no tags
//   "[Claude Code] fix the flaky test #bug"         → agent "Claude Code", tag "bug"
//   "[commit-push] add a favicon #repo:my-app"      → tag "repo:my-app"
//   "/democratizing_claude fix login"               → repoSlug "democratizing_claude"
//
// A leading `/slug` token names the repo the task runs in — friendlier than
// `#repo:democratizing-claude` to type (and the form Telegram's command menu
// produces, where hyphens are disallowed). It's surfaced as `repoSlug` (raw,
// unresolved) — the bot maps it to a real dir under AGENT_REPO_BASE, since that
// match needs the filesystem and this stays pure. Reserved commands (/id, /use,
// …) are handled by the bot before this runs, so they never reach here.
//
// A `#repo:<name>` tag carries the colon through (the plain `#tag` regex would
// have stopped at it), so it reaches the dispatcher's repoFromTags and a "{repo}"
// route runs in <AGENT_REPO_BASE>/<name>. Values may be a name, org/name, or an
// absolute path: `#repo:org/app`, `#repo:/srv/legacy`.

// A leading slash token: word chars + hyphen, ending at whitespace or string end.
// Requiring that boundary means "/etc/hosts is broken" (slash mid-path) is NOT
// treated as a slug — only a clean `/slug` prefix is.
const SLUG_RE = /^\/([a-zA-Z0-9_-]+)(?:\s+|$)/;
const AGENT_RE = /^\[([^\]]+)\]\s*/;
// tag name, plus an optional `:value` that allows / . @ - so repo paths survive.
const TAG_RE = /#([\w-]+(?::[\w./@-]+)?)/g;

export function parseMessage(text) {
  let repoSlug = "";
  let agent = "";
  let body = (text || "").trim();

  const slug = body.match(SLUG_RE);
  if (slug) {
    repoSlug = slug[1];
    body = body.slice(slug[0].length).trim();
  }

  const bracket = body.match(AGENT_RE);
  if (bracket) {
    agent = bracket[1].trim();
    body = body.slice(bracket[0].length).trim();
  }
  const tags = [...body.matchAll(TAG_RE)].map((m) => m[1]);
  const title = (body.split("\n")[0] || "task").replace(/\s+/g, " ").slice(0, 80);
  return { title, prompt: body, agent, tags, repoSlug, status: "queued" };
}

// ── outbound: the Telegram review snippet ────────────────────────────────────

// A line that opens a new section: a markdown heading (`## X`), a bold label
// (`**Verification:**`), or the appended review block (`🔍 Review:`). Used to
// find where the "Changes" section ends.
const SECTION_RE = /^\s*(#{1,6}\s+\S|\*\*[^*]+:\*\*\s*$|🔍 Review:)/;
// The "Changes" section header in any of the forms agents emit:
// `## Changes`, `### Changes:`, `**Changes:**`, or a bare `Changes:` line.
const CHANGES_RE = /^\s*(#{1,6}\s*)?\*{0,2}\s*changes\b/i;

/** Strip a "Changes" section (header through the next section / end) from prose. */
function stripChanges(prose) {
  const lines = prose.split("\n");
  const start = lines.findIndex((l) => CHANGES_RE.test(l));
  if (start < 0) return prose;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i]) && !CHANGES_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Build the Telegram review snippet from a task result: drop the noisy
 * file-by-file "Changes" section (too much to read on a phone) but always keep
 * the trailing `🔍 Review:` verdict block. Only the prose is length-capped — the
 * review block is never truncated, so the human always sees why it was flagged.
 */
export function notifyBody(result, max = 600) {
  const text = String(result || "")
    .replace(/\n*BOARD_PR:\s*\S+/g, "")
    .trim();
  const idx = text.search(/^🔍 Review:/m);
  const review = idx >= 0 ? text.slice(idx).trim() : "";
  const prose = stripChanges((idx >= 0 ? text.slice(0, idx) : text).trim());
  const cap = review ? Math.max(0, max - review.length - 2) : max;
  const head = prose.length > cap ? prose.slice(0, cap).trim() + "…" : prose;
  return [head, review].filter(Boolean).join("\n\n");
}

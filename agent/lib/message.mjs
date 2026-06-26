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

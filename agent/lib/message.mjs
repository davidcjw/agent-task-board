// Parse an inbound Telegram message into a board task input. Pure + unit-tested.
//
// Format:
//   "Refactor auth and add tests"                   → default agent, no tags
//   "[Claude Code] fix the flaky test #bug"         → agent "Claude Code", tag "bug"
//   "[commit-push] add a favicon #repo:my-app"      → tag "repo:my-app"
//
// A `#repo:<name>` tag carries the colon through (the plain `#tag` regex would
// have stopped at it), so it reaches the dispatcher's repoFromTags and a "{repo}"
// route runs in <AGENT_REPO_BASE>/<name>. Values may be a name, org/name, or an
// absolute path: `#repo:org/app`, `#repo:/srv/legacy`.

const AGENT_RE = /^\[([^\]]+)\]\s*/;
// tag name, plus an optional `:value` that allows / . @ - so repo paths survive.
const TAG_RE = /#([\w-]+(?::[\w./@-]+)?)/g;

export function parseMessage(text) {
  let agent = "";
  let body = (text || "").trim();
  const bracket = body.match(AGENT_RE);
  if (bracket) {
    agent = bracket[1].trim();
    body = body.slice(bracket[0].length).trim();
  }
  const tags = [...body.matchAll(TAG_RE)].map((m) => m[1]);
  const title = (body.split("\n")[0] || "task").replace(/\s+/g, " ").slice(0, 80);
  return { title, prompt: body, agent, tags, status: "queued" };
}

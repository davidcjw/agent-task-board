// URL helpers for rendering agent results on the board. Pure + unit-tested.
// (The agent layer has its own copy in agent/lib/prs.mjs — that's plain Node ESM
// and can't be imported by the TS/Next build, so the small regex is duplicated.)

const URL_RE = /https?:\/\/[^\s<>()]+/g;
const PR_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/i;

/** The first GitHub PR URL anywhere in a blob of text, or null. */
export function extractPrUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = String(text).match(PR_RE);
  return m ? m[0] : null;
}

/** The PR number from a PR URL (e.g. "42"), or null. */
export function prNumber(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(PR_RE);
  return m ? m[1] : null;
}

export interface TextPart {
  url: boolean;
  value: string;
}

/**
 * Split text into plain + URL parts for safe linkifying. Trailing punctuation
 * (".", ",", ")", …) is kept out of the link so "see (https://x/y)." works.
 */
export function splitUrls(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ url: false, value: text.slice(last, i) });
    let u = m[0];
    const trail = u.match(/[.,;:!?)\]]+$/);
    let tail = "";
    if (trail) {
      tail = trail[0];
      u = u.slice(0, -tail.length);
    }
    parts.push({ url: true, value: u });
    if (tail) parts.push({ url: false, value: tail });
    last = i + m[0].length;
  }
  if (last < text.length) parts.push({ url: false, value: text.slice(last) });
  return parts;
}

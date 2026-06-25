// Example board used for first-run / the "load sample" action. Timestamps are
// expressed as offsets from `now` so the demo always looks freshly active.

import { addTask, createTask, emptyState } from "./board";
import type { BoardState, TaskInput } from "./types";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

interface SeedSpec extends TaskInput {
  /** How long ago the card was created, in ms. */
  ageMs: number;
  /** For running cards: how long ago work started. */
  startedAgoMs?: number;
  /** For done cards: how long ago it finished. */
  completedAgoMs?: number;
}

const SPECS: SeedSpec[] = [
  {
    title: "Refactor auth middleware to async",
    prompt:
      "Refactor the Express auth middleware in src/middleware/auth.ts to use async/await instead of callbacks. Preserve behaviour, keep the existing error responses, and add unit tests for the happy path and the expired-token path.",
    agent: "Claude Code",
    tags: ["backend", "refactor"],
    notes: "Watch the 401 vs 403 distinction — don't collapse them.",
    status: "queued",
    ageMs: 6 * MIN,
  },
  {
    title: "Write Playwright e2e for checkout",
    prompt:
      "Add a Playwright end-to-end test covering the full checkout flow: add to cart → enter shipping → pay with the Stripe test card → assert the confirmation page. Use the existing test fixtures in tests/fixtures.",
    agent: "Cursor",
    tags: ["testing", "frontend"],
    notes: "",
    status: "queued",
    ageMs: 22 * MIN,
  },
  {
    title: "Migrate logging to structured JSON",
    prompt:
      "Replace all console.log calls in the api/ directory with the pino structured logger. Add request-id correlation. Don't touch the CLI scripts in scripts/.",
    agent: "Claude Code",
    tags: ["backend", "observability"],
    notes: "Confirm pino is already a dependency before starting.",
    status: "running",
    ageMs: 40 * MIN,
    startedAgoMs: 8 * MIN,
  },
  {
    title: "Generate OpenAPI spec from routes",
    prompt:
      "Scan the route definitions in src/routes/ and produce an OpenAPI 3.1 spec at docs/openapi.yaml. Include request/response schemas inferred from the zod validators.",
    agent: "Claude Code",
    tags: ["docs", "api"],
    notes: "",
    status: "running",
    ageMs: 3 * HOUR,
    startedAgoMs: 2 * HOUR + 12 * MIN,
  },
  {
    title: "Fix flaky avatar-upload test",
    prompt:
      "The test 'uploads and crops an avatar' fails ~1 in 5 runs in CI. Diagnose the race condition, fix it, and explain the root cause. Do not just add a retry.",
    agent: "Claude Code",
    tags: ["testing", "bug"],
    notes: "Suspect the canvas mock resolves before the FileReader.",
    status: "review",
    ageMs: 5 * HOUR,
    startedAgoMs: 4 * HOUR,
  },
  {
    title: "Add dark-mode toggle to settings",
    prompt:
      "Implement a dark-mode toggle in the settings page. Persist the choice to localStorage, respect prefers-color-scheme on first load, and avoid a flash of the wrong theme.",
    agent: "Cursor",
    tags: ["frontend", "feature"],
    notes: "Reviewed the diff — needs a no-flash inline script in <head>.",
    status: "review",
    ageMs: 26 * HOUR,
    startedAgoMs: 25 * HOUR,
  },
  {
    title: "Bump deps & fix breaking changes",
    prompt:
      "Update all dependencies to their latest minor versions, run the test suite, and fix anything that breaks. Summarise the notable changes in the PR description.",
    agent: "Claude Code",
    tags: ["maintenance"],
    notes: "Shipped in #482.",
    status: "done",
    ageMs: 2 * 24 * HOUR,
    startedAgoMs: 2 * 24 * HOUR - 30 * MIN,
    completedAgoMs: 2 * 24 * HOUR - 90 * MIN,
  },
  {
    title: "Document the deploy runbook",
    prompt:
      "Write a DEPLOY.md runbook covering: env vars required, the build command, the rollback procedure, and how to tail production logs. Keep it skimmable with a checklist at the top.",
    agent: "Claude (web)",
    tags: ["docs"],
    notes: "Merged.",
    status: "done",
    ageMs: 3 * 24 * HOUR,
    completedAgoMs: 3 * 24 * HOUR - 45 * MIN,
  },
];

/** Build the demo board relative to `now` (injectable for deterministic tests). */
export function seedState(now = Date.now()): BoardState {
  let state = emptyState();
  // Insert in reverse so the first spec ends up at the top of its column.
  for (const spec of [...SPECS].reverse()) {
    const createdAt = now - spec.ageMs;
    const task = createTask(spec, createdAt, `seed_${SPECS.indexOf(spec)}`);
    task.updatedAt = createdAt;
    if (spec.startedAgoMs !== undefined) task.startedAt = now - spec.startedAgoMs;
    if (spec.completedAgoMs !== undefined) task.completedAt = now - spec.completedAgoMs;
    state = addTask(state, task);
  }
  return state;
}

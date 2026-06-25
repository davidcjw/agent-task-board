import type { Status } from "./types";

/** Ordered list of columns, left to right. */
export const STATUSES: Status[] = ["queued", "running", "review", "done"];

export interface ColumnMeta {
  id: Status;
  label: string;
  /** One-line description of what this lane means in an agent workflow. */
  hint: string;
  /** Status accent, used for the column rail, count chip and card glow. */
  accent: string;
  /** Tailwind utility fragments derived from the accent (kept here so logic + UI share one source). */
  dotClass: string;
  railClass: string;
  textClass: string;
  /** Whether cards in this column show a live, ticking timer. */
  live: boolean;
}

export const COLUMN_META: Record<Status, ColumnMeta> = {
  queued: {
    id: "queued",
    label: "Queued",
    hint: "Drafted prompts, not yet handed off",
    accent: "#64748b",
    dotClass: "bg-slate-400",
    railClass: "bg-slate-500/70",
    textClass: "text-slate-300",
    live: false,
  },
  running: {
    id: "running",
    label: "Running",
    hint: "Handed to an agent, work in flight",
    accent: "#34d399",
    dotClass: "bg-emerald-400",
    railClass: "bg-emerald-400/80",
    textClass: "text-emerald-300",
    live: true,
  },
  review: {
    id: "review",
    label: "Review",
    hint: "Agent finished, needs your eyes",
    accent: "#fbbf24",
    dotClass: "bg-amber-400",
    railClass: "bg-amber-400/80",
    textClass: "text-amber-300",
    live: false,
  },
  done: {
    id: "done",
    label: "Done",
    hint: "Reviewed, merged, shipped",
    accent: "#38bdf8",
    dotClass: "bg-sky-400",
    railClass: "bg-sky-400/70",
    textClass: "text-sky-300",
    live: false,
  },
};

/** Common agent suggestions for the datalist (free text, not enforced). */
export const AGENT_SUGGESTIONS = [
  "Claude Code",
  "Claude (web)",
  "Cursor",
  "Codex CLI",
  "Aider",
  "GitHub Copilot",
  "Devin",
  "Windsurf",
];

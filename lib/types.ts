// Core domain types for Agent Task Board.

/** The four lanes a delegated agent task moves through. */
export type Status = "queued" | "running" | "review" | "done";

/** A single unit of work you hand off to an AI agent. Prompt-first. */
export interface Task {
  id: string;
  title: string;
  /** The reusable prompt / instructions you give the agent. The heart of the card. */
  prompt: string;
  /** Which agent this is delegated to, e.g. "Claude Code", "Cursor". Free text. */
  agent: string;
  tags: string[];
  notes: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
  /** Set the first time the task enters "running"; drives elapsed timers. */
  startedAt?: number;
  /** Set when the task enters "done"; cleared if it leaves "done". */
  completedAt?: number;
  /** Worker/agent id that claimed the task (set by the claim endpoint). */
  claimedBy?: string;
  /** The agent's output, written back when the task moves to review/done. */
  result?: string;
  /** True if the agent run failed; pairs with a result describing the error. */
  error?: boolean;
  /**
   * The runner (Claude Code) session id that produced `result`, captured from the
   * agent's JSON output. Lets a follow-up run resume that exact session — with its
   * full implementation context — instead of starting cold (used by the planned
   * revise/rebase flow, and available to the review-gate fixer).
   */
  sessionId?: string;
  /**
   * The human's correction when a task is sent back from Review for another pass
   * (paired with the `revise` tag). The dispatcher feeds this to the resumed
   * session as the fix instruction; the canonical `prompt` is left untouched.
   */
  reviseNote?: string;
  /** Set when archived (hidden from the lane); cleared on restore. */
  archivedAt?: number;
  /**
   * Set (server-side) when you request cancellation of a *running* task; the
   * dispatcher polls for this, kills the agent's process group, and moves the
   * card to Done. Cleared when a task is (re)claimed, so a requeue starts clean.
   */
  cancelRequestedAt?: number;
}

/**
 * Board state, modelled as the canonical multi-container shape:
 * a flat task map plus ordered id-lists per column. Reorders and
 * cross-column moves become simple array splices.
 */
export interface BoardState {
  tasks: Record<string, Task>;
  columns: Record<Status, string[]>;
}

/** Fields a user supplies when creating a task. */
export interface TaskInput {
  title: string;
  prompt: string;
  agent: string;
  tags: string[];
  notes: string;
  status?: Status;
}

/** A patch for updating a task: editable input fields plus the archive toggle
 *  and the revise-note stamp (set when a Review card is sent back). */
export type TaskPatch = Partial<TaskInput> & { archived?: boolean; reviseNote?: string };

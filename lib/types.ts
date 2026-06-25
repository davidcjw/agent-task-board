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

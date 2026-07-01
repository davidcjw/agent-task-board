import { parseTags, normalizeTags } from "@/lib/board";
import { STATUSES } from "@/lib/columns";
import type { Status, TaskInput, TaskPatch } from "@/lib/types";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function coerceTags(v: unknown): string[] {
  if (Array.isArray(v)) return normalizeTags(v.map((x) => String(x)));
  if (typeof v === "string") return parseTags(v);
  return [];
}

export function coerceStatus(v: unknown): Status | undefined {
  return typeof v === "string" && (STATUSES as string[]).includes(v) ? (v as Status) : undefined;
}

/** Build a full TaskInput from an untrusted request body (for create). */
export function coerceTaskInput(body: Record<string, unknown>): TaskInput {
  return {
    title: asString(body.title),
    prompt: asString(body.prompt),
    agent: asString(body.agent),
    tags: coerceTags(body.tags),
    notes: asString(body.notes),
    status: coerceStatus(body.status),
  };
}

/** Build a task patch from a body (for update) — only present fields. */
export function coerceTaskPatch(body: Record<string, unknown>): TaskPatch {
  const patch: TaskPatch = {};
  if ("title" in body) patch.title = asString(body.title);
  if ("prompt" in body) patch.prompt = asString(body.prompt);
  if ("agent" in body) patch.agent = asString(body.agent);
  if ("tags" in body) patch.tags = coerceTags(body.tags);
  if ("notes" in body) patch.notes = asString(body.notes);
  if ("reviseNote" in body) patch.reviseNote = asString(body.reviseNote);
  if ("archived" in body) patch.archived = Boolean(body.archived);
  const status = coerceStatus(body.status);
  if (status) patch.status = status;
  return patch;
}

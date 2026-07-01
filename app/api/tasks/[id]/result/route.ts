import { NextResponse } from "next/server";
import { store } from "@/lib/server/store";
import { authorized } from "@/lib/server/auth";
import { coerceStatus } from "@/lib/server/parse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/tasks/:id/result — a worker reports an agent's output. By default
// the task advances to Review (the human approval gate). Pass error:true to
// flag a failed run.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const result = typeof body.result === "string" ? body.result : "";
  const error = body.error === true;
  const toStatus = coerceStatus(body.status) ?? "review";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  const task = await store.result(id, result, { toStatus, error, sessionId });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json({ task });
}

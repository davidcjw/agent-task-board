import { NextResponse } from "next/server";
import { store } from "@/lib/server/store";
import { authorized } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/tasks/:id/cancel — request cancellation of a RUNNING task. Stamps
// cancelRequestedAt; the dispatcher polls for it, kills the agent's process
// group, and moves the card to Done. 409 if the task isn't currently running.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const task = await store.requestCancel(id);
  if (!task) return NextResponse.json({ error: "Task not found or not running" }, { status: 409 });
  return NextResponse.json({ task });
}

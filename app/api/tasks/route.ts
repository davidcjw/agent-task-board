import { NextResponse } from "next/server";
import { store } from "@/lib/server/store";
import { authorized } from "@/lib/server/auth";
import { coerceTaskInput } from "@/lib/server/parse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/tasks — create a task. This is the endpoint the MCP `add_task`
// tool (and the UI in API mode) call to enqueue work.
export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = coerceTaskInput(body);
  if (!input.title.trim() && !input.prompt.trim()) {
    return NextResponse.json({ error: "A task needs at least a title or a prompt." }, { status: 400 });
  }
  const { task, board } = await store.create(input);
  return NextResponse.json({ task, board }, { status: 201 });
}

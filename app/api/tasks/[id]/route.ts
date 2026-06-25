import { NextResponse } from "next/server";
import { store } from "@/lib/server/store";
import { coerceTaskPatch } from "@/lib/server/parse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PATCH /api/tasks/:id — update editable fields and/or move lane.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const board = await store.update(id, coerceTaskPatch(body));
  if (!board.tasks[id]) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json({ task: board.tasks[id], board });
}

// DELETE /api/tasks/:id
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const board = await store.remove(id);
  return NextResponse.json({ board });
}

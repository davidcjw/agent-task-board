import { NextResponse } from "next/server";
import { store } from "@/lib/server/store";
import { authorized } from "@/lib/server/auth";
import { emptyState } from "@/lib/board";
import type { BoardState } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/board — the full board (the live UI polls this).
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const board = await store.getBoard();
  return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/board — replace the whole board (import / load sample).
export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const candidate =
    body && typeof body === "object" && "state" in body
      ? (body as { state: BoardState }).state
      : (body as BoardState);
  if (!candidate || typeof candidate !== "object" || !("tasks" in candidate)) {
    return NextResponse.json({ error: "Body must be a board (with a tasks field)." }, { status: 400 });
  }
  const board = await store.replace(candidate);
  return NextResponse.json(board);
}

// DELETE /api/board — clear every task.
export async function DELETE(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const board = await store.replace(emptyState());
  return NextResponse.json(board);
}

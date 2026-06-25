import { NextResponse } from "next/server";
import { store } from "@/lib/server/store";
import { authorized } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/claim — atomically claim the oldest queued task (optionally
// filtered by agent/tag) and move it to Running. Returns `{ task: null }`
// when the queue is empty. Used by the dispatcher / workers.
export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine — claim anything
  }
  const filter = {
    agent: typeof body.agent === "string" ? body.agent : undefined,
    tag: typeof body.tag === "string" ? body.tag : undefined,
  };
  const worker = typeof body.worker === "string" ? body.worker : "worker";
  const task = await store.claim(filter, worker);
  return NextResponse.json({ task });
}

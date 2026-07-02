import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorized } from "./auth";
import { store } from "./store";
import { GET as boardGET, POST as boardPOST, DELETE as boardDELETE } from "@/app/api/board/route";
import { POST as tasksPOST } from "@/app/api/tasks/route";
import { PATCH as taskPATCH, DELETE as taskDELETE } from "@/app/api/tasks/[id]/route";

const TOKEN = "s3cret-token";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "atb-auth-"));
  process.env.BOARD_DATA_DIR = dir;
  process.env.BOARD_SEED = "0";
  delete process.env.AGENT_TOKEN;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.BOARD_DATA_DIR;
  delete process.env.BOARD_SEED;
  delete process.env.AGENT_TOKEN;
});

function req(method: string, body?: unknown, auth?: string): Request {
  return new Request("http://localhost/api/test", {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function createTask() {
  const { task } = await store.create({ title: "T", prompt: "p", agent: "", tags: [], notes: "" });
  return task;
}

describe("authorized()", () => {
  it("is open when AGENT_TOKEN is unset", () => {
    expect(authorized(req("GET"))).toBe(true);
  });

  it("accepts the exact bearer token", () => {
    process.env.AGENT_TOKEN = TOKEN;
    expect(authorized(req("GET", undefined, `Bearer ${TOKEN}`))).toBe(true);
  });

  it("rejects a missing header", () => {
    process.env.AGENT_TOKEN = TOKEN;
    expect(authorized(req("GET"))).toBe(false);
  });

  it("rejects a wrong same-length token", () => {
    process.env.AGENT_TOKEN = TOKEN;
    expect(authorized(req("GET", undefined, `Bearer ${"x".repeat(TOKEN.length)}`))).toBe(false);
  });

  it("rejects a token of a different length", () => {
    process.env.AGENT_TOKEN = TOKEN;
    expect(authorized(req("GET", undefined, `Bearer ${TOKEN}x`))).toBe(false);
  });
});

describe("route auth (AGENT_TOKEN set)", () => {
  beforeEach(() => {
    process.env.AGENT_TOKEN = TOKEN;
  });

  it("GET /api/board → 401 without / with wrong token, 200 with token", async () => {
    expect((await boardGET(req("GET"))).status).toBe(401);
    expect((await boardGET(req("GET", undefined, "Bearer nope"))).status).toBe(401);
    const ok = await boardGET(req("GET", undefined, `Bearer ${TOKEN}`));
    expect(ok.status).toBe(200);
  });

  it("POST /api/tasks → 401 without token, 201 with token", async () => {
    const input = { title: "A", prompt: "do a" };
    expect((await tasksPOST(req("POST", input))).status).toBe(401);
    expect((await tasksPOST(req("POST", input, "Bearer nope"))).status).toBe(401);
    const ok = await tasksPOST(req("POST", input, `Bearer ${TOKEN}`));
    expect(ok.status).toBe(201);
  });

  it("PATCH /api/tasks/:id → 401 without token, 200 with token", async () => {
    const task = await createTask();
    expect((await taskPATCH(req("PATCH", { status: "review" }), ctx(task.id))).status).toBe(401);
    expect((await taskPATCH(req("PATCH", { status: "review" }, "Bearer nope"), ctx(task.id))).status).toBe(401);
    const ok = await taskPATCH(req("PATCH", { status: "review" }, `Bearer ${TOKEN}`), ctx(task.id));
    expect(ok.status).toBe(200);
  });

  it("DELETE /api/tasks/:id → 401 without token, 200 with token", async () => {
    const task = await createTask();
    expect((await taskDELETE(req("DELETE"), ctx(task.id))).status).toBe(401);
    expect((await taskDELETE(req("DELETE", undefined, "Bearer nope"), ctx(task.id))).status).toBe(401);
    const ok = await taskDELETE(req("DELETE", undefined, `Bearer ${TOKEN}`), ctx(task.id));
    expect(ok.status).toBe(200);
  });

  it("POST and DELETE /api/board → 401 without token, 200 with token", async () => {
    const board = await store.getBoard();
    expect((await boardPOST(req("POST", board))).status).toBe(401);
    expect((await boardDELETE(req("DELETE"))).status).toBe(401);
    expect((await boardPOST(req("POST", board, `Bearer ${TOKEN}`))).status).toBe(200);
    expect((await boardDELETE(req("DELETE", undefined, `Bearer ${TOKEN}`))).status).toBe(200);
  });
});

describe("route auth (AGENT_TOKEN unset)", () => {
  it("all endpoints stay open without a header", async () => {
    expect((await boardGET(req("GET"))).status).toBe(200);
    const created = await tasksPOST(req("POST", { title: "A", prompt: "p" }));
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as { task: { id: string } };
    expect((await taskPATCH(req("PATCH", { status: "review" }), ctx(task.id))).status).toBe(200);
    expect((await taskDELETE(req("DELETE"), ctx(task.id))).status).toBe(200);
  });
});

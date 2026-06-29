// Board API client shared by the dispatcher, the MCP server, and the Telegram
// bot. Talks to the running Next app's /api routes. Uses global fetch (Node 18+).

const BASE = (process.env.BOARD_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.AGENT_TOKEN || "";

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && data.error) || `${res.status} ${res.statusText}`;
    throw new Error(`${method} ${path} failed: ${msg}`);
  }
  return data;
}

export async function getBoard() {
  return request("GET", "/api/board");
}

export async function addTask(input) {
  const data = await request("POST", "/api/tasks", input);
  return data.task;
}

export async function moveTask(id, status) {
  const data = await request("PATCH", `/api/tasks/${id}`, { status });
  return data.task;
}

/** Patch arbitrary editable fields (status, tags, …) in one request. */
export async function patchTask(id, patch) {
  const data = await request("PATCH", `/api/tasks/${id}`, patch);
  return data.task;
}

export async function claimNext({ agent, tag, worker } = {}) {
  const data = await request("POST", "/api/claim", { agent, tag, worker });
  return data.task; // may be null when the queue is empty
}

export async function reportResult(id, { result, error = false, status = "review" } = {}) {
  const data = await request("POST", `/api/tasks/${id}/result`, { result, error, status });
  return data.task;
}

/** List tasks, optionally filtered by status, newest column order preserved. */
export async function listTasks(status) {
  const board = await getBoard();
  const ids = status ? board.columns[status] || [] : Object.keys(board.tasks);
  return ids.map((id) => board.tasks[id]).filter(Boolean);
}

export const config = { BASE, hasToken: Boolean(TOKEN) };

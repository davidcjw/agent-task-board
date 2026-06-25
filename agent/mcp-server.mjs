#!/usr/bin/env node
// MCP server (stdio) exposing the board as tools. Point an MCP client (Claude
// Desktop, Claude Code, etc.) at this and you can *talk* to your agent to queue
// and inspect work — "add a task for Claude Code to refactor X" calls add_task.
//
// Config (e.g. Claude Desktop claude_desktop_config.json):
//   "agent-task-board": {
//     "command": "node",
//     "args": ["/abs/path/agent/mcp-server.mjs"],
//     "env": { "BOARD_URL": "http://localhost:3000", "AGENT_TOKEN": "" }
//   }

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as api from "./lib/api.mjs";

const STATUS = { type: "string", enum: ["queued", "running", "review", "done"] };

const tools = [
  {
    name: "add_task",
    description: "Queue a task for an AI agent. The prompt is the instructions the agent will run.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title (optional; derived from prompt if omitted)" },
        prompt: { type: "string", description: "The instructions to hand the agent" },
        agent: { type: "string", description: "Target agent label, e.g. 'Claude Code' or 'Cursor'" },
        tags: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        status: STATUS,
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks, optionally filtered by lane (queued/running/review/done).",
    inputSchema: { type: "object", properties: { status: STATUS } },
  },
  {
    name: "get_board",
    description: "Get a summary of the board: task counts per lane and total.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "claim_next",
    description: "Atomically claim the oldest queued task (optionally by agent/tag), moving it to Running.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        tag: { type: "string" },
        worker: { type: "string" },
      },
    },
  },
  {
    name: "report_result",
    description: "Report an agent's result for a task and advance it (default → Review).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        result: { type: "string" },
        error: { type: "boolean" },
        status: STATUS,
      },
      required: ["id", "result"],
    },
  },
  {
    name: "move_task",
    description: "Move a task to a different lane.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: STATUS },
      required: ["id", "status"],
    },
  },
];

const server = new Server(
  { name: "agent-task-board", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    let result;
    switch (name) {
      case "add_task": {
        const task = await api.addTask({
          title: a.title || "",
          prompt: a.prompt || "",
          agent: a.agent || "",
          tags: a.tags || [],
          notes: a.notes || "",
          status: a.status,
        });
        result = { queued: task.id, title: task.title, agent: task.agent, status: task.status };
        break;
      }
      case "list_tasks": {
        const list = await api.listTasks(a.status);
        result = list.map((t) => ({ id: t.id, title: t.title, status: t.status, agent: t.agent, tags: t.tags }));
        break;
      }
      case "get_board": {
        const b = await api.getBoard();
        result = {
          total: Object.keys(b.tasks).length,
          lanes: Object.fromEntries(Object.entries(b.columns).map(([k, v]) => [k, v.length])),
        };
        break;
      }
      case "claim_next": {
        const task = await api.claimNext({ agent: a.agent, tag: a.tag, worker: a.worker || "mcp" });
        result = task ? { claimed: task.id, title: task.title, prompt: task.prompt } : { claimed: null };
        break;
      }
      case "report_result": {
        const task = await api.reportResult(a.id, {
          result: a.result || "",
          error: Boolean(a.error),
          status: a.status || "review",
        });
        result = { id: task.id, status: task.status };
        break;
      }
      case "move_task": {
        const task = await api.moveTask(a.id, a.status);
        result = { id: task.id, status: task.status };
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("agent-task-board MCP server running on stdio");

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { store } from "./store";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "atb-store-"));
  process.env.BOARD_DATA_DIR = dir;
  process.env.BOARD_SEED = "0"; // start empty for deterministic tests
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.BOARD_DATA_DIR;
  delete process.env.BOARD_SEED;
});

describe("server store", () => {
  it("starts empty and creates tasks", async () => {
    const { task } = await store.create({
      title: "A",
      prompt: "do a",
      agent: "Claude Code",
      tags: ["x"],
      notes: "",
    });
    expect(task.title).toBe("A");
    const board = await store.getBoard();
    expect(board.columns.queued).toContain(task.id);
  });

  it("persists across reads (written to disk)", async () => {
    await store.create({ title: "B", prompt: "p", agent: "", tags: [], notes: "" });
    const raw = JSON.parse(await fs.readFile(path.join(dir, "board.json"), "utf8"));
    expect(Object.keys(raw.tasks).length).toBe(1);
  });

  it("claims FIFO and moves to running", async () => {
    const a = await store.create({ title: "old", prompt: "p", agent: "", tags: [], notes: "" });
    await new Promise((r) => setTimeout(r, 2));
    await store.create({ title: "new", prompt: "p", agent: "", tags: [], notes: "" });
    const claimed = await store.claim({}, "w1");
    expect(claimed?.id).toBe(a.task.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.claimedBy).toBe("w1");
  });

  it("never hands the same task to two concurrent claimers", async () => {
    await store.create({ title: "only", prompt: "p", agent: "", tags: [], notes: "" });
    const [c1, c2] = await Promise.all([store.claim({}, "w1"), store.claim({}, "w2")]);
    const ids = [c1?.id, c2?.id].filter(Boolean);
    expect(ids.length).toBe(1); // exactly one worker got the task
  });

  it("filters claims by agent", async () => {
    await store.create({ title: "for-cursor", prompt: "p", agent: "Cursor", tags: [], notes: "" });
    await store.create({ title: "for-cc", prompt: "p", agent: "Claude Code", tags: [], notes: "" });
    const claimed = await store.claim({ agent: "Cursor" }, "w1");
    expect(claimed?.title).toBe("for-cursor");
  });

  it("records a result and advances the task to review", async () => {
    const a = await store.create({ title: "t", prompt: "p", agent: "", tags: [], notes: "" });
    await store.claim({}, "w1");
    const updated = await store.result(a.task.id, "the output", { toStatus: "review", error: false });
    expect(updated?.result).toBe("the output");
    expect(updated?.status).toBe("review");
  });
});

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { STATUSES } from "@/lib/columns";
import { tasksForColumn } from "@/lib/board";
import { exportState, importState } from "@/lib/storage";
import type { BoardState, Status, Task } from "@/lib/types";
import { useBoard } from "@/lib/useBoard";
import { Header } from "./Header";
import { Board } from "./Board";
import { EmptyState } from "./EmptyState";
import { TaskModal } from "./TaskModal";
import { ConfirmDialog } from "./ConfirmDialog";
import { Toasts, useToasts } from "./Toasts";
import { moveDir } from "./TaskCard";

function matches(task: Task, q: string): boolean {
  if (!q) return true;
  const haystack = [task.title, task.prompt, task.agent, task.notes, task.tags.join(" ")]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function BoardApp() {
  const board = useBoard();
  const { state, mounted } = board;
  const toasts = useToasts();

  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [creating, setCreating] = useState<Status | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Task | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const modalOpen = creating !== null || editing !== null || confirmDelete !== null || confirmClear;

  // Keep timers live: tick every second while something is running. The setState
  // lives in the interval callback (not the effect body) so it stays cheap.
  const hasRunning = state.columns.running.length > 0;
  useEffect(() => {
    if (!hasRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  // Power-user shortcuts: "n" = new task, "/" = focus search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (modalOpen) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "n") {
        e.preventDefault();
        setCreating("queued");
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("board-search")?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  const q = query.trim().toLowerCase();
  const columnTasks = useMemo(() => {
    const out = {} as Record<Status, Task[]>;
    for (const s of STATUSES) out[s] = tasksForColumn(state, s).filter((t) => matches(t, q));
    return out;
  }, [state, q]);

  const counts = useMemo(() => {
    const c = { total: 0 } as Record<Status, number> & { total: number };
    for (const s of STATUSES) {
      c[s] = state.columns[s].length;
      c.total += c[s];
    }
    return c;
  }, [state]);

  const snapshotAnd = useCallback(
    (run: () => void, undoMessage: string, prev: BoardState) => {
      run();
      toasts.push(undoMessage, {
        action: { label: "Undo", onClick: () => board.restore(prev) },
      });
    },
    [board, toasts],
  );

  const handleMove = useCallback(
    (task: Task, dir: -1 | 1) => {
      const to = moveDir(task.status, dir);
      if (to) board.moveTask(task.id, to, 0);
    },
    [board],
  );

  const handleDelete = useCallback(() => {
    if (!confirmDelete) return;
    const prev = state;
    const title = confirmDelete.title;
    board.deleteTask(confirmDelete.id);
    setConfirmDelete(null);
    snapshotAnd(() => {}, `Deleted “${title}”`, prev);
  }, [confirmDelete, state, board, snapshotAnd]);

  const handleClear = useCallback(() => {
    const prev = state;
    board.clear();
    setConfirmClear(false);
    snapshotAnd(() => {}, "Board cleared", prev);
  }, [state, board, snapshotAnd]);

  const handleExport = useCallback(() => {
    const json = exportState(state);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `agent-task-board-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toasts.push("Board exported");
  }, [state, toasts]);

  const handleImport = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const next = importState(String(reader.result));
          const prev = state;
          board.restore(next);
          const n = Object.keys(next.tasks).length;
          toasts.push(`Imported ${n} task${n === 1 ? "" : "s"}`, {
            action: { label: "Undo", onClick: () => board.restore(prev) },
          });
        } catch (err) {
          toasts.push(err instanceof Error ? err.message : "Could not import file", { tone: "danger" });
        }
      };
      reader.onerror = () => toasts.push("Could not read file", { tone: "danger" });
      reader.readAsText(file);
    },
    [state, board, toasts],
  );

  if (!mounted) return <BoardSkeleton />;

  const isEmpty = counts.total === 0;

  return (
    <div className="flex min-h-full flex-col">
      <Header
        counts={counts}
        query={query}
        onQueryChange={setQuery}
        onNew={() => setCreating("queued")}
        onExport={handleExport}
        onImportFile={handleImport}
        onClear={() => setConfirmClear(true)}
      />

      <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-5">
        {isEmpty ? (
          <EmptyState onSeed={board.seed} onCreate={() => setCreating("queued")} />
        ) : (
          <Board
            columns={state.columns}
            tasksById={state.tasks}
            columnTasks={columnTasks}
            now={now}
            filtering={q.length > 0}
            onAdd={(s) => setCreating(s)}
            onCommitDrag={board.commitDrag}
            onCopied={() => toasts.push("Prompt copied")}
            onEdit={(t) => setEditing(t)}
            onDelete={(t) => setConfirmDelete(t)}
            onMove={handleMove}
          />
        )}
      </main>

      <footer className="border-t border-line px-4 py-3">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted/70">
            Local-first · stored in your browser · nothing leaves this device
          </p>
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted/50">
            n · new &nbsp; / · search
          </p>
        </div>
      </footer>

      {creating !== null && (
        <TaskModal
          mode="create"
          initialStatus={creating}
          onClose={() => setCreating(null)}
          onSubmit={(input) => {
            board.addTask(input);
            setCreating(null);
            toasts.push("Task added");
          }}
        />
      )}

      {editing !== null && (
        <TaskModal
          mode="edit"
          task={editing}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            board.updateTask(editing.id, input);
            setEditing(null);
          }}
        />
      )}

      {confirmDelete !== null && (
        <ConfirmDialog
          title="Delete task?"
          message={`“${confirmDelete.title}” will be removed from the board. You can undo this right after.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title="Clear the whole board?"
          message="Every task in every lane will be removed. You can undo this right after."
          confirmLabel="Clear board"
          onConfirm={handleClear}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-40 border-b border-line bg-canvas/85 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1500px] items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-[4px] border border-line-strong">
            <span className="h-2 w-2 rounded-full bg-accent" />
          </span>
          <span className="font-mono text-[13px] uppercase tracking-[0.16em] text-ink">
            Agent <span className="text-accent">{"//"}</span> Taskboard
          </span>
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-[1500px] flex-1 grid-cols-1 gap-4 px-4 py-5 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 w-24 rounded bg-fill" />
            <div className="h-24 rounded-[4px] border border-line bg-fill/40" />
            <div className="h-24 rounded-[4px] border border-line bg-fill/30" />
          </div>
        ))}
      </div>
    </div>
  );
}

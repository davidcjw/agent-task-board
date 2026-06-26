"use client";

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Status, Task } from "@/lib/types";
import { COLUMN_META } from "@/lib/columns";
import { cn } from "@/lib/cn";
import { STATUS_UI } from "./status";
import { SortableTaskCard, TaskCardBody, type TaskCardCallbacks } from "./TaskCard";
import { Text } from "./ds";
import { ChevronRightIcon, PlusIcon } from "./icons";

interface ColumnProps extends TaskCardCallbacks {
  status: Status;
  tasks: Task[];
  /** Archived tasks for this lane (hidden behind a reveal). */
  archived?: Task[];
  now: number;
  onAdd: (status: Status) => void;
  filtering: boolean;
}

export function Column({ status, tasks, archived = [], now, onAdd, filtering, ...callbacks }: ColumnProps) {
  const meta = COLUMN_META[status];
  const ui = STATUS_UI[status];
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const count = tasks.length;
  // Done cards render compact; other lanes keep the full card.
  const compact = status === "done";
  const [showArchived, setShowArchived] = useState(false);

  return (
    <section
      className="flex min-h-0 w-[300px] shrink-0 flex-col md:w-auto md:min-w-0"
      aria-label={`${meta.label} lane`}
    >
      {/* lane header */}
      <header className="mb-2 px-0.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", status === "running" && "live-dot")}
              style={{ backgroundColor: ui.hex, color: ui.hex }}
            />
            <Text face="mono" size="micro" caps tone="ink" className="tracking-[0.14em]">
              {meta.label}
            </Text>
            <span className="tnum font-mono text-[11px] text-muted">
              {count.toString().padStart(2, "0")}
            </span>
          </div>
          <button
            type="button"
            aria-label={`Add task to ${meta.label}`}
            title={`Add to ${meta.label}`}
            onClick={() => onAdd(status)}
            className="grid h-6 w-6 place-items-center rounded-[3px] text-muted transition-colors hover:bg-fill hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <PlusIcon size={15} />
          </button>
        </div>
        <p className="mt-1 truncate font-mono text-[10px] text-muted/70">{meta.hint}</p>
        <span
          aria-hidden
          className="mt-2 block h-px w-full"
          style={{ background: `linear-gradient(90deg, ${ui.hex}55, transparent)` }}
        />
      </header>

      {/* droppable body */}
      <div
        ref={setNodeRef}
        data-testid={`column-${status}`}
        className={cn(
          "flex min-h-[120px] flex-1 flex-col gap-2 rounded-[4px] p-1 transition-colors",
          isOver ? "bg-fill ring-1 ring-inset" : "ring-0",
        )}
        style={isOver ? { boxShadow: `inset 0 0 0 1px ${ui.hex}66` } : undefined}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task, i) => (
            <SortableTaskCard key={task.id} task={task} now={now} index={i} compact={compact} {...callbacks} />
          ))}
        </SortableContext>

        {count === 0 && archived.length === 0 && (
          <div className="grid flex-1 place-items-center rounded-[3px] border border-dashed border-line/70 py-8">
            <Text face="mono" size="micro" tone="muted" caps>
              {filtering ? "no matches" : "drop here"}
            </Text>
          </div>
        )}

        {archived.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
              className="mt-1 flex items-center gap-1 self-start font-mono text-[10px] uppercase tracking-wider text-muted/70 transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <ChevronRightIcon
                size={12}
                className={cn("transition-transform", showArchived && "rotate-90")}
              />
              {showArchived ? "hide" : "show"} archived ({archived.length})
            </button>
            {showArchived &&
              archived.map((task) => (
                <TaskCardBody key={task.id} task={task} now={now} compact archived {...callbacks} />
              ))}
          </>
        )}
      </div>
    </section>
  );
}

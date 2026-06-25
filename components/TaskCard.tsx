"use client";

import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Status, Task } from "@/lib/types";
import { STATUSES } from "@/lib/columns";
import { formatClock, formatDuration, formatRelative } from "@/lib/time";
import { cn } from "@/lib/cn";
import { STATUS_UI } from "./status";
import { Text } from "./ds";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  GripIcon,
  PencilIcon,
  TrashIcon,
} from "./icons";

export interface TaskCardCallbacks {
  onCopied: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onMove: (task: Task, dir: -1 | 1) => void;
}

interface CardBodyProps extends TaskCardCallbacks {
  task: Task;
  now: number;
  overlay?: boolean;
  dragging?: boolean;
  handleProps?: Record<string, unknown>;
  setHandleRef?: (el: HTMLElement | null) => void;
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-[3px] text-muted transition-colors",
        "hover:bg-fill hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent",
        "disabled:pointer-events-none disabled:opacity-25",
        active && "text-running",
      )}
    >
      {children}
    </button>
  );
}

function Footer({ task, now }: { task: Task; now: number }) {
  if (task.status === "running") {
    const elapsed = now - (task.startedAt ?? task.createdAt);
    return (
      <span className="inline-flex items-center gap-1.5 text-running">
        <ClockIcon size={12} />
        <span className="tnum font-mono text-[11px] tracking-tight">{formatClock(elapsed)}</span>
        <span className="text-[10px] uppercase tracking-wider text-running/70">elapsed</span>
      </span>
    );
  }
  if (task.status === "done") {
    const base = task.startedAt ?? task.createdAt;
    const end = task.completedAt ?? now;
    return (
      <span className="inline-flex items-center gap-1.5 text-done">
        <CheckIcon size={12} />
        <span className="font-mono text-[11px]">done in {formatDuration(end - base)}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <ClockIcon size={12} />
      <span className="font-mono text-[11px]">{formatRelative(task.createdAt, now)}</span>
    </span>
  );
}

export function TaskCardBody({
  task,
  now,
  overlay,
  dragging,
  handleProps,
  setHandleRef,
  onCopied,
  onEdit,
  onDelete,
  onMove,
}: CardBodyProps) {
  const [copied, setCopied] = useState(false);
  const ui = STATUS_UI[task.status];
  const idx = STATUSES.indexOf(task.status);

  async function copyPrompt() {
    const text = task.prompt.trim();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopied(true);
      onCopied(task);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-[4px] border bg-surface/80 backdrop-blur-sm",
        "transition-colors duration-150",
        dragging ? "border-dashed border-line" : "border-line hover:border-line-strong",
        overlay && "border-line-strong shadow-[0_18px_40px_-12px_rgba(0,0,0,0.8)]",
      )}
      style={overlay ? { boxShadow: `0 18px 40px -12px rgba(0,0,0,0.85)` } : undefined}
      data-testid="task-card"
      data-status={task.status}
    >
      {/* status rail */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-[2px]"
        style={{ backgroundColor: ui.hex }}
      />

      <div className={cn("p-3 pl-3.5", dragging && "opacity-40")}>
        {/* header */}
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <span
              className={cn("h-2 w-2 shrink-0 rounded-full", task.status === "running" && "live-dot")}
              style={{ backgroundColor: ui.hex, color: ui.hex }}
            />
            <Text
              face="mono"
              size="micro"
              tone="muted"
              caps
              className="truncate"
              title={task.agent || "unassigned"}
            >
              {task.agent || "unassigned"}
            </Text>
          </span>
          <button
            type="button"
            ref={setHandleRef as ((el: HTMLButtonElement | null) => void) | undefined}
            aria-label="Drag to reorder"
            className={cn(
              "shrink-0 cursor-grab touch-none rounded-[3px] p-0.5 text-muted/50 transition-opacity",
              "hover:text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:cursor-grabbing",
              overlay ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            {...(handleProps ?? {})}
          >
            <GripIcon size={14} />
          </button>
        </div>

        {/* title */}
        <h3 className="mt-2 line-clamp-2 text-[13.5px] font-normal leading-snug text-ink">
          {task.title}
        </h3>

        {/* prompt preview — the prompt-first signature */}
        {task.prompt.trim() ? (
          <div className="mt-2 rounded-[3px] border border-line bg-fill/60 px-2 py-1.5">
            <p className="line-clamp-3 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted">
              {task.prompt.trim()}
            </p>
          </div>
        ) : (
          <p className="mt-2 font-mono text-[11px] italic text-muted/50">no prompt yet</p>
        )}

        {/* tags */}
        {task.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-[3px] border border-line px-1.5 py-0.5 font-mono text-[10px] lowercase text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* footer */}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2">
          <Footer task={task} now={now} />
          <div className="flex items-center gap-0.5">
            <IconButton
              label="Move to previous lane"
              onClick={() => onMove(task, -1)}
              disabled={idx === 0}
            >
              <ChevronLeftIcon size={15} />
            </IconButton>
            <IconButton
              label="Move to next lane"
              onClick={() => onMove(task, 1)}
              disabled={idx === STATUSES.length - 1}
            >
              <ChevronRightIcon size={15} />
            </IconButton>
            <IconButton label="Copy prompt" onClick={copyPrompt} active={copied}>
              {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
            </IconButton>
            <IconButton label="Edit task" onClick={() => onEdit(task)}>
              <PencilIcon size={15} />
            </IconButton>
            <IconButton label="Delete task" onClick={() => onDelete(task)}>
              <TrashIcon size={15} />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SortableProps extends TaskCardCallbacks {
  task: Task;
  now: number;
  index: number;
}

/** dnd-kit sortable wrapper. The grip is the only drag activator so the card's
 *  buttons and text stay clickable/selectable. */
export function SortableTaskCard({ task, now, index, ...callbacks }: SortableProps) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } =
    useSortable({ id: task.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        animationDelay: `${Math.min(index, 8) * 28}ms`,
      }}
      className="rise"
    >
      <TaskCardBody
        task={task}
        now={now}
        dragging={isDragging}
        handleProps={{ ...listeners, ...attributes }}
        setHandleRef={setActivatorNodeRef}
        {...callbacks}
      />
    </div>
  );
}

export function moveDir(status: Status, dir: -1 | 1): Status | null {
  const i = STATUSES.indexOf(status) + dir;
  if (i < 0 || i >= STATUSES.length) return null;
  return STATUSES[i];
}

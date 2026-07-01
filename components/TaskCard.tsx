"use client";

import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Status, Task } from "@/lib/types";
import { STATUSES } from "@/lib/columns";
import { formatClock, formatDuration, formatRelative } from "@/lib/time";
import { cn } from "@/lib/cn";
import { extractPrUrl, prNumber, splitUrls } from "@/lib/urls";
import { STATUS_UI } from "./status";
import { Text } from "./ds";
import {
  ArchiveIcon,
  CheckIcon,
  RewindIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  GripIcon,
  PencilIcon,
  RestoreIcon,
  TrashIcon,
} from "./icons";

/** Render result text with any URLs turned into clickable links. */
function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitUrls(text).map((part, i) =>
        part.url ? (
          <a
            key={i}
            href={part.value}
            target="_blank"
            rel="noreferrer"
            className="break-all text-running underline decoration-running/40 underline-offset-2 hover:decoration-running"
          >
            {part.value}
          </a>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </>
  );
}

export interface TaskCardCallbacks {
  onCopied: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onMove: (task: Task, dir: -1 | 1) => void;
  onArchive: (task: Task) => void;
  onUnarchive: (task: Task) => void;
  /** Send a Review card back to Queued with a correction note. */
  onRevise: (task: Task) => void;
}

interface CardBodyProps extends TaskCardCallbacks {
  task: Task;
  now: number;
  overlay?: boolean;
  dragging?: boolean;
  /** Render the collapsed one-line form by default (used by the Done lane). */
  compact?: boolean;
  /** This card is archived — show "restore" instead of "archive". */
  archived?: boolean;
  handleProps?: Record<string, unknown>;
  setHandleRef?: (el: HTMLElement | null) => void;
}

function doneDuration(task: Task, now: number): string {
  return formatDuration((task.completedAt ?? now) - (task.startedAt ?? task.createdAt));
}

/** Collapsed one-line card: title + duration + PR link + archive/restore. */
function CompactRow({
  task,
  now,
  archived,
  onExpand,
  onArchive,
  onUnarchive,
}: {
  task: Task;
  now: number;
  archived?: boolean;
  onExpand: () => void;
  onArchive: (task: Task) => void;
  onUnarchive: (task: Task) => void;
}) {
  const ui = STATUS_UI[task.status];
  const prUrl = extractPrUrl(task.result);
  const prNum = prNumber(prUrl);
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 overflow-hidden rounded-[4px] border border-line bg-surface/80 py-1.5 pl-3 pr-1.5 transition-colors hover:border-line-strong",
        archived && "opacity-60",
      )}
      data-testid="task-card"
      data-status={task.status}
    >
      <span aria-hidden className="absolute left-0 top-0 h-full w-[2px]" style={{ backgroundColor: ui.hex }} />
      <button
        type="button"
        onClick={onExpand}
        title="Expand"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <CheckIcon size={12} className="shrink-0" style={{ color: ui.hex }} />
        <span className="truncate text-[12.5px] leading-tight text-ink">{task.title}</span>
      </button>
      <span className="tnum shrink-0 font-mono text-[10px] text-muted">{doneDuration(task, now)}</span>
      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer"
          title={prUrl}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-running hover:underline"
        >
          <ExternalLinkIcon size={11} />
          {prNum ? `#${prNum}` : ""}
        </a>
      )}
      <IconButton
        label={archived ? "Restore" : "Archive"}
        onClick={() => (archived ? onUnarchive(task) : onArchive(task))}
      >
        {archived ? <RestoreIcon size={14} /> : <ArchiveIcon size={14} />}
      </IconButton>
    </div>
  );
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
  compact,
  archived,
  handleProps,
  setHandleRef,
  onCopied,
  onEdit,
  onDelete,
  onMove,
  onArchive,
  onUnarchive,
  onRevise,
}: CardBodyProps) {
  const [copied, setCopied] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const ui = STATUS_UI[task.status];
  const idx = STATUSES.indexOf(task.status);

  // Done cards render as a one-line summary until expanded (keeps the lane tidy).
  if (compact && !open && !overlay) {
    return (
      <CompactRow
        task={task}
        now={now}
        archived={archived}
        onExpand={() => setOpen(true)}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
      />
    );
  }
  // Heuristic for "would the 4-line clamp hide something" — avoids measuring in
  // an effect (the React Compiler lint forbids setState inside effect bodies).
  const resultIsLong =
    !!task.result && (task.result.length > 200 || task.result.split("\n").length > 4);
  // A PR link gets its own one-click field so you don't have to expand the result.
  const prUrl = extractPrUrl(task.result);
  const prNum = prNumber(prUrl);

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

        {/* PR link — a dedicated one-click field (derived from the result) so you
            don't have to expand the result and hunt for the url */}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            title={prUrl}
            className={cn(
              "mt-2 flex items-center gap-1.5 rounded-[3px] border border-running/40 bg-running/[0.08] px-2 py-1.5",
              "font-mono text-[11px] text-running transition-colors hover:bg-running/[0.14]",
              "focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent",
            )}
          >
            <ExternalLinkIcon size={12} className="shrink-0" />
            <span className="truncate">{prNum ? `Pull request #${prNum}` : "View pull request"}</span>
          </a>
        )}

        {/* agent result — written back by the worker/dispatcher */}
        {task.result ? (
          <div
            className={cn(
              "mt-2 rounded-[3px] border px-2 py-1.5",
              task.error ? "border-accent/40 bg-accent/[0.06]" : "border-running/30 bg-running/[0.06]",
            )}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <span
                className={cn(
                  "font-mono text-[9px] uppercase tracking-wider",
                  task.error ? "text-accent" : "text-running",
                )}
              >
                {task.error ? "error" : "result"}
              </span>
              {task.claimedBy && (
                <span className="font-mono text-[9px] text-muted">· {task.claimedBy}</span>
              )}
            </div>
            <p
              className={cn(
                "whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted",
                resultOpen ? "max-h-60 overflow-y-auto" : "line-clamp-4",
              )}
            >
              <LinkedText text={task.result} />
            </p>
            {resultIsLong && (
              <button
                type="button"
                onClick={() => setResultOpen((v) => !v)}
                aria-expanded={resultOpen}
                className={cn(
                  "mt-1 font-mono text-[9px] uppercase tracking-wider transition-colors",
                  "text-muted/70 hover:text-running",
                  "focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent",
                )}
              >
                {resultOpen ? "show less" : "show more"}
              </button>
            )}
          </div>
        ) : null}

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
            {task.status === "review" && (
              <IconButton label="Send back for revision" onClick={() => onRevise(task)}>
                <RewindIcon size={15} />
              </IconButton>
            )}
            {compact && (
              <IconButton
                label={archived ? "Restore" : "Archive"}
                onClick={() => (archived ? onUnarchive(task) : onArchive(task))}
              >
                {archived ? <RestoreIcon size={15} /> : <ArchiveIcon size={15} />}
              </IconButton>
            )}
            <IconButton label="Delete task" onClick={() => onDelete(task)}>
              <TrashIcon size={15} />
            </IconButton>
            {compact && (
              <IconButton label="Collapse" onClick={() => setOpen(false)}>
                <ChevronUpIcon size={15} />
              </IconButton>
            )}
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
  compact?: boolean;
  archived?: boolean;
}

/** dnd-kit sortable wrapper. The grip is the only drag activator so the card's
 *  buttons and text stay clickable/selectable. */
export function SortableTaskCard({ task, now, index, compact, archived, ...callbacks }: SortableProps) {
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
        compact={compact}
        archived={archived}
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

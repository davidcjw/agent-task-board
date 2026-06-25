"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AGENT_SUGGESTIONS, COLUMN_META, STATUSES } from "@/lib/columns";
import { parseTags } from "@/lib/board";
import type { Status, Task, TaskInput } from "@/lib/types";
import { cn } from "@/lib/cn";
import { STATUS_UI } from "./status";
import { Button, Text } from "./ds";
import { XIcon } from "./icons";

interface TaskModalProps {
  mode: "create" | "edit";
  task?: Task;
  initialStatus?: Status;
  onClose: () => void;
  onSubmit: (input: TaskInput) => void;
}

const fieldClass =
  "w-full rounded-[4px] border border-line bg-fill/60 px-3 py-2 text-[13.5px] text-ink placeholder:text-muted/50 outline-none transition-colors focus:border-accent/70";

export function TaskModal({ mode, task, initialStatus, onClose, onSubmit }: TaskModalProps) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [agent, setAgent] = useState(task?.agent ?? "");
  const [tagText, setTagText] = useState(task?.tags.join(", ") ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [status, setStatus] = useState<Status>(task?.status ?? initialStatus ?? "queued");

  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const parsedTags = parseTags(tagText);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function submit() {
    if (!title.trim() && !prompt.trim()) {
      titleRef.current?.focus();
      return;
    }
    onSubmit({ title, prompt, agent, tags: parsedTags, notes, status });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "create" ? "New task" : "Edit task"}
        onKeyDown={handleKeyDown}
        className="rise my-auto w-full max-w-lg rounded-[6px] border border-line-strong bg-surface shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_UI[status].hex }} />
            <Text face="mono" size="micro" caps tone="ink" className="tracking-[0.14em]">
              {mode === "create" ? "New task" : "Edit task"}
            </Text>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-[3px] text-muted hover:bg-fill hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <XIcon size={16} />
          </button>
        </div>

        {/* body */}
        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <Text face="mono" size="micro" caps tone="muted" className="mb-1.5 block tracking-wider">
              Title
            </Text>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Refactor auth middleware"
              className={fieldClass}
            />
          </label>

          <label className="block">
            <Text face="mono" size="micro" caps tone="muted" className="mb-1.5 block tracking-wider">
              Prompt
            </Text>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder="The instructions you'll hand to the agent…"
              className={cn(fieldClass, "resize-y font-mono text-[12.5px] leading-relaxed")}
            />
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <Text face="mono" size="micro" caps tone="muted" className="mb-1.5 block tracking-wider">
                Agent
              </Text>
              <input
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                list={listId}
                placeholder="Claude Code"
                className={fieldClass}
              />
              <datalist id={listId}>
                {AGENT_SUGGESTIONS.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>

            <label className="block">
              <Text face="mono" size="micro" caps tone="muted" className="mb-1.5 block tracking-wider">
                Tags
              </Text>
              <input
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                placeholder="backend, refactor"
                className={fieldClass}
              />
            </label>
          </div>

          {parsedTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {parsedTags.map((t) => (
                <span
                  key={t}
                  className="rounded-[3px] border border-line px-1.5 py-0.5 font-mono text-[10px] lowercase text-muted"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          <label className="block">
            <Text face="mono" size="micro" caps tone="muted" className="mb-1.5 block tracking-wider">
              Notes
            </Text>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Context for yourself — gotchas, links, review notes…"
              className={cn(fieldClass, "resize-y")}
            />
          </label>

          <div>
            <Text face="mono" size="micro" caps tone="muted" className="mb-1.5 block tracking-wider">
              Lane
            </Text>
            <div className="grid grid-cols-4 gap-1.5">
              {STATUSES.map((s) => {
                const ui = STATUS_UI[s];
                const active = status === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    aria-pressed={active}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-[3px] border px-2 py-1.5 transition-colors",
                      active ? "border-transparent bg-fill" : "border-line hover:bg-fill/50",
                    )}
                    style={active ? { boxShadow: `inset 0 0 0 1px ${ui.hex}` } : undefined}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ui.hex }} />
                    <span
                      className={cn(
                        "font-mono text-[10px] uppercase tracking-wider",
                        active ? "text-ink" : "text-muted",
                      )}
                    >
                      {COLUMN_META[s].label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          <Text face="mono" size="micro" tone="muted" className="hidden tracking-wide sm:block">
            ⌘↵ to save · esc to close
          </Text>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="accent" onClick={submit}>
              {mode === "create" ? "Add task" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

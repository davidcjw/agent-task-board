"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Text } from "./ds";
import { RewindIcon } from "./icons";

interface ReviseDialogProps {
  title: string;
  /** Called with the correction note when the user confirms. */
  onConfirm: (note: string) => void;
  onCancel: () => void;
}

/** Collects a correction note, then sends a Review card back to Queued for
 *  another pass. Cmd/Ctrl+Enter submits; Escape cancels. */
export function ReviseDialog({ title, onConfirm, onCancel }: ReviseDialogProps) {
  const [note, setNote] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = note.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="rise w-full max-w-md rounded-[6px] border border-line-strong bg-surface p-5 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-accent">
            <RewindIcon size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <Text as="h2" face="sans" size="body" tone="ink" className="font-medium">
              {title}
            </Text>
            <Text as="p" size="body" tone="muted" className="mt-1 text-[13px] leading-relaxed">
              Return this card to Queued for another pass. The agent resumes its original session
              with your note as the fix instruction.
            </Text>
            <textarea
              ref={inputRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              }}
              rows={4}
              placeholder="What should change? e.g. “CI fails on the lint step — fix the unused import in auth.ts”"
              className="mt-3 w-full resize-y rounded-[4px] border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-muted/60 focus-visible:border-line-strong focus-visible:outline-none"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={submit}
            disabled={!note.trim()}
            className="inline-flex items-center justify-center rounded-[4px] border border-accent bg-accent px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-black transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send back
          </button>
        </div>
      </div>
    </div>
  );
}

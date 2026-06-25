"use client";

import { useEffect, useRef } from "react";
import { Button, Text } from "./ds";
import { AlertIcon } from "./icons";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

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
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="rise w-full max-w-sm rounded-[6px] border border-line-strong bg-surface p-5 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-accent">
            <AlertIcon size={20} />
          </span>
          <div className="min-w-0">
            <Text as="h2" face="sans" size="body" tone="ink" className="font-medium">
              {title}
            </Text>
            <Text as="p" size="body" tone="muted" className="mt-1 text-[13px] leading-relaxed">
              {message}
            </Text>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center justify-center rounded-[4px] border border-accent bg-accent px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-black transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

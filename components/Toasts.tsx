"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { AlertIcon, CheckIcon, XIcon } from "./icons";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  message: string;
  tone: "default" | "danger";
  action?: ToastAction;
}

export interface ToastApi {
  items: Toast[];
  push: (message: string, opts?: { tone?: "default" | "danger"; action?: ToastAction }) => void;
  dismiss: (id: number) => void;
}

const TIMEOUT = 5000;

export function useToasts(): ToastApi {
  const [items, setItems] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastApi["push"]>(
    (message, opts) => {
      const id = (counter.current += 1);
      const toast: Toast = { id, message, tone: opts?.tone ?? "default", action: opts?.action };
      setItems((prev) => [...prev.slice(-2), toast]);
      window.setTimeout(() => dismiss(id), TIMEOUT);
    },
    [dismiss],
  );

  return { items, push, dismiss };
}

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4"
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            "rise pointer-events-auto flex items-center gap-3 rounded-[5px] border bg-surface px-3.5 py-2.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85)]",
            t.tone === "danger" ? "border-accent/60" : "border-line-strong",
          )}
        >
          <span className={cn(t.tone === "danger" ? "text-accent" : "text-running")}>
            {t.tone === "danger" ? <AlertIcon size={15} /> : <CheckIcon size={15} />}
          </span>
          <span className="font-mono text-[12px] text-ink">{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.onClick();
                onDismiss(t.id);
              }}
              className="ml-1 rounded-[3px] border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-accent transition-colors hover:bg-fill"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => onDismiss(t.id)}
            className="grid h-5 w-5 place-items-center rounded-[3px] text-muted hover:bg-fill hover:text-ink"
          >
            <XIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

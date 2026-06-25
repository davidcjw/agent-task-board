"use client";

import { useRef } from "react";
import type { Status } from "@/lib/types";
import { cn } from "@/lib/cn";
import { STATUS_UI } from "./status";
import { DownloadIcon, PlusIcon, SearchIcon, TrashIcon, UploadIcon, XIcon } from "./icons";

export interface HeaderProps {
  counts: Record<Status, number> & { total: number };
  query: string;
  onQueryChange: (q: string) => void;
  onNew: () => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onClear: () => void;
}

function Stat({ label, value, hex, live }: { label: string; value: number; hex?: string; live?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {hex && (
        <span
          className={cn("h-1.5 w-1.5 rounded-full", live && "live-dot")}
          style={{ backgroundColor: hex, color: hex }}
        />
      )}
      <span className="tnum font-mono text-[12px] text-ink">{value.toString().padStart(2, "0")}</span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{label}</span>
    </span>
  );
}

export function Header({
  counts,
  query,
  onQueryChange,
  onNew,
  onExport,
  onImportFile,
  onClear,
}: HeaderProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        {/* brand + stats */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-[4px] border border-line-strong">
              <span className="h-2 w-2 rounded-full bg-accent live-dot" style={{ color: "#fa4c14" }} />
            </span>
            <h1 className="flex items-baseline gap-1 font-mono text-[13px] uppercase tracking-[0.16em]">
              <span className="text-ink">Agent</span>
              <span className="text-accent">{"//"}</span>
              <span className="text-ink">Taskboard</span>
            </h1>
          </div>
          <span className="hidden h-5 w-px bg-line sm:block" />
          <div className="hidden items-center gap-4 sm:flex">
            <Stat label="total" value={counts.total} />
            <Stat label="run" value={counts.running} hex={STATUS_UI.running.hex} live={counts.running > 0} />
            <Stat label="review" value={counts.review} hex={STATUS_UI.review.hex} />
          </div>
        </div>

        {/* controls */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 lg:w-72 lg:flex-none">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
              <SearchIcon size={15} />
            </span>
            <input
              id="board-search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search tasks, prompts, tags…"
              aria-label="Search tasks"
              className="w-full rounded-[4px] border border-line bg-fill/50 py-2 pl-8 pr-8 text-[13px] text-ink placeholder:text-muted/50 outline-none transition-colors focus:border-accent/70"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => onQueryChange("")}
                className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-[3px] text-muted hover:bg-fill hover:text-ink"
              >
                <XIcon size={13} />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onNew}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border border-accent bg-accent px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-black transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <PlusIcon size={14} /> <span className="hidden sm:inline">New</span>
          </button>

          <div className="flex shrink-0 items-center gap-1 border-l border-line pl-1.5">
            <IconAction label="Export board as JSON" onClick={onExport}>
              <DownloadIcon size={15} />
            </IconAction>
            <IconAction label="Import board from JSON" onClick={() => fileRef.current?.click()}>
              <UploadIcon size={15} />
            </IconAction>
            <IconAction label="Clear board" onClick={onClear} danger>
              <TrashIcon size={15} />
            </IconAction>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onImportFile(file);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      </div>
    </header>
  );
}

function IconAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-[3px] text-muted transition-colors hover:bg-fill",
        danger ? "hover:text-accent" : "hover:text-ink",
        "focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent",
      )}
    >
      {children}
    </button>
  );
}

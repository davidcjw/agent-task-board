"use client";

import { Button, Text } from "./ds";
import { InboxIcon, PlusIcon, RobotIcon } from "./icons";

interface EmptyStateProps {
  onSeed: () => void;
  onCreate: () => void;
}

export function EmptyState({ onSeed, onCreate }: EmptyStateProps) {
  return (
    <div className="grid place-items-center px-4 py-24">
      <div className="flex max-w-md flex-col items-center text-center">
        <span className="relative mb-5 grid h-16 w-16 place-items-center rounded-[8px] border border-line text-muted">
          <InboxIcon size={28} />
          <span className="absolute -bottom-2 -right-2 grid h-7 w-7 place-items-center rounded-full border border-line bg-surface text-accent">
            <RobotIcon size={14} />
          </span>
        </span>
        <Text as="h2" face="serif" size="h" tone="ink" className="text-[28px]">
          The board is clear
        </Text>
        <Text as="p" size="body" tone="muted" className="mt-3 text-[14px] leading-relaxed">
          This is mission control for the work you hand to AI agents. Queue a prompt, hand it off,
          track what&apos;s running, and review before you ship — all stored locally in your browser.
        </Text>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <Button variant="accent" onClick={onCreate}>
            <PlusIcon size={13} /> New task
          </Button>
          <Button variant="outline" onClick={onSeed}>
            Load sample board
          </Button>
        </div>
      </div>
    </div>
  );
}

import type { Status } from "@/lib/types";

// Per-lane UI tokens. Class strings are written as literals (not interpolated)
// so Tailwind's JIT picks them up. Hex values feed inline glows/box-shadows.
export interface StatusUI {
  hex: string;
  text: string;
  bgSoft: string;
  border: string;
  dot: string;
}

export const STATUS_UI: Record<Status, StatusUI> = {
  queued: {
    hex: "#8a8fa3",
    text: "text-queued",
    bgSoft: "bg-queued/10",
    border: "border-queued/40",
    dot: "bg-queued",
  },
  running: {
    hex: "#34d399",
    text: "text-running",
    bgSoft: "bg-running/10",
    border: "border-running/40",
    dot: "bg-running",
  },
  review: {
    hex: "#fbbf24",
    text: "text-review",
    bgSoft: "bg-review/10",
    border: "border-review/40",
    dot: "bg-review",
  },
  done: {
    hex: "#56a3d9",
    text: "text-done",
    bgSoft: "bg-done/10",
    border: "border-done/40",
    dot: "bg-done",
  },
};

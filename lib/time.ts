// Time formatting helpers. Pure and timezone-agnostic (operate on epoch ms deltas).

/** Format a millisecond duration as a compact HH:MM:SS / MM:SS clock. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Human-friendly duration, e.g. "2h 14m", "3m", "<1m". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return "<1m";
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHr = hours % 24;
  return remHr ? `${days}d ${remHr}h` : `${days}d`;
}

/** Relative "time ago" label for a past timestamp. */
export function formatRelative(from: number, now = Date.now()): string {
  const diff = now - from;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

const TWO_MIN = 2 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/** Pick a heat level for a running timer, so long-running tasks draw the eye. */
export function elapsedHeat(ms: number): "fresh" | "warm" | "stale" {
  if (ms < TWO_MIN) return "fresh";
  if (ms < ONE_HOUR) return "warm";
  return "stale";
}

import { describe, expect, it } from "vitest";
import { elapsedHeat, formatClock, formatDuration, formatRelative } from "./time";

describe("formatClock", () => {
  it("uses MM:SS under an hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65 * 1000)).toBe("01:05");
    expect(formatClock(9 * 1000)).toBe("00:09");
  });
  it("switches to H:MM:SS at/over an hour", () => {
    expect(formatClock(3661 * 1000)).toBe("1:01:01");
  });
  it("never goes negative", () => {
    expect(formatClock(-5000)).toBe("00:00");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute, minutes, hours and days", () => {
    expect(formatDuration(30 * 1000)).toBe("<1m");
    expect(formatDuration(5 * 60 * 1000)).toBe("5m");
    expect(formatDuration(2 * 3600 * 1000)).toBe("2h");
    expect(formatDuration((2 * 3600 + 14 * 60) * 1000)).toBe("2h 14m");
    expect(formatDuration(25 * 3600 * 1000)).toBe("1d 1h");
  });
});

describe("formatRelative", () => {
  const now = 1_000_000_000_000;
  it("labels recency buckets", () => {
    expect(formatRelative(now, now)).toBe("just now");
    expect(formatRelative(now - 5 * 60 * 1000, now)).toBe("5m ago");
    expect(formatRelative(now - 3 * 3600 * 1000, now)).toBe("3h ago");
    expect(formatRelative(now - 2 * 24 * 3600 * 1000, now)).toBe("2d ago");
  });
});

describe("elapsedHeat", () => {
  it("escalates with elapsed time", () => {
    expect(elapsedHeat(30 * 1000)).toBe("fresh");
    expect(elapsedHeat(10 * 60 * 1000)).toBe("warm");
    expect(elapsedHeat(3 * 3600 * 1000)).toBe("stale");
  });
});

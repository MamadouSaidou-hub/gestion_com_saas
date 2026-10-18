import { describe, expect, it } from "vitest";
import { resolvePeriodWindow, resolveRollingWindow, isLiveWindowEnd } from "./period";

describe("resolvePeriodWindow", () => {
  it("day: compares 'so far today' to the SAME elapsed hours yesterday", () => {
    const reference = new Date("2026-03-10T14:30:00.000Z");
    const window = resolvePeriodWindow("day", reference);
    expect(window.currentStart.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(window.currentEnd).toEqual(reference);
    expect(window.previousStart.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    // Same elapsed duration (14h30) added to previousStart.
    expect(window.previousEnd.toISOString()).toBe("2026-03-09T14:30:00.000Z");
  });

  it("week: starts on Monday (UTC), compares to the same elapsed time last week", () => {
    // 2026-03-10 is a Tuesday.
    const reference = new Date("2026-03-10T12:00:00.000Z");
    const window = resolvePeriodWindow("week", reference);
    expect(window.currentStart.toISOString()).toBe("2026-03-09T00:00:00.000Z"); // Monday
    expect(window.previousStart.toISOString()).toBe("2026-03-02T00:00:00.000Z"); // Monday, 7 days earlier
    expect(window.previousEnd.toISOString()).toBe("2026-03-03T12:00:00.000Z");
  });

  it("month: early-month reference compares to the SAME elapsed days last month, not the whole previous month", () => {
    // The 3rd of April, mid-morning -- comparing this to the ENTIRE month
    // of March would make day 3 of April look like a collapse.
    const reference = new Date("2026-04-03T10:00:00.000Z");
    const window = resolvePeriodWindow("month", reference);
    expect(window.currentStart.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(window.previousStart.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    // Elapsed = 2 days 10h -- previousEnd = March 1 + 2d10h = March 3, 10:00.
    expect(window.previousEnd.toISOString()).toBe("2026-03-03T10:00:00.000Z");
  });

  it("month: handles a reference date on the 31st rolling into a shorter previous month correctly via elapsed-ms arithmetic", () => {
    const reference = new Date("2026-05-31T00:00:00.000Z");
    const window = resolvePeriodWindow("month", reference);
    expect(window.currentStart.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(window.previousStart.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    // Elapsed = 30 days exactly -> April 1 + 30 days = May 1 (April has 30
    // days) -- this is correct elapsed-time arithmetic, not a calendar bug.
    expect(window.previousEnd.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("resolveRollingWindow", () => {
  it("returns a fixed N-day window ending at the reference date", () => {
    const reference = new Date("2026-06-15T00:00:00.000Z");
    const window = resolveRollingWindow(30, reference);
    expect(window.end).toEqual(reference);
    expect(window.start.toISOString()).toBe("2026-05-16T00:00:00.000Z");
  });
});

describe("isLiveWindowEnd (M-c)", () => {
  it("is true when the window end is effectively 'now'", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    expect(isLiveWindowEnd(now, now)).toBe(true);
    // Within the clock-skew tolerance.
    expect(isLiveWindowEnd(new Date(now.getTime() - 1000), now)).toBe(true);
  });

  it("is false for a window ending in the past (e.g. a 'voir hier' date picker)", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const yesterday = new Date("2026-06-14T12:00:00.000Z");
    expect(isLiveWindowEnd(yesterday, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Period window resolution -- pure, DB-free, unit-testable.
//
// Timezone assumption (documented per the coordinator's explicit
// instruction): both Senegal and Guinea are UTC+0, so "the accounting
// day" IS the UTC day. Every boundary here is computed in UTC with no
// local-timezone conversion. If this product ever serves a market in a
// different UTC offset, this file is the one place that needs to change.
//
// "Comparison to the SAME POINT in the previous period" (not the whole
// previous period) -- the comparison window always has the SAME ELAPSED
// DURATION as how far into the current period `referenceDate` is, so
// comparing day 3 of this month to the FULL previous month would make
// every early-month figure look like a collapse. This generalizes
// uniformly across day/week/month.
// ---------------------------------------------------------------------------

export type PeriodGranularity = "day" | "week" | "month";

export interface PeriodWindow {
  currentStart: Date;
  currentEnd: Date; // = referenceDate -- "so far this period", not the full period
  previousStart: Date;
  previousEnd: Date; // previousStart + (currentEnd - currentStart) -- same elapsed duration
}

function startOfUTCDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfUTCWeek(d: Date): Date {
  // ISO-style week starting Monday.
  const day = startOfUTCDay(d);
  const weekday = day.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (weekday + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day;
}

function startOfUTCMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addUTCMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

export function resolvePeriodWindow(
  granularity: PeriodGranularity,
  referenceDate: Date = new Date()
): PeriodWindow {
  let currentStart: Date;
  let previousStart: Date;

  switch (granularity) {
    case "day":
      currentStart = startOfUTCDay(referenceDate);
      previousStart = new Date(currentStart.getTime() - 24 * 60 * 60 * 1000);
      break;
    case "week":
      currentStart = startOfUTCWeek(referenceDate);
      previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "month":
      currentStart = startOfUTCMonth(referenceDate);
      previousStart = startOfUTCMonth(addUTCMonths(currentStart, -1));
      break;
  }

  const elapsedMs = referenceDate.getTime() - currentStart.getTime();
  const previousEnd = new Date(previousStart.getTime() + elapsedMs);

  return { currentStart, currentEnd: referenceDate, previousStart, previousEnd };
}

// A fixed, wider window for "rolling 30 days" (top products) -- independent
// of the day/week/month granularity picker.
export function resolveRollingWindow(days: number, referenceDate: Date = new Date()): { start: Date; end: Date } {
  const end = referenceDate;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
}

// M-c fix (security-reviewer follow-up): the "drop the upper bound for
// encaissé" fix (H5) is only correct when the window's `end` genuinely
// means "now" (today, `referenceDate` defaulting to `new Date()`, never
// client-supplied). The day a "voir hier" date picker lets a caller pass
// an arbitrary `referenceDate` in the past, a window ending yesterday
// must NOT have its upper bound dropped -- that would let yesterday's
// encaissé silently include every payment up to the CURRENT moment,
// while CA brut/net for that same yesterday stay correctly bounded
// (inconsistent money shown to the shopkeeper). This checks that `end`
// is within a small clock-skew tolerance of "now" before treating it as
// the live/open window.
const LIVE_WINDOW_SKEW_MS = 5_000;

export function isLiveWindowEnd(end: Date, now: Date = new Date()): boolean {
  return now.getTime() - end.getTime() < LIVE_WINDOW_SKEW_MS;
}

// ---------------------------------------------------------------------------
// Monthly period resolution for the customer-side rebate -- pure, DB-free.
// The month is DERIVED from `now()` every time this is called, NEVER
// stored as a counter (the brief's explicit instruction): the period
// resets automatically simply because `resolveCurrentUtcMonth(new Date())`
// returns a different window once the UTC month rolls over, with zero
// state to migrate/reset anywhere.
//
// Timezone assumption (mirrors analytics/domain/period.ts, duplicated here
// rather than imported -- cross-module boundary rule only allows reaching
// another module through its own public index.ts, and analytics does not
// export this helper; both Senegal and Guinea sit at UTC+0 so "the month"
// IS the UTC month, no local-timezone conversion anywhere).
// ---------------------------------------------------------------------------

export interface MonthlyPeriod {
  label: string; // "YYYY-MM", stored on rebate_grants.period_label
  start: Date; // inclusive
  end: Date; // EXCLUSIVE (first instant of the next month)
}

export function resolveCurrentUtcMonth(now: Date = new Date()): MonthlyPeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const label = `${year}-${String(month + 1).padStart(2, "0")}`;
  return { label, start, end };
}

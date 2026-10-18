// Gross margin -- computed from the CUMP `unit_cost_minor` snapshot
// captured on each sale_line at confirmation time (not today's current
// average cost, which may have drifted since).
//
// Correction (coordinator feedback): revenue here is NET-of-VAT (HT), not
// TTC -- collected VAT is remitted to the state, it is not revenue, so
// comparing COGS against TTC revenue overstates margin for a
// VAT-registered shop. `analytics-repository.ts`'s `getMarginTotals`
// reconstructs each line's HT amount from its own `vat_rate` snapshot
// before summing. When `tax_settings.vat_rate = 0` (most small shops
// aren't VAT-registered, D4), HT and TTC are identical, so nothing
// changes for them.
export interface MarginResult {
  revenueMinor: bigint;
  costMinor: bigint;
  marginMinor: bigint;
  // A derived display ratio -- float is acceptable here (never for a
  // stored/ledger amount, only for a UI percentage), null when there is no
  // revenue to divide by.
  marginPct: number | null;
}

export function computeMargin(revenueMinor: bigint, costMinor: bigint): MarginResult {
  const marginMinor = revenueMinor - costMinor;
  const marginPct = revenueMinor === 0n ? null : (Number(marginMinor) / Number(revenueMinor)) * 100;
  return { revenueMinor, costMinor, marginMinor, marginPct };
}

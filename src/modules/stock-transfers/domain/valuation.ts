import { Quantity } from "@/modules/inventory";

// ---------------------------------------------------------------------------
// Pure money arithmetic for a stock-count variance line -- no DB, no side
// effects. Mirrors sales/domain/pricing.ts's discipline (bigint only, round
// half up, SCALE=10_000 matching Quantity's internal fixed point).
// ---------------------------------------------------------------------------
const SCALE = 10_000n;

// Signed valuation of a variance: positive variance (stock found) yields a
// positive value, negative variance (stock missing) yields a negative
// value -- both at the CURRENT average cost (never changed by a count, see
// apply-stock-count-adjustment.ts). This is informational (shown on the
// "Écarts récents" screen and the audit payload), it never feeds back into
// stock_levels.avg_cost_minor.
export function computeVarianceValueMinor(varianceQty: Quantity, unitCostMinor: bigint): bigint {
  const scaled = varianceQty.toScaled();
  const sign = scaled < 0n ? -1n : 1n;
  const magnitude = scaled < 0n ? -scaled : scaled;
  // Round half up on the magnitude, then reapply the sign.
  return sign * ((magnitude * unitCostMinor + SCALE / 2n) / SCALE);
}

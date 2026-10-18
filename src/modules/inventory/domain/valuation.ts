import { Quantity } from "./quantity";

// ---------------------------------------------------------------------------
// CUMP (weighted-average cost) valuation projection (D9).
//
// Pure function: no DB, no side effects, unit-testable in complete
// isolation from Postgres. A stock-OUT movement NEVER calls this -- it only
// ever changes `stock_levels.quantity`, never `avg_cost_minor`. The moving
// average is defined entirely by stock-IN movements (receipts); this is the
// one function in the codebase that is allowed to change it.
//
// All arithmetic is BigInt: `Quantity`'s internal fixed-point scaled
// representation for quantities, bigint minor-unit for money -- never a
// floating-point division anywhere in this function.
// ---------------------------------------------------------------------------

export function computeCumpOnReceipt(
  currentQty: Quantity,
  currentAvgCostMinor: bigint,
  inQty: Quantity,
  inUnitCostMinor: bigint
): bigint {
  if (inQty.isNegative() || inQty.isZero()) {
    // A receipt with zero/negative quantity doesn't change the average;
    // callers are expected to reject this earlier (receiveStock validates
    // quantity > 0), but this stays a safe no-op rather than divide by a
    // bad denominator if it is ever reached some other way.
    return currentAvgCostMinor;
  }

  const currentScaled = currentQty.toScaled();
  const inScaled = inQty.toScaled();
  const totalScaled = currentScaled + inScaled;

  if (totalScaled <= 0n) {
    // No existing stock (or a negative current level, which should never
    // happen but is handled defensively): the new average IS the incoming
    // unit cost.
    return inUnitCostMinor;
  }

  // newAvgCost = (currentQty * currentAvgCost + inQty * inUnitCost) / (currentQty + inQty)
  // The 10_000 scale factor on both quantity terms cancels out between
  // numerator and denominator, so this is exact integer arithmetic on the
  // scaled values without ever introducing it as a separate division step.
  const numerator = currentScaled * currentAvgCostMinor + inScaled * inUnitCostMinor;
  // Round half up -- numerator and totalScaled are both bigint, and both
  // are guaranteed positive by the guards above.
  return (numerator + totalScaled / 2n) / totalScaled;
}

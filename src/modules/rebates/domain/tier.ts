import type { Quantity } from "@/modules/inventory";

// ---------------------------------------------------------------------------
// Pure cliff-mode tier selection -- no drizzle, no Next imports.
//
// Cliff mode: reaching a tier rebates ALL units counted in the period/cycle,
// never just the units above the threshold. The tier GRANTED is the
// HIGHEST tier reached (not every tier reached) -- e.g. tiers at 50/100/200
// units, 120 counted -> only the 100-unit tier applies, covering all 120
// units at that tier's per-unit rebate.
// ---------------------------------------------------------------------------

export interface TierCandidate {
  id: string;
  thresholdQty: Quantity;
  rebatePerUnitMinor: bigint;
}

export function pickHighestTierReached<T extends TierCandidate>(
  tiers: T[],
  countedQty: Quantity
): T | null {
  let best: T | null = null;
  for (const tier of tiers) {
    if (countedQty.lessThan(tier.thresholdQty)) {
      continue; // not reached
    }
    if (!best || best.thresholdQty.lessThan(tier.thresholdQty)) {
      best = tier;
    }
  }
  return best;
}

// Smallest threshold NOT yet reached, strictly above countedQty -- used by
// the "next tier in X units" progress display. `null` means every tier is
// already reached (or there are no tiers at all).
export function pickNextTier<T extends TierCandidate>(tiers: T[], countedQty: Quantity): T | null {
  let best: T | null = null;
  for (const tier of tiers) {
    if (!countedQty.lessThan(tier.thresholdQty)) {
      continue; // already reached or equal -- not "next"
    }
    if (!best || tier.thresholdQty.lessThan(best.thresholdQty)) {
      best = tier;
    }
  }
  return best;
}

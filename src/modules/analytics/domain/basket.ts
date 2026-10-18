// Average basket -- computed in the domain, not SQL (division by zero is
// the obvious trap: zero sales in a window must yield a defined, safe
// result, not a SQL error or a NaN leaking into a DTO). Integer minor-unit
// floor division -- a display figure, not a ledger entry, so rounding
// down by at most a few minor units is an accepted, documented
// simplification.
export function computeAverageBasketMinor(totalMinor: bigint, saleCount: number): bigint {
  if (saleCount <= 0) {
    return 0n;
  }
  return totalMinor / BigInt(saleCount);
}

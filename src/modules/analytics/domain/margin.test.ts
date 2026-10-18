import { describe, expect, it } from "vitest";
import { computeMargin } from "./margin";

describe("computeMargin", () => {
  it("computes margin and percentage for normal revenue/cost", () => {
    const result = computeMargin(10_000n, 6_000n);
    expect(result.marginMinor).toBe(4_000n);
    expect(result.marginPct).toBe(40);
  });

  it("returns a null percentage (not NaN/Infinity) when revenue is zero", () => {
    const result = computeMargin(0n, 0n);
    expect(result.marginMinor).toBe(0n);
    expect(result.marginPct).toBeNull();
  });
});

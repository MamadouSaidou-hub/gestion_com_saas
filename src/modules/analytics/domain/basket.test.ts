import { describe, expect, it } from "vitest";
import { computeAverageBasketMinor } from "./basket";

describe("computeAverageBasketMinor", () => {
  it("divides total by sale count", () => {
    expect(computeAverageBasketMinor(10_000n, 4)).toBe(2500n);
  });

  it("is a safe zero for zero sales -- never divides by zero", () => {
    expect(computeAverageBasketMinor(0n, 0)).toBe(0n);
    expect(computeAverageBasketMinor(500n, 0)).toBe(0n);
  });
});

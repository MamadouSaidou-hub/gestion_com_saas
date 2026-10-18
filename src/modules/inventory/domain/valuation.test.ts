import { describe, expect, it } from "vitest";
import { Quantity } from "./quantity";
import { computeCumpOnReceipt } from "./valuation";

describe("computeCumpOnReceipt (CUMP / weighted-average cost)", () => {
  it("sets the average to the incoming cost when there is no existing stock", () => {
    const result = computeCumpOnReceipt(
      Quantity.zero(),
      0n,
      Quantity.fromString("10.0000"),
      1000n
    );
    expect(result).toBe(1000n);
  });

  it("computes the textbook weighted average for a simple receipt", () => {
    // 10 units @ 1000 + 10 units @ 2000 => average 1500
    const result = computeCumpOnReceipt(
      Quantity.fromString("10.0000"),
      1000n,
      Quantity.fromString("10.0000"),
      2000n
    );
    expect(result).toBe(1500n);
  });

  it("weights unevenly-sized lots correctly, not a naive average of unit costs", () => {
    // 1 unit @ 100 + 99 units @ 200 => (100 + 19800) / 100 = 199, NOT (100+200)/2=150
    const result = computeCumpOnReceipt(
      Quantity.fromString("1.0000"),
      100n,
      Quantity.fromString("99.0000"),
      200n
    );
    expect(result).toBe(199n);
  });

  it("rounds half up when the exact average is not an integer minor unit", () => {
    // 1 unit @ 100 + 1 unit @ 101 => average 100.5 -> rounds to 101 (half up)
    const result = computeCumpOnReceipt(
      Quantity.fromString("1.0000"),
      100n,
      Quantity.fromString("1.0000"),
      101n
    );
    expect(result).toBe(101n);
  });

  it("is a no-op for a zero or negative incoming quantity (defensive guard)", () => {
    expect(
      computeCumpOnReceipt(Quantity.fromString("5.0000"), 1000n, Quantity.zero(), 9999n)
    ).toBe(1000n);
  });

  it("handles fractional quantities (numeric(18,4)) without floating-point drift", () => {
    // 2.5 units @ 1000 + 2.5 units @ 1000 => average stays 1000 regardless
    // of fractional weighting.
    const result = computeCumpOnReceipt(
      Quantity.fromString("2.5000"),
      1000n,
      Quantity.fromString("2.5000"),
      1000n
    );
    expect(result).toBe(1000n);
  });
});

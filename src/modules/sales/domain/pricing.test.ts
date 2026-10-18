import { describe, expect, it } from "vitest";
import { Quantity } from "@/modules/inventory";
import { computeLineAmounts, sumLineAmounts, vatRateToScaledPercent } from "./pricing";

describe("vatRateToScaledPercent", () => {
  it("parses a numeric(5,2) VAT rate string without floats", () => {
    expect(vatRateToScaledPercent("18.00")).toBe(1800n);
    expect(vatRateToScaledPercent("0")).toBe(0n);
    expect(vatRateToScaledPercent("7.5")).toBe(750n);
  });
});

describe("computeLineAmounts", () => {
  it("computes gross/net/vat/total for a simple line with no discount", () => {
    // 3 units @ 1000 minor units, 18% VAT, no discount
    const amounts = computeLineAmounts(Quantity.fromInt(3), 1000n, 0n, "18.00");
    expect(amounts.grossMinor).toBe(3000n);
    expect(amounts.discountMinor).toBe(0n);
    expect(amounts.netMinor).toBe(3000n);
    expect(amounts.vatMinor).toBe(540n); // 3000 * 0.18
    expect(amounts.lineTotalMinor).toBe(3540n);
  });

  it("applies a discount before computing VAT", () => {
    const amounts = computeLineAmounts(Quantity.fromInt(2), 1000n, 200n, "0");
    expect(amounts.grossMinor).toBe(2000n);
    expect(amounts.netMinor).toBe(1800n);
    expect(amounts.vatMinor).toBe(0n);
    expect(amounts.lineTotalMinor).toBe(1800n);
  });

  it("handles fractional quantities without floating-point drift", () => {
    const amounts = computeLineAmounts(Quantity.fromString("2.5000"), 1000n, 0n, "0");
    expect(amounts.grossMinor).toBe(2500n);
  });

  it("rejects a discount larger than the line's gross amount", () => {
    expect(() => computeLineAmounts(Quantity.fromInt(1), 1000n, 1500n, "0")).toThrow();
  });
});

describe("sumLineAmounts", () => {
  it("sums subtotal/discount/vat/total across lines", () => {
    const line1 = computeLineAmounts(Quantity.fromInt(2), 1000n, 0n, "18.00");
    const line2 = computeLineAmounts(Quantity.fromInt(1), 500n, 50n, "18.00");
    const totals = sumLineAmounts([line1, line2]);
    expect(totals.subtotalMinor).toBe(2500n); // 2000 + 500
    expect(totals.discountMinor).toBe(50n);
    expect(totals.vatMinor).toBe(line1.vatMinor + line2.vatMinor);
    expect(totals.totalMinor).toBe(totals.subtotalMinor - totals.discountMinor + totals.vatMinor);
  });
});

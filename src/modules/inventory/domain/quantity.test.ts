import { describe, expect, it } from "vitest";
import { Quantity, InvalidQuantityError } from "./quantity";

describe("Quantity value object", () => {
  it("round-trips a numeric(18,4) driver string exactly", () => {
    expect(Quantity.fromString("12.5000").toDbString()).toBe("12.5000");
    expect(Quantity.fromString("0").toDbString()).toBe("0.0000");
    expect(Quantity.fromString("-3.2").toDbString()).toBe("-3.2000");
  });

  it("adds and subtracts without floating-point drift", () => {
    // 0.1 + 0.2 famously != 0.3 in IEEE754 float -- this must be exact.
    const a = Quantity.fromString("0.1000");
    const b = Quantity.fromString("0.2000");
    expect(a.add(b).toDbString()).toBe("0.3000");
  });

  it("supports many small additions without accumulating error", () => {
    let total = Quantity.zero();
    const increment = Quantity.fromString("0.0001");
    for (let i = 0; i < 10_000; i++) {
      total = total.add(increment);
    }
    expect(total.toDbString()).toBe("1.0000");
  });

  it("compares quantities correctly", () => {
    const low = Quantity.fromString("2.0000");
    const high = Quantity.fromString("5.0000");
    expect(low.lessThan(high)).toBe(true);
    expect(high.greaterThanOrEqual(low)).toBe(true);
    expect(low.equals(Quantity.fromString("2.0000"))).toBe(true);
  });

  it("builds from a whole-unit int count", () => {
    expect(Quantity.fromInt(3).toDbString()).toBe("3.0000");
  });

  it("rejects a non-numeric string instead of silently coercing it", () => {
    expect(() => Quantity.fromString("abc")).toThrow(InvalidQuantityError);
    expect(() => Quantity.fromString("1.23456")).toThrow(InvalidQuantityError); // too many decimals
  });

  it("isZero/isNegative/isPositive reflect sign correctly", () => {
    expect(Quantity.zero().isZero()).toBe(true);
    expect(Quantity.fromString("-1.0000").isNegative()).toBe(true);
    expect(Quantity.fromString("1.0000").isPositive()).toBe(true);
  });
});

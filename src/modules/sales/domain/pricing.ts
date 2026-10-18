import { Quantity } from "@/modules/inventory";

// ---------------------------------------------------------------------------
// Pure money arithmetic for a sale line -- no DB, no side effects,
// unit-testable in isolation. All bigint, never a floating-point division,
// mirroring `inventory/domain/valuation.ts`'s discipline.
//
// `Quantity` is imported from `@/modules/inventory` (inventory's PUBLIC
// surface), not `@/modules/inventory/domain/quantity` directly -- the
// cross-module ESLint boundary rule forbids the latter from sales.
// ---------------------------------------------------------------------------

const VAT_RATE_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

// Parses a numeric(5,2) VAT rate PERCENTAGE string (e.g. "18.00" meaning
// 18.00%, "0", "7.5") into an integer "percent * 100" representation (e.g.
// "18.00" -> 1800, "7.5" -> 750). Avoids parseFloat entirely -- this is
// still money-adjacent arithmetic. To turn this into a fraction of an
// amount, divide by 10_000 (since percent/100 = fraction, and this value
// IS percent*100).
export function vatRateToScaledPercent(vatRate: string): bigint {
  const match = VAT_RATE_PATTERN.exec(vatRate.trim());
  if (!match) {
    throw new Error(`"${vatRate}" is not a valid VAT rate string.`);
  }
  const [, intPart, fracPartRaw] = match;
  const fracPart = (fracPartRaw ?? "").padEnd(2, "0").slice(0, 2);
  return BigInt(intPart) * 100n + BigInt(fracPart === "" ? "0" : fracPart);
}

export interface LineAmounts {
  grossMinor: bigint; // unitPriceMinor * quantity, before discount/VAT
  discountMinor: bigint;
  netMinor: bigint; // gross - discount
  vatMinor: bigint; // VAT on the net amount
  lineTotalMinor: bigint; // net + VAT
}

export function computeLineAmounts(
  quantity: Quantity,
  unitPriceMinor: bigint,
  discountMinor: bigint,
  vatRate: string
): LineAmounts {
  if (discountMinor < 0n) {
    throw new Error("Line discount cannot be negative.");
  }
  const SCALE = 10_000n; // matches Quantity's internal scale
  const quantityScaled = quantity.toScaled();
  // Round half up.
  const grossMinor = (quantityScaled * unitPriceMinor + SCALE / 2n) / SCALE;

  if (discountMinor > grossMinor) {
    throw new Error("Line discount cannot exceed the line's gross amount.");
  }
  const netMinor = grossMinor - discountMinor;

  const scaledPercent = vatRateToScaledPercent(vatRate); // percent * 100
  const PERCENT_SCALE = 10_000n; // netMinor * (percent*100) / 10_000 = netMinor * percent / 100
  const vatMinor = (netMinor * scaledPercent + PERCENT_SCALE / 2n) / PERCENT_SCALE;

  return {
    grossMinor,
    discountMinor,
    netMinor,
    vatMinor,
    lineTotalMinor: netMinor + vatMinor,
  };
}

export interface SaleTotals {
  subtotalMinor: bigint; // sum of gross amounts, before discount/VAT
  discountMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint; // subtotal - discount + vat
}

export function sumLineAmounts(lines: LineAmounts[]): SaleTotals {
  let subtotalMinor = 0n;
  let discountMinor = 0n;
  let vatMinor = 0n;
  for (const line of lines) {
    subtotalMinor += line.grossMinor;
    discountMinor += line.discountMinor;
    vatMinor += line.vatMinor;
  }
  return {
    subtotalMinor,
    discountMinor,
    vatMinor,
    totalMinor: subtotalMinor - discountMinor + vatMinor,
  };
}

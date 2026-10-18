// Pure domain errors for the inventory module -- no drizzle, no Next imports.

export interface StockShortage {
  productId: string;
  warehouseId: string;
  available: string; // Quantity#toDbString(), never a bigint/number here
  requested: string;
}

// Thrown by applyStockOut (and, in a later step, confirmSale) when one or
// more lines would take a product's stock level below zero and the caller
// did not request (or is not allowed) an oversell override. Lists every
// offending product so the caller can show a precise error, not just
// "insufficient stock" with no detail.
export class InsufficientStockError extends Error {
  constructor(public readonly shortages: StockShortage[]) {
    super(
      `Insufficient stock for ${shortages.length} product(s): ` +
        shortages.map((s) => `${s.productId} (available ${s.available}, requested ${s.requested})`).join(", ")
    );
    this.name = "InsufficientStockError";
  }
}

export class InvalidStockAdjustmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStockAdjustmentError";
  }
}

import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import type { StockRepository } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export interface StockCountVarianceLine {
  productId: string;
  // Signed numeric(18,4) string: positive = counted MORE than theoretical
  // (an "in" movement, stock found), negative = counted LESS (an "out"
  // movement, a loss at average cost). Callers must never pass "0" --
  // filter zero-variance lines out before calling this (ledger entries only
  // exist for a REAL variance, per the approved product decision).
  varianceQty: string;
}

export interface ApplyStockCountAdjustmentInput {
  warehouseId: string;
  stockCountId: string;
  currencyCode: string;
  lines: StockCountVarianceLine[];
}

export interface StockCountAdjustmentResult {
  movements: StockMovementDto[];
  // The CUMP snapshot used for each line's movement (current avg cost at
  // validation time) -- the caller persists this onto
  // stock_count_lines.unit_cost_minor / variance_value_minor for the
  // "Écarts récents" screen and the audit payload.
  unitCostMinorByProductId: Record<string, string>;
}

// ---------------------------------------------------------------------------
// applyStockCountAdjustment -- posts ONE ledger movement per non-zero
// variance line, exactly like `adjustStock`, but tagged with
// `stockCountId` instead of a free-text manual reason, and able to batch
// every line of a count validation into the SAME transaction (the caller,
// `validateStockCount`, opens that transaction).
//
// Never updates `stock_levels.quantity` directly by any other path --
// `upsertLevel` below is reached ONLY through a movement insert first, same
// discipline as every other inventory use case (D9: stock_levels is a
// derived projection, stock_movements is the source of truth).
//
// A positive variance (stock found) does NOT change the average cost --
// same reasoning as a manual "in" adjustment: this is a correction, not a
// purchase, so there is no new price to blend in. A negative variance
// (stock missing) is a loss valued AT THE CURRENT AVERAGE COST, same as
// `adjustStock`'s "out" direction.
// ---------------------------------------------------------------------------
export async function applyStockCountAdjustment(
  ctx: TenantSessionContext,
  input: ApplyStockCountAdjustmentInput,
  repo: StockRepository
): Promise<StockCountAdjustmentResult> {
  const sortedProductIds = [...input.lines.map((l) => l.productId)].sort();
  const locked = await repo.lockLevelsForUpdate(ctx, input.warehouseId, sortedProductIds);
  const byProductId = new Map(locked.map((level) => [level.productId, level]));

  const movements: StockMovementDto[] = [];
  const unitCostMinorByProductId: Record<string, string> = {};

  for (const line of input.lines) {
    const signedVariance = Quantity.fromString(line.varianceQty);
    if (signedVariance.isZero()) {
      continue; // defensive -- the caller is expected to have filtered these out already
    }
    const direction: "in" | "out" = signedVariance.isNegative() ? "out" : "in";
    const magnitude = signedVariance.isNegative() ? signedVariance.negate() : signedVariance;

    const current = byProductId.get(line.productId);
    const currentQty = current?.quantity ?? Quantity.zero();
    const currentAvgCost = current?.avgCostMinor ?? 0n;
    const newQty = direction === "in" ? currentQty.add(magnitude) : currentQty.subtract(magnitude);

    const movement = await repo.insertMovement(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      direction,
      quantity: magnitude,
      unitCostMinor: currentAvgCost, // snapshot only, never changes the average (same as adjustStock)
      currencyCode: input.currencyCode,
      reason: "count_adjustment",
      stockCountId: input.stockCountId,
    });

    await repo.upsertLevel(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      quantity: newQty,
      avgCostMinor: currentAvgCost,
      currencyCode: input.currencyCode,
    });

    movements.push(toMovementDto(movement));
    unitCostMinorByProductId[line.productId] = currentAvgCost.toString();
  }

  return { movements, unitCostMinorByProductId };
}
